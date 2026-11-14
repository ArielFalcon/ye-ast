import type { Node } from "web-tree-sitter";
import type { FunctionValueCall } from "../../ports/declared-member-names.port.ts";

/** Expressions that are a function value. */
const FUNCTION_VALUES: readonly string[] = ["lambda_expression", "method_reference"];
/** Bodies whose fields `this` and an unshadowed bare name reach. */
const TYPE_BODIES: readonly string[] = ["class_body", "interface_body", "enum_body"];
/** Blocks whose `local_variable_declaration` children declare locals. */
const BLOCKS: readonly string[] = ["block", "constructor_body", "switch_block_statement_group"];

/**
 * The member calls of a Java tree whose receiver the file binds to a function value (see `FunctionValueCall`): `this.r`
 * to a field of the enclosing type body, a bare `r` to its innermost local or parameter, else to that field.
 */
export function javaFunctionValueCalls(root: Node): FunctionValueCall[] {
  const invocations: Node[] = [];
  const assignments: Node[] = [];
  const visit = (node: Node): void => {
    if (node.type === "method_invocation" && node.childForFieldName("object") !== null) invocations.push(node);
    if (node.type === "assignment_expression" && isFunctionValue(node.childForFieldName("right"))) assignments.push(node);
    for (const child of node.namedChildren) if (child !== null) visit(child);
  };
  visit(root);

  const assignedFields = new Set<string>();
  const assignedLocals = new Set<number>();
  for (const assignment of assignments) {
    const left = assignment.childForFieldName("left");
    if (left === null) continue;
    const local = left.type === "identifier" ? localBinding(left) : undefined;
    if (local !== undefined) assignedLocals.add(local.startIndex);
    const field = thisField(left) ?? (left.type === "identifier" && local === undefined ? left.text : undefined);
    const body = enclosingBody(left);
    if (field !== undefined && body !== undefined) assignedFields.add(fieldKey(body, field));
  }
  const fieldHolds = (body: Node | undefined, name: string): boolean =>
    body !== undefined && (assignedFields.has(fieldKey(body, name)) || fieldsOf(body).some((declarator) => nameOf(declarator) === name && isFunctionValue(declarator.childForFieldName("value"))));
  const localHolds = (binding: Node): boolean => isFunctionValue(binding.childForFieldName("value")) || assignedLocals.has(binding.startIndex);

  return invocations.flatMap((invocation): FunctionValueCall[] => {
    const object = invocation.childForFieldName("object")!;
    const member = invocation.childForFieldName("name")?.text;
    if (member === undefined) return [];
    const field = thisField(object);
    let receiver: string | undefined;
    let holds = false;
    if (field !== undefined) {
      receiver = field;
      holds = fieldHolds(enclosingBody(object), field);
    } else if (object.type === "identifier") {
      receiver = object.text;
      const local = localBinding(object);
      holds = local === undefined ? fieldHolds(enclosingBody(object), receiver) : localHolds(local);
    }
    return receiver !== undefined && holds ? [{ line: invocation.startPosition.row + 1, receiver, member }] : [];
  });
}

/** A lambda or a method reference, through parentheses and casts; a conditional is one when either branch may be. */
function isFunctionValue(node: Node | null): boolean {
  if (node === null) return false;
  if (node.type === "parenthesized_expression") return isFunctionValue(node.namedChildren[0] ?? null);
  if (node.type === "cast_expression") return isFunctionValue(node.childForFieldName("value"));
  if (node.type === "ternary_expression") return isFunctionValue(node.childForFieldName("consequence")) || isFunctionValue(node.childForFieldName("alternative"));
  return isFunctionValueNode(node);
}

/** A lambda or a method reference: the values a function-value call is read through. */
export function isFunctionValueNode(node: Node): boolean {
  return FUNCTION_VALUES.includes(node.type);
}

function fieldKey(body: Node, name: string): string {
  return `${body.startIndex}:${name}`;
}

function nameOf(node: Node): string | undefined {
  return node.childForFieldName("name")?.text;
}

/** `f` for `this.f`. */
export function thisField(node: Node): string | undefined {
  return node.type === "field_access" && node.childForFieldName("object")?.type === "this" ? node.childForFieldName("field")?.text : undefined;
}

export function enclosingBody(node: Node): Node | undefined {
  for (let scope = node.parent; scope !== null; scope = scope.parent) if (TYPE_BODIES.includes(scope.type)) return scope;
  return undefined;
}

/**
 * The field declarators of a type body, an enum's included, and the components of a record's body, each the formal
 * parameter that declares its implicit private final field (JLS 8.10.3); a varargs component is not read.
 */
export function fieldsOf(body: Node): Node[] {
  const members = body.namedChildren.flatMap((child) => (child?.type === "enum_body_declarations" ? child.namedChildren : [child]));
  const components = body.parent?.type === "record_declaration" ? (body.parent.childForFieldName("parameters")?.namedChildren ?? []).filter((child): child is Node => child?.type === "formal_parameter") : [];
  return [...components, ...members.filter((member) => member?.type === "field_declaration" || member?.type === "constant_declaration").flatMap((field) => field!.namedChildren.filter((child): child is Node => child?.type === "variable_declarator"))];
}

/** Whether a record component is the formal parameter `fieldsOf` reads for its implicit field. */
export function isRecordComponent(declarator: Node): boolean {
  return declarator.type === "formal_parameter" && declarator.parent?.parent?.type === "record_declaration";
}

/** The innermost local or parameter that declares the identifier's name, up to its type body. */
export function localBinding(identifier: Node): Node | undefined {
  const name = identifier.text;
  for (let scope = identifier.parent; scope !== null && !TYPE_BODIES.includes(scope.type); scope = scope.parent) {
    for (const declared of declaredIn(scope)) if (nameOf(declared) === name || (declared.type === "identifier" && declared.text === name)) return declared;
  }
  return undefined;
}

/** The locals, parameters and loop or catch variables a scope node declares. */
function declaredIn(scope: Node): Node[] {
  const named = (node: Node | null): Node[] => (node === null ? [] : node.namedChildren.filter((child): child is Node => child !== null));
  if (BLOCKS.includes(scope.type)) return named(scope).filter((child) => child.type === "local_variable_declaration").flatMap((declaration) => named(declaration).filter((child) => child.type === "variable_declarator"));
  if (scope.type === "method_declaration" || scope.type === "constructor_declaration") return named(scope.childForFieldName("parameters"));
  if (scope.type === "lambda_expression") {
    const parameters = scope.childForFieldName("parameters");
    return parameters?.type === "identifier" ? [parameters] : named(parameters);
  }
  if (scope.type === "for_statement") return named(scope.childForFieldName("init")).filter((child) => child.type === "variable_declarator");
  if (scope.type === "enhanced_for_statement" || scope.type === "catch_clause") return [scope, ...named(scope).filter((child) => child.type === "catch_formal_parameter")].filter((node) => nameOf(node) !== undefined);
  return [];
}
