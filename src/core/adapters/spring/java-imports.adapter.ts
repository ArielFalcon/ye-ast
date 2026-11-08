import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { ModuleBinding, ModuleDependencies, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import type { ModuleTarget } from "../../domain/shared/module-target.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { withJavaSources } from "./java-project.ts";
import { createJavaProject, namedChildren, type JavaFile, type JavaProject } from "./java-symbols.ts";

/** The imports of every readable Java source of one list, in list order, and the sources that could not be read. */
interface JavaUniverse {
  read: readonly { file: string; dependencies: readonly ModuleDependency[] }[];
  unread: ModuleDependencies["unread"];
}

/**
 * The import declarations of every Java source, or of the selected ones, each resolved by the types the snapshot's Java
 * sources declare: a type one source declares leads to its file, a name under a platform package is external, anything
 * else is unresolved with its reason. Nothing comes from the graph. A source list is parsed once for the life of the
 * list, however many selections read it.
 */
export function createJavaImportsReader(parser: JavaParser): ModuleDependenciesReader {
  const universes = new WeakMap<readonly SourceFile[], JavaUniverse>();
  return {
    async extract(sources, options): Promise<ModuleDependencies> {
      const selected = options?.files === undefined ? undefined : new Set(options.files);
      if (selected !== undefined && !sources.some(({ path }) => isJavaSource(path) && selected.has(path))) return { files: [], dependencies: [], unread: [] };
      let universe = universes.get(sources);
      if (universe === undefined) {
        universe = readUniverse(parser, sources);
        universes.set(sources, universe);
      }
      const chosen = selected === undefined ? universe.read : universe.read.filter(({ file }) => selected.has(file));
      return { files: chosen.map(({ file }) => ({ file, statements: [], moduleOnly: false })), dependencies: chosen.flatMap(({ dependencies }) => dependencies), unread: universe.unread };
    },
  };
}

function readUniverse(parser: JavaParser, sources: readonly SourceFile[]): JavaUniverse {
  return withJavaSources(parser, (parse) => {
    const { files, unparsed } = parse(sources.filter(({ path }) => isJavaSource(path)));
    const project = createJavaProject(files);
    const unreadable = new Set(project.unreadable);
    const unread = [...unparsed, ...project.unreadable].map(({ path }) => ({ file: path, reason: "source-unreadable" as const }));
    return { read: files.filter((file) => !unreadable.has(file)).map((file) => ({ file: file.path, dependencies: importsOf(file, project) })), unread };
  });
}

function importsOf(file: JavaFile, project: JavaProject): ModuleDependency[] {
  return namedChildren(file.root).filter((node) => node.type === "import_declaration").flatMap((node): ModuleDependency[] => {
    const name = node.namedChildren.find((part) => part?.type.endsWith("identifier"));
    if (name === undefined || name === null) return [];
    const wildcard = node.namedChildren.some((part) => part?.type === "asterisk");
    const member = !wildcard && node.children.some((part) => part?.type === "static");
    const container = member ? name.text.slice(0, name.text.lastIndexOf(".")) : name.text;
    const last = name.type === "scoped_identifier" ? name.childForFieldName("name") ?? name : name;
    const { target, declared } = resolved(container, wildcard, file, project);
    const binding: ModuleBinding = wildcard
      ? { imported: "*", ...position(node), typeOnly: false }
      : { local: last.text, imported: last.text, ...position(last), typeOnly: false, ...(declared === undefined ? {} : { exportedAs: member ? `${declared}.${last.text}` : declared }) };
    return [{ file: file.path, line: position(node).line, endLine: node.endPosition.row + 1, specifier: wildcard ? `${name.text}.*` : name.text, kind: "import", typeOnly: false, target, bindings: [binding] }];
  });
}

function resolved(name: string, wildcard: boolean, file: JavaFile, project: JavaProject): { target: ModuleTarget; declared?: string } {
  const type = project.lookupType(name, { file, type: undefined });
  if (type === "ambiguous") return { target: { kind: "unresolved", reason: `${name} is declared by several files` } };
  if (type !== undefined) return { target: { kind: "repository", file: type.file.path }, declared: type.fqn };
  if (wildcard && project.types.some((declared) => declared.file.packageName === name)) return { target: { kind: "unresolved", reason: `${name} is a package of the repository, not one file` } };
  if (project.isPlatformName(name)) return { target: { kind: "external", module: wildcard ? name : name.slice(0, name.lastIndexOf(".")) } };
  return { target: { kind: "unresolved", reason: `no source of the snapshot declares ${name}` } };
}

function position(node: Node): { line: number; column: number } {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}
