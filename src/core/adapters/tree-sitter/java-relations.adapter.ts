import type { Node } from "web-tree-sitter";

/** The written type names, excluding declaration names and qualifier fragments. */
export function javaTypeReferences(root: Node): readonly Node[] {
  const found: Node[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "annotation" || node.type === "marker_annotation") {
      const name = node.childForFieldName("name");
      if (name !== null) found.push(name);
    }
    if (node.type === "scoped_type_identifier") {
      found.push(node);
      continue;
    }
    if (node.type === "type_identifier") {
      const parent = node.parent;
      const inferred = node.text === "var" && (parent?.type === "local_variable_declaration" || parent?.type === "resource");
      if (!inferred && parent?.childForFieldName("name")?.id !== node.id && !(parent?.type === "type_parameter" && parent.namedChildren[0]?.id === node.id)) found.push(node);
      continue;
    }
    pending.push(...node.namedChildren.toReversed());
  }
  return found;
}

/**
 * A name written in an expression that a type may begin (JLS 6.5.2): a chain of plain identifiers that a field access
 * reads, a call is made on or a method reference is qualified by, whole. `typeSegments`: how many of its leading
 * segments may name a type; a field access read as a value ends in a field.
 */
export interface JavaAmbiguousName {
  node: Node;
  segments: readonly string[];
  typeSegments: number;
}

export function javaAmbiguousNames(root: Node): readonly JavaAmbiguousName[] {
  const found: JavaAmbiguousName[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const segments = node.type === "field_access" ? plainSegments(node) : undefined;
    if (segments !== undefined) {
      const parent = node.parent;
      const qualifies = (parent?.type === "method_invocation" && parent.childForFieldName("object")?.id === node.id) || (parent?.type === "method_reference" && parent.namedChildren[0]?.id === node.id);
      found.push({ node, segments, typeSegments: qualifies ? segments.length : segments.length - 1 });
      continue;
    }
    pending.push(...node.namedChildren.toReversed());
  }
  return found;
}

function plainSegments(node: Node): string[] | undefined {
  if (node.type === "identifier") return [node.text];
  if (node.type !== "field_access") return undefined;
  const object = node.childForFieldName("object");
  const field = node.childForFieldName("field");
  const head = object === null ? undefined : plainSegments(object);
  return head === undefined || field?.type !== "identifier" ? undefined : [...head, field.text];
}
