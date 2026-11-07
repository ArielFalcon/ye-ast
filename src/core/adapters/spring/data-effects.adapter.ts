import { isJavaSource, isJvmTestFile } from "../../domain/languages/java.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { DataEffectReader, PlacedDataEffect } from "../../domain/trace/data-effect-site.ts";
import type { DataEffect } from "../../domain/trace/trace-fact.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { argumentsOf, fieldBindings, typeNameOf } from "./java-members.ts";
import { invocationsOf, receiverOf, type Invocation, type Receiver, type Resolved } from "./java-invocations.ts";
import { createJavaProject, describeFile, qualifiedTypeName, scopeOf, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { DATA_CLIENTS, ENTITY_OPERATIONS, QUERY_CONFIGURATION, QUERY_FACTORIES, QUERY_OPERATIONS, REPOSITORY_OPERATIONS, REPOSITORY_TYPES } from "./data-vocabulary.ts";

export function createJavaDataEffects(parser: JavaParser): DataEffectReader {
  return { placed: async (sources) => {
    const trees: JavaSyntaxTree[] = [];
    const sites: PlacedDataEffect[] = [];
    try {
      const files = sources.filter(({ path }) => isJavaSource(path) && !isJvmTestFile(path)).flatMap(({ path, content }) => {
        const parsed = parser.parse(content);
        if (!parsed.ok) {
          sites.push({ site: { file: path, line: parsed.fault.line, effect: undefined } });
          return [];
        }
        trees.push(parsed.value);
        return [describeFile(path, parsed.value.root)];
      });
      const project = createJavaProject(files);
      for (const type of project.types) for (const call of invocationsOf(type)) {
        const effect = effectAt(call, project);
        if (effect !== undefined) sites.push({ site: { file: type.file.path, line: effect.line, effect }, column: call.node.startPosition.column });
      }
      return sites.sort((a, b) => compareText(a.site.file, b.site.file) || a.site.line - b.site.line || (a.column ?? 0) - (b.column ?? 0));
    } finally {
      for (const tree of trees) tree.dispose();
    }
  } };
}

function effectAt(call: Invocation, project: JavaProject): DataEffect | undefined {
  const object = call.node.childForFieldName("object");
  const operation = call.node.childForFieldName("name")?.text ?? "";
  if (object === null) return undefined;
  const fields = { fieldOf: (type: TypeDecl, name: string) => {
    for (const owner of project.classChain(type)) {
      const binding = fieldBindings(owner).get(name);
      if (binding !== undefined) return { binding, owner };
    }
    return undefined;
  } };
  let query = object;
  let configured = false;
  while (query.type === "method_invocation" && QUERY_CONFIGURATION.has(query.childForFieldName("name")?.text ?? "")) {
    const previous = query.childForFieldName("object");
    if (previous === null) return undefined;
    query = previous;
    configured = true;
  }
  const receiver = receiverOf(query, call, project, fields);
  if (receiver !== undefined && !unambiguous(receiver, call)) return undefined;
  let resolved: Resolved | undefined = receiver?.resolved;
  if (resolved === undefined && query.type === "method_invocation" && QUERY_FACTORIES.has(query.childForFieldName("name")?.text ?? "")) {
    const root = query.childForFieldName("object");
    const held = root === null ? undefined : receiverOf(root, call, project, fields);
    const factory = held === undefined || !unambiguous(held, call) ? undefined : held.resolved;
    if (factory !== undefined && "fqn" in factory && DATA_CLIENTS.get(factory.fqn) === ENTITY_OPERATIONS) resolved = { fqn: factory.fqn.replace(/EntityManager$/, "Query") };
  }
  if (resolved === undefined || (configured && (!("fqn" in resolved) || DATA_CLIENTS.get(resolved.fqn) !== QUERY_OPERATIONS))) return undefined;
  const variables = call.type.methods.find((method) => method.node.id === call.member?.id)?.typeVariables ?? call.type.typeVariables;
  const actuals = receiver?.binding.node.childForFieldName("type")?.namedChildren.find((node) => node.type === "type_arguments")?.namedChildren ?? [];
  const entityOf = (node: (typeof actuals)[number]) => variables.has(node.text) || node.type === "wildcard" ? undefined : qualifiedTypeName(typeNameOf(node), scopeOf(receiver?.owner ?? call.type), project);
  if (receiver?.binding.node.type === "local_variable_declaration") {
    const block = receiver.binding.node.parent;
    if (block === null || call.node.startIndex < receiver.binding.node.startIndex || call.node.startIndex > block.endIndex || call.node.startIndex < block.startIndex) return undefined;
  }
  if ("decl" in resolved) {
    const hierarchy = project.hierarchy(resolved.decl).types;
    const methods = hierarchy.flatMap((owner) => owner.methods.filter((method) => method.name === operation));
    if (methods.some((method) => method.hasBody)) return undefined;
    const entities = repositoryEntities(resolved.decl, project, new Map([...resolved.decl.typeVariables].map((variable, index) => [variable, actuals[index] === undefined ? undefined : entityOf(actuals[index])])));
    if (entities.length === 0) return undefined;
    const annotations = queryAnnotations(methods, project);
    let access = annotations.has("org.springframework.data.jpa.repository.Modifying") ? "write" as const : annotations.has("org.springframework.data.jpa.repository.Query") ? "read" as const : REPOSITORY_OPERATIONS.get(operation);
    if (access === undefined && methods.length > 0) {
      if (/^(?:find|read|get|query|search|stream|count|exists)(?:By|AllBy|First|Top)/.test(operation)) access = "read";
      else if (/^(?:delete|remove)(?:By|AllBy)/.test(operation)) access = "write";
    }
    if (access === undefined) return undefined;
    const distinct = [...new Set(entities)];
    const entity = distinct.length === 1 ? distinct[0] : undefined;
    return { kind: "data", line: call.node.startPosition.row + 1, operation, access, ...(entity === undefined ? {} : { target: { kind: "entity", name: entity } }) };
  }
  if (REPOSITORY_TYPES.has(resolved.fqn)) {
    const access = REPOSITORY_OPERATIONS.get(operation);
    if (access === undefined) return undefined;
    const first = actuals[0];
    const entity = first === undefined ? undefined : entityOf(first);
    return { kind: "data", line: call.node.startPosition.row + 1, operation, access, ...(entity === undefined ? {} : { target: { kind: "entity", name: entity } }) };
  }
  const vocabulary = DATA_CLIENTS.get(resolved.fqn);
  const access = vocabulary?.get(operation);
  if (access === undefined) return undefined;
  const first = argumentsOf(call.node)[0];
  const entity = vocabulary === ENTITY_OPERATIONS && operation === "find" && first?.type === "class_literal" ? qualifiedTypeName(typeNameOf(first.namedChildren[0]), scopeOf(call.type), project) : undefined;
  return { kind: "data", line: call.node.startPosition.row + 1, operation, access, ...(entity === undefined ? {} : { target: { kind: "entity", name: entity } }) };
}

/** Undefined entries retain proven repository membership without inventing an entity for a raw or open generic. */
function repositoryEntities(type: TypeDecl, project: JavaProject, env: ReadonlyMap<string, string | undefined> = new Map(), seen = new Set<TypeDecl>()): (string | undefined)[] {
  if (seen.has(type)) return [];
  const next = new Set([...seen, type]);
  const clause = type.kind === "interface" ? type.node.namedChildren.find((child) => child.type === "extends_interfaces") : type.node.childForFieldName("interfaces");
  const parents = [...(clause?.namedChildren.find((child) => child.type === "type_list")?.namedChildren ?? []), ...(type.node.childForFieldName("superclass")?.namedChildren ?? [])];
  return parents.flatMap((parent) => {
    const name = typeNameOf(parent);
    if (type.file.conflictingSingleImports.has(name.split(".")[0] ?? "")) return [];
    const args = parent.namedChildren.find((child) => child.type === "type_arguments")?.namedChildren ?? [];
    const values = args.map((arg) => env.has(arg.text) ? env.get(arg.text) : type.typeVariables.has(arg.text) || arg.type === "wildcard" ? undefined : qualifiedTypeName(typeNameOf(arg), scopeOf(type), project));
    const declared = project.lookupType(name, scopeOf(type));
    if (declared === "ambiguous") return [];
    if (declared !== undefined) return repositoryEntities(declared, project, new Map([...declared.typeVariables].map((variable, index) => [variable, values[index]])), next);
    const fqn = qualifiedTypeName(name, scopeOf(type), project);
    return fqn !== undefined && REPOSITORY_TYPES.has(fqn) ? [values[0]] : [];
  });
}

function queryAnnotations(methods: readonly MethodDecl[], project: JavaProject): ReadonlySet<string | undefined> {
  const found = new Set<string | undefined>();
  for (const method of methods) {
    const modifiers = method.node.namedChildren.find((child) => child.type === "modifiers");
    for (const node of modifiers?.namedChildren ?? []) {
      if (node.type === "annotation" || node.type === "marker_annotation") found.add(qualifiedTypeName(node.childForFieldName("name")?.text ?? "", scopeOf(method.owner), project));
    }
  }
  return found;
}

function unambiguous(receiver: Receiver, call: Invocation): boolean {
  const file = receiver.owner?.file ?? call.type.file;
  return !file.conflictingSingleImports.has(receiver.binding.typeName.split(".")[0] ?? "");
}
