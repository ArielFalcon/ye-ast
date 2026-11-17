import type { Node } from "web-tree-sitter";
import { isUncoveredJvmSource } from "../../domain/languages/path-class.ts";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { ImportOrigins, ReceiverFit, ReceiverFitSite } from "../../ports/import-origins.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { annotationAt, COMMENT_NODES, resolve, TYPE_NAMES } from "./java-declared-types.ts";
import { enclosingType, heldJavaProject, withJavaSources, type UnparsedSource } from "./java-project.ts";
import { invocationsOf, methodsByPlace, provesBinding, receiverBindingsOf, callKey } from "./java-receiver-methods.ts";
import { createJavaProject, supertypeClauses, type JavaFile, type JavaProject, type ProjectBuild, type TypeDecl } from "./java-symbols.ts";

const UNKNOWN: ReceiverFit = { kind: "unknown" };
const DISJOINT: ReceiverFit = { kind: "disjoint" };

/**
 * `ImportOrigins.receiverFits` for Java sources (ADR-0104): the receiver of a call is a declared name of a repository
 * generic type `T<A1..An>`, and the class declaring the implementing method writes `T` itself in its own `extends` or
 * `implements` clause as `T<P1..Pn>`. Type arguments are invariant (JLS 4.10.2), so a value of that class is held by the
 * receiver only when every `Pi` is the type `Ai`: some position whose two arguments are ground types the strict resolver
 * settles to different declarations proves the receiver cannot hold one. A raw or wildcard argument, a type variable, an
 * array, a name that binds nothing or several, a receiver that is no declared name, a type that reaches `T` through a
 * base class and a read that proves no binding are `unknown`.
 */
export function createJavaReceiverFits(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[], facts?: DerivedFacts, hold?: ParseHold, build: ProjectBuild = {}): NonNullable<ImportOrigins["receiverFits"]> {
  const unreadJvm = paths.some(isUncoveredJvmSource);
  const sourcesByPath = new Map(sources.map((source) => [source.path, source]));
  const analyze = (sites: readonly ReceiverFitSite[], files: readonly JavaFile[], unparsed: readonly UnparsedSource[], project: JavaProject): readonly ReceiverFit[] => {
    if (!provesBinding(files, project, unparsed, unreadJvm)) return sites.map(() => UNKNOWN);
    const byPath = new Map(files.map((file) => [file.path, file]));
    const methods = methodsByPlace(project);
    const read = new Map<string, { invocations: ReadonlyMap<string, readonly Node[]>; bindings: ReadonlyMap<string, ReceiverBinding> }>();
    const readOf = (file: JavaFile) => {
      let known = read.get(file.path);
      if (known === undefined) {
        known = { invocations: invocationsOf(file.root), bindings: receiverBindingsOf(file, sourcesByPath.get(file.path), facts) };
        read.set(file.path, known);
      }
      return known;
    };

    const identityOf = (node: Node, file: JavaFile): { id: string; arguments: readonly Node[] | undefined } | undefined => {
      if (!TYPE_NAMES.has(node.type)) return undefined;
      const found = resolve(node, file, project, enclosingType(node, file, project), node, true);
      if (found === undefined) return undefined;
      if (found.kind !== "repository") return { id: found.fqn, arguments: argumentsOf(node) };
      return found.type === undefined ? undefined : { id: `${found.type.file.path}#${found.type.qualifiedName}`, arguments: argumentsOf(node) };
    };
    const differ = (first: Node, firstFile: JavaFile, second: Node, secondFile: JavaFile): boolean => {
      const one = identityOf(first, firstFile);
      const other = identityOf(second, secondFile);
      if (one === undefined || other === undefined) return false;
      if (one.id !== other.id) return true;
      return one.arguments !== undefined && other.arguments !== undefined && one.arguments.length === other.arguments.length && one.arguments.some((argument, index) => differ(argument, firstFile, other.arguments![index]!, secondFile));
    };
    const heldType = (invocation: Node, file: JavaFile): { written: Node; type: TypeDecl } | undefined => {
      const object = invocation.childForFieldName("object");
      const receiver = object?.type === "identifier" ? object.text : object?.type === "field_access" ? object.childForFieldName("field")?.text : undefined;
      const binding = readOf(file).bindings.get(callKey(invocation.startPosition.row + 1, invocation.startPosition.column + 1, invocation.childForFieldName("name")?.text ?? ""));
      if (binding === undefined || binding.receiver !== receiver || binding.holds.kind !== "annotated") return undefined;
      const name = annotationAt(file.root, binding.holds.line, binding.holds.column, binding.holds.type);
      if (name === undefined || name.parent?.type !== "generic_type" || name.parent.namedChildren[0]?.id !== name.id) return undefined;
      const found = resolve(name, file, project, enclosingType(name, file, project), name);
      return found?.kind === "repository" && found.type !== undefined ? { written: name.parent, type: found.type } : undefined;
    };
    const excludes = (invocation: Node, file: JavaFile, origin: TypeDecl): boolean => {
      const held = invocation.type === "method_invocation" ? heldType(invocation, file) : undefined;
      if (held === undefined) return false;
      const scope = enclosingType(origin.node.parent ?? origin.node, origin.file, project);
      const clauses = supertypeClauses(origin).filter(({ node }) => {
        const found = resolve(node, origin.file, project, scope, node);
        return found?.kind === "repository" && found.type === held.type;
      });
      const bound = clauses.length === 1 ? argumentsOf(clauses[0]!.node) : undefined;
      const stated = argumentsOf(held.written);
      return bound !== undefined && stated !== undefined && bound.length === stated.length && stated.some((argument, index) => differ(argument, file, bound[index]!, origin.file));
    };

    return sites.map((site) => {
      const file = byPath.get(site.file);
      const origins = methods.get(`${site.implementation.file}:${site.implementation.start}:${site.implementation.name}`) ?? [];
      if (file === undefined || origins.length !== 1) return UNKNOWN;
      const invocations = readOf(file).invocations.get(callKey(site.line, site.column, site.member)) ?? [];
      return invocations.length > 0 && invocations.every((invocation) => excludes(invocation, file, origins[0]!.owner)) ? DISJOINT : UNKNOWN;
    });
  };
  return async (sites) => {
    if (sites.length === 0) return [];
    const read = await parser();
    const held = hold === undefined ? undefined : await heldJavaProject(hold, () => Promise.resolve(read), sources, [], build);
    if (held !== undefined) return analyze(sites, held.files.map(({ file }) => file), held.unparsed, held.project);
    return withJavaSources(read, (parse) => {
      const { files, unparsed } = parse(sources);
      return analyze(sites, files, unparsed, createJavaProject(files, build));
    });
  };
}

/** The type arguments a written type states, none for a name written without any and for the diamond. */
function argumentsOf(written: Node): readonly Node[] | undefined {
  const stated = written.type === "generic_type" ? written.namedChildren.find((child) => child?.type === "type_arguments")?.namedChildren.filter((child): child is Node => child !== null && !COMMENT_NODES.has(child.type)) : undefined;
  return stated === undefined || stated.length === 0 ? undefined : stated;
}
