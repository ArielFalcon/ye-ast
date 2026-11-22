import type { Node } from "web-tree-sitter";
import { fileCut, type UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { isJvmTestFile } from "../../domain/languages/java.ts";
import { isUncoveredJvmSource } from "../../domain/languages/path-class.ts";
import { JAVA_PROFILE } from "../../domain/languages/profiles.ts";
import { relation, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import type { Cut, Finding } from "../../domain/shared/fact.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { LanguageRelationsReader, LanguageRelations } from "../../ports/language-pack.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import { declaredVariablesOnce, typeVariableAround } from "../tree-sitter/java-declared-variables.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { javaAmbiguousNames, javaSimpleNames, javaTypeReferences, javaValueFieldReads } from "../tree-sitter/java-relations.adapter.ts";
import { projectBuildIn } from "./api-delegates.ts";
import { constantOfFieldRead, constantOfSimpleName, constantsOfQualifiedName, repositoryConstantNames, staticImportsOf, typeOfAmbiguousName, typesOfStaticImport, type ConstantRead, type DeclaredConstant } from "./java-ambiguous-names.ts";
import { javaDeclarationIndex } from "./java-declaration-index.ts";
import { questions } from "./java-declaration-questions.ts";
import { enclosingType, heldJavaProject, withJavaSources, type UnparsedSource } from "./java-project.ts";
import { createJavaProject, isTypeDeclaration, platformTypeName, type JavaFile, type JavaProject, type ProjectBuild, type TypeDecl } from "./java-symbols.ts";

const ref = (type: TypeDecl): SymbolRef => ({ path: type.file.path, symbol: type.name, line: (type.node.childForFieldName("name") ?? type.node).startPosition.row + 1 });
const named = (path: string, name: Node): SymbolRef => ({ path, symbol: name.text, line: name.startPosition.row + 1 });
const constantRef = ({ type, name }: DeclaredConstant): SymbolRef => named(type.file.path, name);
const METHODS: ReadonlySet<string> = new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration"]);

/** The declaration whose code writes `node`: the method or constructor around it, the field it initializes, else its type. */
function writerOf(node: Node, path: string): SymbolRef | undefined {
  for (let around = node.parent; around !== null; around = around.parent) {
    const name = METHODS.has(around.type) || isTypeDeclaration(around)
      ? around.childForFieldName("name")
      : around.type === "field_declaration" ? (around.childrenForFieldName("declarator").find((declarator) => declarator !== null && declarator.startIndex <= node.startIndex && node.endIndex <= declarator.endIndex) ?? around.childrenForFieldName("declarator")[0])?.childForFieldName("name") : undefined;
    if (name !== null && name !== undefined) return named(path, name);
  }
  return undefined;
}

/** The relations a file states, and the unresolved constant reads left to the end of the read: what one derivation of one file answers. */
interface FileRelations {
  relations: Finding<Relation>[];
  unresolved: UnresolvedUse[];
  openConstants: UnresolvedUse[];
}

/** What a derivation asks of the sources other than the file it reads: the names the repository declares. */
interface Declared {
  declaresConstant(name: string): boolean;
  /** The qualified names of the types the sources declare under a simple name, sorted. */
  typesNamed(simpleName: string): readonly string[];
}

class Aborted extends Error {}

function relationsOfFile(file: JavaFile, project: JavaProject, declared: Declared, options: { incomplete: boolean; signal?: AbortSignal | undefined }): FileRelations {
  const { incomplete } = options;
  const relations: Finding<Relation>[] = [];
  const unresolved: UnresolvedUse[] = [];
  const stop = () => {
    if (options.signal?.aborted) throw new Aborted();
  };
  const placesOf = (type: TypeDecl): readonly TypeDecl[] => project.typesOf(type.file).filter((other) => other.name === type.name && ref(other).line === ref(type).line);
  const unplaced = (at: Node, candidates: readonly string[] = [], name = at.text) => unresolved.push({ kind: "references", file: file.path, line: at.startPosition.row + 1, column: at.startPosition.column, name, candidates: candidates.toSorted() });
  const variables = declaredVariablesOnce();
  const referenced = new Set<string>();
  const pairOf = (owner: TypeDecl, bound: TypeDecl) => JSON.stringify([ref(owner), ref(bound)]);
  const place = (owner: TypeDecl, node: Node, bound: TypeDecl, name: string) => {
    if (placesOf(owner).length > 1 || placesOf(bound).length > 1) unplaced(node, placesOf(bound).map((type) => type.fqn), name);
    else if (bound !== owner) {
      relations.push({ status: "complete", value: { ...relation("references", ref(owner), ref(bound)), at: { path: file.path, line: node.startPosition.row + 1 } }, evidence: [{ path: file.path, line: node.startPosition.row + 1 }] });
      referenced.add(pairOf(owner, bound));
    }
  };
  const read = (owner: TypeDecl, node: Node, name: string, settled: boolean) => {
    const scope = { file, type: owner, at: node };
    const bound = project.resolveTypeName(name, scope);
    if (!incomplete && settled && typeof bound === "object" && !("local" in bound)) place(owner, node, bound, name);
    else if (bound === undefined && !incomplete) {
      const external = platformTypeName(name, scope, project);
      if (external === undefined) unplaced(node, [], name);
    } else unplaced(node, declared.typesNamed(name.split(".").at(-1)!), name);
  };
  const provenReads = new Set<string>();
  const openReads: { writer: SymbolRef | undefined; read: ConstantRead }[] = [];
  const readConstant = (constantRead: ConstantRead | undefined) => {
    if (constantRead === undefined || !declared.declaresConstant(constantRead.name)) return;
    const writer = writerOf(constantRead.node, file.path);
    const at = constantRead.node.startPosition.row + 1;
    if (writer === undefined || incomplete || !constantRead.settled || constantRead.constants.length !== 1) {
      openReads.push({ writer, read: constantRead });
      return;
    }
    const to = constantRef(constantRead.constants[0]!);
    provenReads.add(JSON.stringify([writer, to]));
    relations.push({ status: "complete", value: { ...relation("references", writer, to), at: { path: file.path, line: at } }, evidence: [{ path: file.path, line: at }] });
  };
  for (const node of javaTypeReferences(file.root)) {
    stop();
    const owner = enclosingType(node, file, project);
    if (owner === undefined) {
      unplaced(node, declared.typesNamed(node.text.split(".").at(-1)!));
      continue;
    }
    if (typeVariableAround(node, node.text.split(".")[0])) continue;
    read(owner, node, node.text, true);
  }
  const locals = variables(file.root);
  for (const name of javaAmbiguousNames(file.root)) {
    stop();
    const owner = enclosingType(name.node, file, project);
    const denoted = owner === undefined ? undefined : typeOfAmbiguousName(name, file, owner, project, locals);
    if (denoted !== undefined) read(owner!, name.node, denoted.name, denoted.settled);
    if (owner !== undefined && name.segments.slice(1).some((segment) => declared.declaresConstant(segment))) for (const constant of constantsOfQualifiedName(name, file, owner, project, locals)) readConstant(constant);
  }
  for (const node of javaValueFieldReads(file.root)) if (declared.declaresConstant(node.childForFieldName("field")?.text ?? "")) readConstant(constantOfFieldRead(node, file, project));
  const imports = staticImportsOf(file, (fqn) => project.typesDeclaring(fqn));
  const open: { owner: TypeDecl | undefined; node: Node; type: TypeDecl }[] = [];
  for (const name of javaSimpleNames(file.root)) {
    stop();
    const constant = declared.declaresConstant(name.node.text);
    if (imports === undefined && !constant) continue;
    const owner = enclosingType(name.node, file, project);
    if (constant) readConstant(constantOfSimpleName(name, imports, file, owner, project, locals));
    if (imports === undefined) continue;
    const imported = typesOfStaticImport(name, imports!, owner, project, locals);
    for (const type of imported?.types ?? []) {
      if (owner !== undefined && !incomplete && imported!.settled) place(owner, name.node, type, type.fqn);
      else open.push({ owner, node: name.node, type });
    }
  }
  for (const { owner, node, type } of open) if (owner === undefined || !referenced.has(pairOf(owner, type))) unplaced(node, [type.fqn], type.fqn);
  const openConstants: UnresolvedUse[] = [];
  for (const { writer, read: constantRead } of openReads) {
    if (writer !== undefined && constantRead.constants.length > 0 && constantRead.constants.every((constant) => provenReads.has(JSON.stringify([writer, constantRef(constant)])))) continue;
    openConstants.push({ kind: "references", file: file.path, line: constantRead.node.startPosition.row + 1, column: constantRead.node.startPosition.column, name: constantRead.name, candidates: constantRead.constants.map(({ type, name }) => `${type.fqn}.${name.text}`).toSorted() });
  }
  return { relations, unresolved, openConstants };
}

function assemble(files: readonly FileRelations[]): LanguageRelations {
  return { relations: sortFindings(files.flatMap((file) => file.relations)), cuts: [], unresolved: [...files.flatMap((file) => file.unresolved), ...files.flatMap((file) => file.openConstants)] };
}

const RELATIONS_SLOT = "java-relations";

/** What the relations of each file answer, kept per file by the questions it asked of the declaration index and the answers it got (ADR-0116). */
async function keptByReads(
  parser: () => Promise<JavaParser>,
  sources: readonly SourceFile[],
  hold: ParseHold,
  facts: DerivedFacts,
  build: ProjectBuild,
  cutsOf: (unparsed: readonly UnparsedSource[], unreadable: readonly string[]) => Cut[],
  options: { incomplete: boolean; signal: AbortSignal | undefined; unreadJvm: boolean },
): Promise<LanguageRelations> {
  const index = javaDeclarationIndex(facts, await parser(), hold.keep(sources), { generatesInterfaces: build.generatesInterfaces === true, unreadJvm: options.unreadJvm });
  const unread = index.unread();
  const cuts = cutsOf(
    unread.flatMap(({ path, state }) => (state.state === "unparsed" || state.state === "declarations-only" ? [{ path, line: state.line }] : [])),
    unread.filter(({ state }) => state.state === "unreadable").map(({ path }) => path),
  );
  if (cuts.length > 0) return { relations: [], cuts, unresolved: [] };
  let held: Promise<{ project: JavaProject; files: ReadonlyMap<string, JavaFile> }> | undefined;
  const heldOver = () => (held ??= heldJavaProject(hold, parser, sources, [], build).then(({ project, files }) => ({ project, files: new Map(files.map(({ file }) => [file.path, file])) })));
  const results: FileRelations[] = [];
  try {
    for (const { path } of sources) {
      const subject = { path, content: index.answer(questions.file(path)), incomplete: options.incomplete, generatesInterfaces: build.generatesInterfaces === true };
      results.push(await facts.ofReads(RELATIONS_SLOT, subject, index, async (record) => {
        const { project, files } = await heldOver();
        const asked = (question: string): string => {
          const answer = index.answer(question);
          record(question, answer);
          return answer;
        };
        const declared: Declared = {
          declaresConstant: (name) => asked(questions.naming("constant", name)) !== "[]",
          typesNamed: (name) => (JSON.parse(asked(questions.named(name))) as [string, string][]).map(([fqn]) => fqn).toSorted(),
        };
        return project.reading((question) => void asked(question), () => relationsOfFile(files.get(path)!, project, declared, options));
      }));
    }
  } catch (error) {
    if (!(error instanceof Aborted)) throw error;
  }
  return assemble(results);
}

export function createJavaRelations(parser: () => Promise<JavaParser>): LanguageRelationsReader {
  return {
    async extract(sources, options = {}) {
      const paths = options.paths ?? sources.map(({ path }) => path);
      const build = projectBuildIn(options.context ?? []);
      const present = new Set(sources.map(({ path }) => path));
      const missing = paths.filter((path) => isUncoveredJvmSource(path) || (JAVA_PROFILE.reads(path) && !isJvmTestFile(path) && !present.has(path)));
      const cutsOf = (unparsed: readonly UnparsedSource[], unreadable: readonly string[]): Cut[] => {
        const cuts: Cut[] = [];
        const unread = (path: string, at: number, name: string) => cuts.push({ kind: "unresolved-link", at: [`${path}:${at} ${name}`], reason: "relation-unread", reach: { kind: "anything", runtime: "java" } });
        for (const path of missing) {
          if (isUncoveredJvmSource(path)) cuts.push(fileCut("no-extractor", path, "language"));
          else unread(path, 1, "unread");
        }
        for (const source of unparsed) unread(source.path, source.line, "source-unreadable");
        for (const path of unreadable) unread(path, 1, "source-unreadable");
        return cuts;
      };
      const incomplete = options.completeSource === false;
      const derivedOver = (files: readonly JavaFile[], project: JavaProject, declared: Declared): LanguageRelations => {
        const results: FileRelations[] = [];
        try {
          for (const file of files) results.push(relationsOfFile(file, project, declared, { incomplete, signal: options.signal }));
        } catch (error) {
          if (!(error instanceof Aborted)) throw error;
        }
        return assemble(results);
      };
      const ofProject = (project: JavaProject): Declared => {
        const constantNames = repositoryConstantNames(project);
        const typesByName = Map.groupBy(project.types, (type) => type.name);
        return { declaresConstant: (name) => constantNames.has(name), typesNamed: (name) => (typesByName.get(name) ?? []).map((type) => type.fqn).toSorted() };
      };
      const derive = (files: readonly JavaFile[], project: JavaProject, unparsed: readonly UnparsedSource[]): LanguageRelations => {
        const cuts = cutsOf(unparsed, project.unreadable.map((file) => file.path));
        return cuts.length > 0 ? { relations: [], cuts, unresolved: [] } : derivedOver(files, project, ofProject(project));
      };
      if (options.hold !== undefined && options.facts !== undefined) return keptByReads(parser, sources, options.hold, options.facts, build, cutsOf, { incomplete, signal: options.signal, unreadJvm: missing.some(isUncoveredJvmSource) });
      if (options.hold !== undefined) {
        const held = await heldJavaProject(options.hold, parser, sources, [], build);
        return derive(held.files.filter(({ owned }) => owned).map(({ file }) => file), held.project, held.unparsed);
      }
      return withJavaSources(await parser(), (parse) => {
        const { files, unparsed } = parse(sources);
        return derive(files, createJavaProject(files, build), unparsed);
      });
    },
  };
}
