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
