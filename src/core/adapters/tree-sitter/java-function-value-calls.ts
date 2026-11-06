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

  const fieldHolds = (body: Node | undefined, name: string): boolean =>
    body !== undefined &&
    (fieldsOf(body).some((declarator) => nameOf(declarator) === name && isFunctionValue(declarator.childForFieldName("value"))) ||
      assignments.some((assignment) => {
        const left = assignment.childForFieldName("left");
        const field = left === null ? undefined : thisField(left) ?? (left.type === "identifier" && localBinding(left) === undefined ? left.text : undefined);
        return field === name && left !== null && enclosingBody(left)?.startIndex === body.startIndex;
      }));
  const localHolds = (binding: Node, name: string): boolean =>
    isFunctionValue(binding.childForFieldName("value")) ||
    assignments.some((assignment) => {
      const left = assignment.childForFieldName("left");
      return left?.type === "identifier" && left.text === name && localBinding(left)?.startIndex === binding.startIndex;
    });

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
      holds = local === undefined ? fieldHolds(enclosingBody(object), receiver) : localHolds(local, receiver);
    }
    return receiver !== undefined && holds ? [{ line: invocation.startPosition.row + 1, receiver, member }] : [];
  });
}

function isFunctionValue(node: Node | null): boolean {
  return node !== null && FUNCTION_VALUES.includes(node.type);
}

function nameOf(node: Node): string | undefined {
  return node.childForFieldName("name")?.text;
}

/** `f` for `this.f`. */
function thisField(node: Node): string | undefined {
  return node.type === "field_access" && node.childForFieldName("object")?.type === "this" ? node.childForFieldName("field")?.text : undefined;
}

function enclosingBody(node: Node): Node | undefined {
  for (let scope = node.parent; scope !== null; scope = scope.parent) if (TYPE_BODIES.includes(scope.type)) return scope;
  return undefined;
}

/** The field declarators of a type body, an enum's included. */
function fieldsOf(body: Node): Node[] {
  const members = body.namedChildren.flatMap((child) => (child?.type === "enum_body_declarations" ? child.namedChildren : [child]));
  return members.filter((member) => member?.type === "field_declaration" || member?.type === "constant_declaration").flatMap((field) => field!.namedChildren.filter((child): child is Node => child?.type === "variable_declarator"));
}

/** The innermost local or parameter that declares the identifier's name, up to its type body. */
function localBinding(identifier: Node): Node | undefined {
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
