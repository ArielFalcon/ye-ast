import type { Node } from "web-tree-sitter";
import { fileCut, type UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { isJvmTestFile } from "../../domain/languages/java.ts";
import { isUncoveredJvmSource } from "../../domain/languages/path-class.ts";
import { JAVA_PROFILE } from "../../domain/languages/profiles.ts";
import { relation, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import type { Cut, Finding } from "../../domain/shared/fact.ts";
import type { LanguageRelationsReader, LanguageRelations } from "../../ports/language-pack.port.ts";
import { declaredVariablesOnce, typeVariableAround } from "../tree-sitter/java-declared-variables.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { javaAmbiguousNames, javaSimpleNames, javaTypeReferences, javaValueFieldReads } from "../tree-sitter/java-relations.adapter.ts";
import { projectBuildIn } from "./api-delegates.ts";
import { constantOfFieldRead, constantOfSimpleName, constantsOfQualifiedName, repositoryConstantNames, staticImportsOf, typeOfAmbiguousName, typesOfStaticImport, type ConstantRead, type DeclaredConstant } from "./java-ambiguous-names.ts";
import { enclosingType, heldJavaProject, withJavaSources, type UnparsedSource } from "./java-project.ts";
import { createJavaProject, isTypeDeclaration, platformTypeName, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

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

export function createJavaRelations(parser: () => Promise<JavaParser>): LanguageRelationsReader {
  return {
    async extract(sources, options = {}) {
      const paths = options.paths ?? sources.map(({ path }) => path);
      const build = projectBuildIn(options.context ?? []);
      const present = new Set(sources.map(({ path }) => path));
      const missing = paths.filter((path) => isUncoveredJvmSource(path) || (JAVA_PROFILE.reads(path) && !isJvmTestFile(path) && !present.has(path)));
      const derive = (files: readonly JavaFile[], project: JavaProject, unparsed: readonly UnparsedSource[]): LanguageRelations => {
        const relations: Finding<Relation>[] = [];
        const cuts: Cut[] = [];
        const unresolved: UnresolvedUse[] = [];
        const places = Map.groupBy(project.types, (type) => JSON.stringify(ref(type)));
        const typesByName = Map.groupBy(project.types, (type) => type.name);
        const typesByFile = Map.groupBy(project.types, (type) => type.file);
        const typesByFqn = Map.groupBy(project.types, (type) => type.fqn);
        const unread = (path: string, line: number, name: string) => cuts.push({ kind: "unresolved-link", at: [`${path}:${line} ${name}`], reason: "relation-unread", reach: { kind: "anything", runtime: "java" } });
        const unplaced = (file: JavaFile, node: Node, candidates: readonly TypeDecl[] = [], name = node.text) => unresolved.push({ kind: "references", file: file.path, line: node.startPosition.row + 1, column: node.startPosition.column, name, candidates: candidates.map((type) => type.fqn).toSorted() });
        for (const path of missing) {
          if (isUncoveredJvmSource(path)) cuts.push(fileCut("no-extractor", path, "language"));
          else unread(path, 1, "unread");
        }
        for (const source of unparsed) unread(source.path, source.line, "source-unreadable");
        for (const file of project.unreadable) unread(file.path, 1, "source-unreadable");
        if (cuts.length > 0) return { relations, cuts, unresolved };
        const incomplete = options.completeSource === false;
        const variables = declaredVariablesOnce();
        const referenced = new Set<string>();
        const pairOf = (owner: TypeDecl, bound: TypeDecl) => JSON.stringify([ref(owner), ref(bound)]);
        const place = (file: JavaFile, owner: TypeDecl, node: Node, bound: TypeDecl, name: string) => {
          if ((places.get(JSON.stringify(ref(owner)))?.length ?? 0) > 1 || (places.get(JSON.stringify(ref(bound)))?.length ?? 0) > 1) unplaced(file, node, places.get(JSON.stringify(ref(bound))), name);
          else if (bound !== owner) {
            relations.push({ status: "complete", value: { ...relation("references", ref(owner), ref(bound)), at: { path: file.path, line: node.startPosition.row + 1 } }, evidence: [{ path: file.path, line: node.startPosition.row + 1 }] });
            referenced.add(pairOf(owner, bound));
          }
        };
        const read = (file: JavaFile, owner: TypeDecl, node: Node, name: string, settled: boolean) => {
          const scope = { file, type: owner, at: node };
          const bound = project.resolveTypeName(name, scope);
          if (!incomplete && settled && typeof bound === "object" && !("local" in bound)) place(file, owner, node, bound, name);
          else if (bound === undefined && !incomplete) {
            const external = platformTypeName(name, scope, project);
            if (external === undefined) unplaced(file, node, [], name);
          } else unplaced(file, node, typesByName.get(name.split(".").at(-1)!), name);
        };
        const constantNames = repositoryConstantNames(project);
        const provenReads = new Set<string>();
        const openReads: { writer: SymbolRef | undefined; read: ConstantRead; path: string }[] = [];
        const readConstant = (file: JavaFile, read: ConstantRead | undefined) => {
          if (read === undefined || !constantNames.has(read.name)) return;
          const writer = writerOf(read.node, file.path);
          const line = read.node.startPosition.row + 1;
          if (writer === undefined || incomplete || !read.settled || read.constants.length !== 1) {
            openReads.push({ writer, read, path: file.path });
            return;
          }
          const to = constantRef(read.constants[0]!);
          provenReads.add(JSON.stringify([writer, to]));
          relations.push({ status: "complete", value: { ...relation("references", writer, to), at: { path: file.path, line } }, evidence: [{ path: file.path, line }] });
        };
        for (const file of files) {
          const localProject = { ...project, types: typesByFile.get(file) ?? [] };
          for (const node of javaTypeReferences(file.root)) {
            if (options.signal?.aborted) return { relations: sortFindings(relations), cuts, unresolved };
            const owner = enclosingType(node, file, localProject);
            if (owner === undefined) {
              unplaced(file, node, typesByName.get(node.text.split(".").at(-1)!));
              continue;
            }
            if (typeVariableAround(node, node.text.split(".")[0])) continue;
            read(file, owner, node, node.text, true);
          }
          const locals = variables(file.root);
          for (const name of javaAmbiguousNames(file.root)) {
            if (options.signal?.aborted) return { relations: sortFindings(relations), cuts, unresolved };
            const owner = enclosingType(name.node, file, localProject);
            const denoted = owner === undefined ? undefined : typeOfAmbiguousName(name, file, owner, project, locals);
            if (denoted !== undefined) read(file, owner!, name.node, denoted.name, denoted.settled);
            if (owner !== undefined && name.segments.slice(1).some((segment) => constantNames.has(segment))) for (const constant of constantsOfQualifiedName(name, file, owner, project, locals)) readConstant(file, constant);
          }
          for (const node of javaValueFieldReads(file.root)) if (constantNames.has(node.childForFieldName("field")?.text ?? "")) readConstant(file, constantOfFieldRead(node, file, project));
          const imports = staticImportsOf(file, typesByFqn);
          const open: { owner: TypeDecl | undefined; node: Node; type: TypeDecl }[] = [];
          for (const name of javaSimpleNames(file.root)) {
            if (options.signal?.aborted) return { relations: sortFindings(relations), cuts, unresolved };
            const constant = constantNames.has(name.node.text);
            if (imports === undefined && !constant) continue;
            const owner = enclosingType(name.node, file, localProject);
            if (constant) readConstant(file, constantOfSimpleName(name, imports, file, owner, project, locals));
            if (imports === undefined) continue;
            const imported = typesOfStaticImport(name, imports!, owner, project, locals);
            for (const type of imported?.types ?? []) {
              if (owner !== undefined && !incomplete && imported!.settled) place(file, owner, name.node, type, type.fqn);
              else open.push({ owner, node: name.node, type });
            }
          }
          for (const { owner, node, type } of open) if (owner === undefined || !referenced.has(pairOf(owner, type))) unplaced(file, node, [type], type.fqn);
        }
        for (const { writer, read, path } of openReads) {
          if (writer !== undefined && read.constants.length > 0 && read.constants.every((constant) => provenReads.has(JSON.stringify([writer, constantRef(constant)])))) continue;
          unresolved.push({ kind: "references", file: path, line: read.node.startPosition.row + 1, column: read.node.startPosition.column, name: read.name, candidates: read.constants.map(({ type, name }) => `${type.fqn}.${name.text}`).toSorted() });
        }
        return { relations: sortFindings(relations), cuts, unresolved };
      };
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
