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

/** A field access whose object is not a plain chain of identifiers: `this.f`, `super.f`, `call().f`, `(value).f`. */
export function javaValueFieldReads(root: Node): readonly Node[] {
  const found: Node[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "field_access" && plainSegments(node) === undefined) found.push(node);
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

/**
 * A simple name written alone where an expression reads it (JLS 6.5.6.1, 15.12.1): a variable read, the first identifier
 * of a qualified name or of a method reference's qualifier, which a type or a package may also be (`qualifier`), or the
 * name of a call without a qualifier. A `case` label's name, which an enum selector resolves against its own type, is
 * told apart.
 */
export interface JavaSimpleName {
  node: Node;
  kind: "variable" | "qualifier" | "case" | "method";
}

/** Parents under which an identifier never reads a variable nor calls a method. */
const NOT_AN_EXPRESSION: ReadonlySet<string> = new Set(["labeled_statement", "break_statement", "continue_statement", "inferred_parameters", "scoped_identifier", "import_declaration", "package_declaration", "module_declaration", "type_pattern", "record_pattern_component", "receiver_parameter"]);

export function javaSimpleNames(root: Node): readonly JavaSimpleName[] {
  const found: JavaSimpleName[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "module_declaration" || node.type === "import_declaration" || node.type === "package_declaration") continue;
    const kind = node.type === "identifier" ? simpleNameKind(node) : undefined;
    if (kind !== undefined) found.push({ node, kind });
    pending.push(...node.namedChildren.toReversed());
  }
  return found;
}

function simpleNameKind(node: Node): JavaSimpleName["kind"] | undefined {
  const parent = node.parent;
  if (parent === null || NOT_AN_EXPRESSION.has(parent.type)) return undefined;
  const is = (field: string) => parent.childForFieldName(field)?.id === node.id;
  switch (parent.type) {
    case "method_invocation":
      return !is("name") ? "qualifier" : parent.childForFieldName("object") === null ? "method" : undefined;
    case "field_access":
      return is("field") ? undefined : "qualifier";
    case "method_reference":
      return parent.namedChildren[0]?.id === node.id ? "qualifier" : undefined;
    case "element_value_pair":
      return is("key") ? undefined : "variable";
    case "lambda_expression":
      return is("parameters") ? undefined : "variable";
    case "switch_label":
      return "case";
    default:
      return is("name") ? undefined : "variable";
  }
}
