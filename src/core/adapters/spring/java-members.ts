import type { Node } from "web-tree-sitter";
import { isTypeDeclaration, namedChildren, type TypeDecl } from "./java-symbols.ts";

/** A name a method can use for a value: a field, a parameter or a local variable. */
export interface Binding {
  name: string;
  /** The declared type as written, without type arguments. */
  typeName: string;
  /** The declaration, whose annotations tell how the value is injected. */
  node: Node;
  initializer?: Node;
}

/** An assignment to a field, with the constructor or method it is written in. */
export interface Assignment {
  value: Node;
  member: Node;
}

const MEMBERS: ReadonlySet<string> = new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration"]);

const fieldCache = new WeakMap<TypeDecl, ReadonlyMap<string, Binding>>();

export function typeNameOf(node: Node | null | undefined): string {
  if (node === null || node === undefined) return "";
  return (node.type === "generic_type" ? node.namedChildren[0] : node)?.text.replace(/\s+/g, "") ?? "";
}

/** The declarations of a type body, an enum's included. */
export function memberNodes(type: TypeDecl): Node[] {
  const body = type.node.childForFieldName("body");
  return body === null ? [] : namedChildren(body).flatMap((child) => (child.type === "enum_body_declarations" ? namedChildren(child) : [child]));
}

export function isMember(node: Node): boolean {
  return MEMBERS.has(node.type);
}

function bindingsOf(declaration: Node, into: Map<string, Binding>): void {
  const declared = typeNameOf(declaration.childForFieldName("type"));
  for (const declarator of declaration.childrenForFieldName("declarator")) {
    const name = declarator.childForFieldName("name")?.text;
    const initializer = declarator.childForFieldName("value") ?? undefined;
    const type = declared === "var" && initializer?.type === "object_creation_expression" ? typeNameOf(initializer.childForFieldName("type")) : declared;
    if (name !== undefined) into.set(name, { name, typeName: type, node: declaration, ...(initializer === undefined ? {} : { initializer }) });
  }
}

function parameterBinding(parameter: Node): Binding | undefined {
  const name = parameter.childForFieldName("name")?.text;
  const type = typeNameOf(parameter.childForFieldName("type") ?? parameter.namedChildren.find((child) => child.type.endsWith("type")));
  return name === undefined ? undefined : { name, typeName: type, node: parameter };
}

/** The fields of a type, and the components of a record. */
export function fieldBindings(type: TypeDecl): ReadonlyMap<string, Binding> {
  const cached = fieldCache.get(type);
  if (cached !== undefined) return cached;
  const fields = new Map<string, Binding>();
  for (const member of memberNodes(type)) if (member.type === "field_declaration") bindingsOf(member, fields);
  const components = type.node.childForFieldName("parameters");
  for (const component of components === null ? [] : namedChildren(components)) {
    const binding = parameterBinding(component);
    if (binding !== undefined) fields.set(binding.name, binding);
  }
  fieldCache.set(type, fields);
  return fields;
}

/** The parameters of a method or constructor and the variables its body declares, outside any nested type. */
export function localBindings(member: Node): ReadonlyMap<string, Binding> {
  const locals = new Map<string, Binding>();
  const parameters = member.childForFieldName("parameters");
  for (const parameter of parameters === null ? [] : namedChildren(parameters)) {
    const binding = parameterBinding(parameter);
    if (binding !== undefined) locals.set(binding.name, binding);
  }
  for (const node of descendants(member)) if (node.type === "local_variable_declaration") bindingsOf(node, locals);
  return locals;
}

/** Every right-hand side assigned to a field of the type, by the field's name: `this.f = e` and `f = e`. */
export function assignmentsOf(type: TypeDecl): ReadonlyMap<string, Assignment[]> {
  const found = new Map<string, Assignment[]>();
  for (const member of memberNodes(type).filter(isMember)) {
    for (const node of descendants(member)) {
      if (node.type !== "assignment_expression") continue;
      const left = node.childForFieldName("left");
      const value = node.childForFieldName("right");
      const name = left?.type === "field_access" && left.childForFieldName("object")?.type === "this" ? left.childForFieldName("field")?.text : left?.type === "identifier" ? left.text : undefined;
      if (name !== undefined && value !== null) found.set(name, [...(found.get(name) ?? []), { value, member }]);
    }
  }
  return found;
}

/** The nodes under `root`, not entering nested type declarations; an anonymous class body belongs to its enclosing type. */
export function descendants(root: Node): Node[] {
  const found: Node[] = [];
  const pending = [...root.namedChildren];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeDeclaration(node)) continue;
    found.push(node);
    pending.push(...node.namedChildren);
  }
  return found;
}

export function argumentsOf(invocation: Node): Node[] {
  const list = invocation.childForFieldName("arguments");
  return list === null ? [] : namedChildren(list);
}
