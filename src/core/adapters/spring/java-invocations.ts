import type { Node } from "web-tree-sitter";
import { descendants, isMember, localBindings, memberNodes, type Binding } from "./java-members.ts";
import { externalNames, namedChildren, scopeOf, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import type { UrlText } from "./url-text.ts";

export const NO_VARIABLES: ReadonlyMap<string, Binding> = new Map();

/** One method call, with the type and member it is written in and the names that member declares. */
export interface Invocation {
  node: Node;
  type: TypeDecl;
  member: Node | undefined;
  locals: ReadonlyMap<string, Binding>;
}

/** The type a name resolves to: one a source declares, or the fully qualified name of one no source gives. */
export type Resolved = { decl: TypeDecl } | { fqn: string };

/** What a receiver expression holds: the name, the type that declares it and the type it is an instance of. */
export interface Receiver {
  binding: Binding;
  owner: TypeDecl | undefined;
  resolved: Resolved;
}

export function invocationsOf(type: TypeDecl): Invocation[] {
  return memberNodes(type).flatMap((member) => {
    const locals = isMember(member) ? localBindings(member) : NO_VARIABLES;
    return descendants(member)
      .filter((node) => node.type === "method_invocation")
      .map((node): Invocation => ({ node, type, member: isMember(member) ? member : undefined, locals }));
  });
}

export function symbolOf({ type, member }: Invocation): string {
  const name = member?.type === "method_declaration" ? member.childForFieldName("name")?.text : undefined;
  return name === undefined ? type.qualifiedName : `${type.qualifiedName}.${name}`;
}

export function parametersOf(member: Node): string[] {
  const list = member.childForFieldName("parameters");
  return (list === null ? [] : namedChildren(list)).map((parameter) => parameter.childForFieldName("name")?.text ?? "");
}

/** Whether an expression reads a parameter of the method it is written in, directly or through a local variable. */
export function referencesParameter(expression: Node, invocation: Invocation, trail: ReadonlySet<string> = new Set()): boolean {
  return [expression, ...descendants(expression)].some((node) => {
    if (node.type !== "identifier") return false;
    const binding = invocation.locals.get(node.text);
    if (binding === undefined || trail.has(node.text)) return false;
    return binding.node.type.endsWith("parameter") || (binding.initializer !== undefined && referencesParameter(binding.initializer, invocation, new Set(trail).add(node.text)));
  });
}

export function resolveType(name: string, from: TypeDecl, project: JavaProject): Resolved | undefined {
  const found = project.lookupType(name, scopeOf(from));
  if (found === "ambiguous") return undefined;
  if (found !== undefined) return { decl: found };
  const [fqn] = externalNames(name, from.file, false);
  return fqn === undefined ? undefined : { fqn };
}

/** The type a receiver expression is an instance of, through the field, parameter or variable that holds it. */
export function receiverOf(object: Node, invocation: Invocation, project: JavaProject, text: UrlText): Receiver | undefined {
  const name = object.type === "identifier" ? object.text : object.type === "field_access" && object.childForFieldName("object")?.type === "this" ? object.childForFieldName("field")?.text : undefined;
  if (name === undefined) return undefined;
  const local = object.type === "identifier" ? invocation.locals.get(name) : undefined;
  const field = local === undefined ? text.fieldOf(invocation.type, name) : undefined;
  const binding = local ?? field?.binding;
  const owner = field?.owner ?? invocation.type;
  const resolved = binding === undefined ? undefined : resolveType(binding.typeName, owner, project);
  return binding === undefined || resolved === undefined ? undefined : { binding, owner: field?.owner, resolved };
}

/** The types a call's receiver is an instance of, its superclasses included: where a wrapper's declaration may sit. */
export function holdersOf(object: Node | null, invocation: Invocation, project: JavaProject, text: UrlText): TypeDecl[] {
  if (object === null || object.type === "this") return [...project.classChain(invocation.type)];
  const receiver = receiverOf(object, invocation, project, text);
  return receiver !== undefined && "decl" in receiver.resolved ? [...project.classChain(receiver.resolved.decl)] : [];
}
