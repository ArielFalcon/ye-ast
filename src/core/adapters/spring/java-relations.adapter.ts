import type { Node } from "web-tree-sitter";
import { fileCut, type UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { isJvmTestFile } from "../../domain/languages/java.ts";
import { isUncoveredJvmSource } from "../../domain/languages/path-class.ts";
import { JAVA_PROFILE } from "../../domain/languages/profiles.ts";
import { relation, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import type { Cut, Finding } from "../../domain/shared/fact.ts";
import type { LanguageRelationsReader, LanguageRelations } from "../../ports/language-pack.port.ts";
import { typeVariableAround } from "../tree-sitter/java-declared-variables.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { javaTypeReferences } from "../tree-sitter/java-relations.adapter.ts";
import { projectBuildIn } from "./api-delegates.ts";
import { enclosingType, heldJavaProject, withJavaSources, type UnparsedSource } from "./java-project.ts";
import { createJavaProject, platformTypeName, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

const ref = (type: TypeDecl): SymbolRef => ({ path: type.file.path, symbol: type.name, line: (type.node.childForFieldName("name") ?? type.node).startPosition.row + 1 });

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
        const unread = (path: string, line: number, name: string) => cuts.push({ kind: "unresolved-link", at: [`${path}:${line} ${name}`], reason: "relation-unread", reach: { kind: "anything", runtime: "java" } });
        const unplaced = (file: JavaFile, node: Node, candidates: readonly TypeDecl[] = []) => unresolved.push({ kind: "references", file: file.path, line: node.startPosition.row + 1, column: node.startPosition.column, name: node.text, candidates: candidates.map((type) => type.fqn).toSorted() });
        for (const path of missing) {
          if (isUncoveredJvmSource(path)) cuts.push(fileCut("no-extractor", path, "language"));
          else unread(path, 1, "unread");
        }
        for (const source of unparsed) unread(source.path, source.line, "source-unreadable");
        for (const file of project.unreadable) unread(file.path, 1, "source-unreadable");
        if (cuts.length > 0) return { relations, cuts, unresolved };
        const incomplete = options.completeSource === false;
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
            const scope = { file, type: owner, at: node };
            const bound = project.resolveTypeName(node.text, scope);
            if (!incomplete && typeof bound === "object" && !("local" in bound)) {
              if ((places.get(JSON.stringify(ref(owner)))?.length ?? 0) > 1 || (places.get(JSON.stringify(ref(bound)))?.length ?? 0) > 1) unplaced(file, node, places.get(JSON.stringify(ref(bound))));
              else if (bound !== owner) relations.push({ status: "complete", value: { ...relation("references", ref(owner), ref(bound)), at: { path: file.path, line: node.startPosition.row + 1 } }, evidence: [{ path: file.path, line: node.startPosition.row + 1 }] });
            } else if (bound === undefined && !incomplete) {
              const external = platformTypeName(node.text, scope, project);
              if (external === undefined) unplaced(file, node);
            } else unplaced(file, node, typesByName.get(node.text.split(".").at(-1)!));
          }
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
