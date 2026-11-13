import { isJavaSource, isJvmTestFile } from "../../domain/languages/java.ts";
import { comparePlacement, type DataEffectReader, type PlacedDataEffect, type UnplacedCause } from "../../domain/trace/data-effect-site.ts";
import type { DataEffect } from "../../domain/trace/trace-fact.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import type { Node } from "web-tree-sitter";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import { javaReceiverBindings } from "../tree-sitter/java-receiver-bindings.ts";
import { annotationAt, resolve } from "./java-declared-types.ts";
import { enclosingType, withJavaSources } from "./java-project.ts";
import { argumentsOf, typeNameOf } from "./java-members.ts";
import { invocationsOf, type Invocation } from "./java-invocations.ts";
import { callKey, createResolver, hasVarargs } from "./java-receiver-methods.ts";
import { createJavaProject, readArgumentSignature, readSignature, sameSignature, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { mapperDeclarations, mapperEffect, mapperStatements, type MapperDeclarations, type MapperStatements } from "./mybatis-mappers.ts";
import { DATA_CLIENTS, ENTITY_OPERATIONS, QUERY_CONFIGURATION, QUERY_FACTORIES, MODIFYING_ANNOTATION, QUERY_ANNOTATION, QUERY_OPERATIONS, REPOSITORY_MEMBER_NAMES, REPOSITORY_OPERATIONS, REPOSITORY_TYPES } from "./data-vocabulary.ts";

export function createJavaDataEffects(parser: JavaParser): DataEffectReader {
  return { placed: async (sources) => {
    return withJavaSources(parser, (parse) => {
      const { files, unparsed } = parse(sources.filter(({ path }) => isJavaSource(path) && !isJvmTestFile(path)));
      const sites: PlacedDataEffect[] = unparsed.map(({ path, line }) => ({ site: { file: path, line, effect: undefined } }));
      const project = createJavaProject(files);
      const resolver = createResolver(project);
      const mappers = { declarations: mapperDeclarations(project), statements: mapperStatements(sources) };
      const bindings = new Map(files.map((file) => [file, new Map(javaReceiverBindings(file.root, { includeUnproven: true }).map((binding) => [callKey(binding.line, binding.column, binding.member), binding]))]));
      for (const type of project.types) for (const call of invocationsOf(type)) {
        const effect = effectAt(call, project, bindings.get(type.file)!, mappers, resolver);
        if (effect !== undefined) sites.push({ site: { file: type.file.path, line: call.node.startPosition.row + 1, effect: effect === false || "unplaced" in effect ? undefined : effect, ...(effect !== false && "unplaced" in effect ? { cause: effect.unplaced } : {}) }, column: call.node.startPosition.column });
      }
      return sites.sort(comparePlacement);
    });
  } };
}

interface Mappers {
  declarations: MapperDeclarations;
  statements: MapperStatements;
}

function effectAt(call: Invocation, project: JavaProject, bindings: ReadonlyMap<string, ReceiverBinding>, mappers: Mappers, resolver: ReturnType<typeof createResolver>): DataEffect | { unplaced: UnplacedCause } | false | undefined {
  const object = call.node.childForFieldName("object");
  const operation = call.node.childForFieldName("name")?.text ?? "";
  if (object === null) return undefined;
  const candidate = REPOSITORY_OPERATIONS.has(operation) || [...DATA_CLIENTS.values()].some((row) => row.has(operation));
  const receiverAt = (invocation: Node) => {
    const binding = bindings.get(callKey(invocation.startPosition.row + 1, invocation.startPosition.column + 1, invocation.childForFieldName("name")?.text ?? ""));
    if (binding?.holds.kind !== "annotated") return undefined;
    let node = annotationAt(call.type.file.root, binding.holds.line, binding.holds.column, binding.holds.type);
    if (node === undefined) return undefined;
    while (node.parent !== null && ["scoped_type_identifier", "generic_type"].includes(node.parent.type)) node = node.parent;
    return { node, unproven: binding.unproven === true, resolved: resolve(node, call.type.file, project, enclosingType(node, call.type.file, project), node, true) };
  };
  let query = object;
  let receiverCall = call.node;
  let configured = false;
  while (query.type === "method_invocation" && QUERY_CONFIGURATION.has(query.childForFieldName("name")?.text ?? "")) {
    const previous = query.childForFieldName("object");
    if (previous === null) return candidate ? false : undefined;
    receiverCall = query;
    query = previous;
    configured = true;
  }
  let receiver = receiverAt(receiverCall);
  let resolved = receiver?.resolved;
  if (query.type === "method_invocation" && QUERY_FACTORIES.has(query.childForFieldName("name")?.text ?? "")) {
    receiver = receiverAt(query);
    const factory = receiver?.resolved;
    resolved = factory?.kind === "platform" && DATA_CLIENTS.get(factory.fqn) === ENTITY_OPERATIONS ? { kind: "platform", fqn: factory.fqn.replace(/EntityManager$/, "Query") } : undefined;
  }
  if (resolved === undefined) {
    if (receiver === undefined) return undefined;
    const identity = project.typeIdentity(typeNameOf(receiver.node), { file: call.type.file, type: enclosingType(receiver.node, call.type.file, project), at: receiver.node });
    if (identity !== undefined && !identity.startsWith("context:") && !DATA_CLIENTS.has(identity) && !REPOSITORY_TYPES.has(identity)) return undefined;
    return candidate ? false : undefined;
  }
  if (resolved.kind === "library") return undefined;
  if (configured && (resolved.kind !== "platform" || DATA_CLIENTS.get(resolved.fqn) !== QUERY_OPERATIONS)) return undefined;
  const actuals = receiver?.node.namedChildren.find((node) => node.type === "type_arguments")?.namedChildren ?? [];
  if (resolved.kind === "repository") {
    if (resolved.type === undefined) return undefined;
    const type = resolved.type;
    if (mappers.declarations.isMapper(type)) return receiver?.unproven === true ? false : mapperEffect(call.node.startPosition.row + 1, operation, type, project, mappers.statements);
    const entities = repositoryEntities(type, project, new Map([...type.typeVariables].map((variable, index) => [variable, actuals[index] === undefined ? undefined : entityName(actuals[index], call.type, project)])));
    if (entities.length === 0) return candidate && REPOSITORY_OPERATIONS.has(operation) && hasOpenAncestry(type, project) ? false : undefined;
    if (receiver?.unproven === true) return false;
    const named = project.hierarchy(type).types.flatMap((owner) => owner.methods.filter((method) => method.name === operation));
    let methods = named.filter((method) => method.parameterTypes.length === argumentsOf(call.node).length);
    if (named.some(hasVarargs)) return false;
    const unique = methods.length === 1 && !REPOSITORY_MEMBER_NAMES.has(operation) && resolver.isDataRepository(type);
    if (methods.length > 0 && !unique) {
      const signatures = methods.map((method) => readSignature(method, project));
      const argumentsSignature = readArgumentSignature(call.node, { file: call.type.file, type: call.type, at: call.node }, project);
      if (argumentsSignature === undefined || signatures.some((signature) => signature === undefined)) return false;
      const matching = methods.filter((_, index) => sameSignature(signatures[index]!, argumentsSignature));
      if (matching.length !== 1) return false;
      methods = matching;
    }
    if (named.length > 0 && methods.length === 0) return false;
    if (methods.some((method) => method.hasBody)) return undefined;
    const annotations = queryAnnotations(methods, project);
    if (annotations.has(undefined)) return false;
    let access = annotations.has(MODIFYING_ANNOTATION) ? "write" as const : annotations.has(QUERY_ANNOTATION) ? "read" as const : REPOSITORY_OPERATIONS.get(operation);
    if (access === undefined && methods.length > 0) {
      if (/^(?:find|read|get|query|search|stream|count|exists)(?:\p{Lu}.*?)?(?:By|AllBy|First|Top)/u.test(operation)) access = "read";
      else if (/^(?:delete|remove)(?:\p{Lu}.*?)?(?:By|AllBy)/u.test(operation)) access = "write";
    }
    if (access === undefined) return methods.length > 0 ? false : undefined;
    const distinct = [...new Set(entities)];
    const entity = distinct.length === 1 ? distinct[0] : undefined;
    return dataEffect(call, operation, access, entity);
  }
  if (receiver?.unproven === true && candidate && (REPOSITORY_TYPES.has(resolved.fqn) || DATA_CLIENTS.has(resolved.fqn))) return false;
  if (REPOSITORY_TYPES.has(resolved.fqn)) {
    const access = REPOSITORY_OPERATIONS.get(operation);
    if (access === undefined) return undefined;
    const entity = actuals[0] === undefined ? undefined : entityName(actuals[0], call.type, project);
    return dataEffect(call, operation, access, entity);
  }
  const vocabulary = DATA_CLIENTS.get(resolved.fqn);
  const access = vocabulary?.get(operation);
  if (access === undefined) return undefined;
  const first = argumentsOf(call.node)[0];
  const entity = vocabulary === ENTITY_OPERATIONS && operation === "find" && first?.type === "class_literal" && first.namedChildren[0] !== undefined ? entityName(first.namedChildren[0], call.type, project) : undefined;
  return dataEffect(call, operation, access, entity);
}

function dataEffect(call: Invocation, operation: string, access: DataEffect["access"], entity: string | undefined): DataEffect {
  return { kind: "data", line: call.node.startPosition.row + 1, operation, access, ...(entity === undefined ? {} : { target: { kind: "entity", name: entity } }) };
}

function entityName(node: Node, type: TypeDecl, project: JavaProject, scope = { type: enclosingType(node, type.file, project) }): string | undefined {
  const found = resolve(node, type.file, project, scope.type, node);
  if (found?.kind !== "repository" || found.type === undefined) return undefined;
  return project.typeIdentity(typeNameOf(node), { file: type.file, type: scope.type, at: node }) === found.type.fqn ? found.type.fqn : undefined;
}

function parentsOf(type: TypeDecl): Node[] {
  const clause = type.kind === "interface" ? type.node.namedChildren.find((child) => child.type === "extends_interfaces") : type.node.childForFieldName("interfaces");
  return [...(clause?.namedChildren.find((child) => child.type === "type_list")?.namedChildren ?? []), ...(type.node.childForFieldName("superclass")?.namedChildren ?? [])];
}

/** Whether an interface extends a type the sources do not state, which may be the Spring Data repository it cannot be proven to be. */
function hasOpenAncestry(type: TypeDecl, project: JavaProject, seen = new Set<TypeDecl>()): boolean {
  if (type.kind !== "interface" || seen.has(type)) return false;
  const next = new Set([...seen, type]);
  return parentsOf(type).some((parent) => {
    const resolved = resolve(parent, type.file, project, type.outer, parent);
    return resolved?.kind === "platform" ? false : resolved?.kind === "repository" && resolved.type !== undefined ? hasOpenAncestry(resolved.type, project, next) : true;
  });
}

/** Undefined entries retain proven repository membership without inventing an entity for a raw or open generic. */
function repositoryEntities(type: TypeDecl, project: JavaProject, env: ReadonlyMap<string, string | undefined>, seen = new Set<TypeDecl>()): (string | undefined)[] {
  if (seen.has(type)) return [];
  const next = new Set([...seen, type]);
  return parentsOf(type).flatMap((parent) => {
    const args = parent.namedChildren.find((child) => child.type === "type_arguments")?.namedChildren ?? [];
    const values = args.map((arg) => env.has(arg.text) ? env.get(arg.text) : type.typeVariables.has(arg.text) || arg.type === "wildcard" ? undefined : entityName(arg, type, project, { type: type.outer }));
    const parentType = resolve(parent, type.file, project, type.outer, parent);
    const declared = parentType?.kind === "repository" ? parentType.type : undefined;
    if (declared !== undefined) return repositoryEntities(declared, project, new Map([...declared.typeVariables].map((variable, index) => [variable, values[index]])), next);
    const fqn = parentType?.kind === "platform" ? parentType.fqn : undefined;
    return fqn !== undefined && REPOSITORY_TYPES.has(fqn) ? [values[0]] : [];
  });
}

function queryAnnotations(methods: readonly MethodDecl[], project: JavaProject): ReadonlySet<string | undefined> {
  const found = new Set<string | undefined>();
  for (const method of methods) {
    const modifiers = method.node.namedChildren.find((child) => child.type === "modifiers");
    for (const node of modifiers?.namedChildren ?? []) {
      if (node.type === "annotation" || node.type === "marker_annotation") {
        const name = node.childForFieldName("name");
        const annotation = name === null ? undefined : resolve(name, method.owner.file, project, method.owner, name);
        found.add(annotation?.kind === "platform" ? annotation.fqn : undefined);
      }
    }
  }
  return found;
}
