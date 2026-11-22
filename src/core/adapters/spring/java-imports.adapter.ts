import type { Node } from "web-tree-sitter";
import type { ModuleBinding, ModuleDependencies, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import type { ModuleTarget } from "../../domain/shared/module-target.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { javaDeclarationIndex } from "./java-declaration-index.ts";
import { questions } from "./java-declaration-questions.ts";
import { readSource, withJavaSources } from "./java-project.ts";
import { createJavaProject, namedChildren, type JavaFile, type JavaProject } from "./java-symbols.ts";

/** The slot of the import declarations one Java source writes: syntax, kept by the source's content alone. */
const STATEMENTS_SLOT = "java-import-statements";
/** The slot of what each import declaration of one Java source resolves to, kept by the questions its resolution asked of the declaration index (ADR-0122). */
const TARGETS_SLOT = "java-import-targets";

/** The imports of every readable Java source of one list, in list order, and the sources that could not be read. */
interface JavaUniverse {
  read: readonly { file: string; dependencies: readonly ModuleDependency[] }[];
  unread: ModuleDependencies["unread"];
}

/** One import declaration as the source writes it: plain data, with no node. */
interface ImportStatement {
  name: string;
  wildcard: boolean;
  member: boolean;
  /** The last segment of the name, and where it starts. */
  last: string;
  lastAt: Place;
  at: Place;
  endLine: number;
}

interface Place {
  line: number;
  column: number;
}

/** What an import declaration resolves to: its target and, for a type a source declares, the type's qualified name. */
interface ResolvedImport {
  target: ModuleTarget;
  declared?: string;
}

/**
 * The import declarations of every Java source, or of the selected ones, each resolved by the types the snapshot's Java
 * sources declare: a type one source declares leads to its file, a name under a platform package is external, anything
 * else is unresolved with its reason. Nothing comes from the graph. With `facts`, the declarations of a source are kept
 * by its content and what they resolve to by the questions the resolution asked of the declaration index, so a read
 * parses only the sources whose content changed and the ones an answer a resolution rested on moved for (ADR-0122).
 * Without, a source list is parsed once for the life of the list, however many selections read it.
 */
export function createJavaImportsReader(parser: JavaParser): ModuleDependenciesReader {
  const universes = new WeakMap<readonly SourceFile[], JavaUniverse>();
  return {
    async extract(sources, options): Promise<ModuleDependencies> {
      const selected = options?.files === undefined ? undefined : new Set(options.files);
      if (selected !== undefined && !sources.some(({ path }) => selected.has(path))) return { files: [], dependencies: [], unread: [] };
      if (options?.facts !== undefined) return readKept(parser, options.facts, sources, selected);
      let universe = universes.get(sources);
      if (universe === undefined) {
        universe = readUniverse(parser, sources);
        universes.set(sources, universe);
      }
      const chosen = selected === undefined ? universe.read : universe.read.filter(({ file }) => selected.has(file));
      return answered(chosen, universe.unread);
    },
  };
}

function answered(chosen: JavaUniverse["read"], unread: JavaUniverse["unread"]): ModuleDependencies {
  return { files: chosen.map(({ file }) => ({ file, statements: [], moduleOnly: false })), dependencies: chosen.flatMap(({ dependencies }) => dependencies), unread };
}

function readUniverse(parser: JavaParser, sources: readonly SourceFile[]): JavaUniverse {
  return withJavaSources(parser, (parse) => {
    const { files, unparsed } = parse(sources);
    const project = createJavaProject(files);
    const unreadable = new Set(project.unreadable);
    const unread = [...unparsed, ...project.unreadable].map(({ path }) => ({ file: path, reason: "source-unreadable" as const }));
    return { read: files.filter((file) => !unreadable.has(file)).map((file) => ({ file: file.path, dependencies: statementsOf(file).map((statement) => dependencyOf(file.path, statement, resolved(statement, file, project))) })), unread };
  });
}

/**
 * The same reading, kept per file: the declaration index says which sources are read and answers what a resolution asks
 * of the other sources, and the project over every source is built only when a resolution has to be derived.
 */
async function readKept(parser: JavaParser, facts: DerivedFacts, sources: readonly SourceFile[], selected: ReadonlySet<string> | undefined): Promise<ModuleDependencies> {
  const index = javaDeclarationIndex(facts, parser, sources, { generatesInterfaces: false, unreadJvm: false });
  const notRead = index.unread();
  const unparsed = notRead.filter(({ state }) => state.state !== "unreadable");
  const unread = [...unparsed, ...notRead.filter(({ state }) => state.state === "unreadable")].map(({ path }) => ({ file: path, reason: "source-unreadable" as const }));
  const skipped = new Set(notRead.map(({ path }) => path));
  const universe = projectOnce(parser, sources);
  try {
    const read: JavaUniverse["read"][number][] = [];
    for (const source of sources) {
      if (skipped.has(source.path) || (selected !== undefined && !selected.has(source.path))) continue;
      const statements = facts.ofFile(STATEMENTS_SLOT, source, () => statementsOfSource(parser, source));
      const targets = statements.length === 0 ? [] : await facts.ofReads(TARGETS_SLOT, { path: source.path, content: index.answer(questions.file(source.path)) }, index, async (record) => {
        const { project, files } = universe.open();
        const file = files.get(source.path);
        const asked = (question: string): string => {
          const answer = index.answer(question);
          record(question, answer);
          return answer;
        };
        return project.reading((question) => void asked(question), () => statements.map((statement) => resolved(statement, file!, project)));
      });
      read.push({ file: source.path, dependencies: statements.map((statement, at) => dependencyOf(source.path, statement, targets[at]!)) });
    }
    return answered(read, unread);
  } finally {
    universe.close();
  }
}

/** The project over every source of a list, parsed when first asked and freed by `close`, so a read that derives nothing parses nothing. */
function projectOnce(parser: JavaParser, sources: readonly SourceFile[]): { open(): { project: JavaProject; files: ReadonlyMap<string, JavaFile> }; close(): void } {
  const trees: JavaSyntaxTree[] = [];
  let opened: { project: JavaProject; files: ReadonlyMap<string, JavaFile> } | undefined;
  return {
    open() {
      if (opened === undefined) {
        const files: JavaFile[] = [];
        for (const source of sources) {
          const read = readSource(parser, source, trees);
          if ("file" in read) files.push(read.file);
        }
        opened = { project: createJavaProject(files), files: new Map(files.map((file) => [file.path, file])) };
      }
      return opened;
    },
    close() {
      for (const tree of trees) tree.dispose();
    },
  };
}

/** The import declarations of one source that reads in full. */
function statementsOfSource(parser: JavaParser, source: SourceFile): ImportStatement[] {
  return withJavaSources(parser, (parse) => parse([source]).files.flatMap(statementsOf));
}

function statementsOf(file: JavaFile): ImportStatement[] {
  return namedChildren(file.root).filter((node) => node.type === "import_declaration").flatMap((node): ImportStatement[] => {
    const name = node.namedChildren.find((part) => part?.type.endsWith("identifier"));
    if (name === undefined || name === null) return [];
    const wildcard = node.namedChildren.some((part) => part?.type === "asterisk");
    const member = !wildcard && node.children.some((part) => part?.type === "static");
    const last = name.type === "scoped_identifier" ? name.childForFieldName("name") ?? name : name;
    return [{ name: name.text, wildcard, member, last: last.text, lastAt: position(last), at: position(node), endLine: node.endPosition.row + 1 }];
  });
}

function dependencyOf(path: string, statement: ImportStatement, { target, declared }: ResolvedImport): ModuleDependency {
  const { name, wildcard, member, last, lastAt, at, endLine } = statement;
  const binding: ModuleBinding = wildcard
    ? { imported: "*", ...at, typeOnly: false }
    : { local: last, imported: last, ...lastAt, typeOnly: false, ...(declared === undefined ? {} : { exportedAs: member ? `${declared}.${last}` : declared }) };
  return { file: path, line: at.line, endLine, specifier: wildcard ? `${name}.*` : name, kind: "import", typeOnly: false, target, bindings: [binding] };
}

function resolved({ name, wildcard, member }: ImportStatement, file: JavaFile, project: JavaProject): ResolvedImport {
  return resolvedContainer(member ? name.slice(0, name.lastIndexOf(".")) : name, wildcard, file, project);
}

function resolvedContainer(name: string, wildcard: boolean, file: JavaFile, project: JavaProject): ResolvedImport {
  const type = project.lookupType(name, { file, type: undefined });
  if (type === "ambiguous") return { target: { kind: "unresolved", reason: `${name} is declared by several files` } };
  if (type !== undefined) return { target: { kind: "repository", file: type.file.path }, declared: type.fqn };
  if (wildcard && project.declaresTypesIn(name)) return { target: { kind: "unresolved", reason: `${name} is a package of the repository, not one file` } };
  if (project.isPlatformName(name)) return { target: { kind: "external", module: wildcard ? name : name.slice(0, name.lastIndexOf(".")) } };
  return { target: { kind: "unresolved", reason: `no source of the snapshot declares ${name}` } };
}

function position(node: Node): Place {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}
