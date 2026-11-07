import type { Node } from "web-tree-sitter";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import { declaredVariablesOnce, declaresLocal } from "./java-declared-variables.ts";
import { enclosingBody, fieldsOf, localBinding, thisField } from "./java-function-value-calls.ts";

/** Types a declaration may state that name a class or an interface. */
const CLASS_TYPES: ReadonlySet<string> = new Set(["type_identifier", "scoped_type_identifier", "generic_type"]);
/** A call whose name says it reads or writes a field by reflection or through a handle. */
const REFLECTIVE = /Field|VarHandle|Getter|Setter/;

/**
 * The member calls of a Java tree whose receiver one declaration types: a bare `r` bound by `localBinding` (lambda
 * parameters first) to a parameter, a local or a loop or catch variable with a stated class type, or, when no variable of
 * the name is declared in the type body, to a field; `this.r` to a field. A field counts only when the enclosing type
 * body declares it once and `private`, and the file names it through no receiver but `this` and reads no field by
 * reflection. The binding holds the type where it is written, by its first name (ADR-0029 decision 9).
 */
export function javaReceiverBindings(root: Node): ReceiverBinding[] {
  const invocations: Node[] = [];
  const otherReceivers = new Set<string>();
  let reflects = false;
  const visit = (node: Node): void => {
    if (node.type === "method_invocation") {
      if (node.childForFieldName("object") !== null) invocations.push(node);
      if (REFLECTIVE.test(node.childForFieldName("name")?.text ?? "")) reflects = true;
    }
    if (node.type === "field_access" && node.childForFieldName("object")?.type !== "this") otherReceivers.add(node.childForFieldName("field")?.text ?? "");
    for (const child of node.namedChildren) if (child !== null) visit(child);
  };
  visit(root);
  const declaredIn = declaredVariablesOnce();
  /** Whether a type body declares a variable of the name anywhere but as a field: it may shadow the field where it is used. */
  const declaresVariable = (body: Node | undefined, name: string): boolean => body !== undefined && declaresLocal(declaredIn(body), name);

  const fieldType = (at: Node, name: string): Node | undefined => {
    const body = enclosingBody(at);
    const declared = body === undefined ? [] : fieldsOf(body).filter((declarator) => declarator.childForFieldName("name")?.text === name);
    const field = declared.length === 1 ? declared[0]!.parent : undefined;
    if (field?.type !== "field_declaration" || reflects || otherReceivers.has(name) || !isPrivate(field)) return undefined;
    return field.childForFieldName("type") ?? undefined;
  };

  return invocations.flatMap((invocation): ReceiverBinding[] => {
    const object = invocation.childForFieldName("object")!;
    const member = invocation.childForFieldName("name")?.text;
    let receiver: string | undefined;
    let type: Node | undefined;
    const field = thisField(object);
    if (field !== undefined) {
      receiver = field;
      type = fieldType(object, field);
    } else if (object.type === "identifier") {
      receiver = object.text;
      const local = localBinding(object);
      type = local !== undefined ? statedType(local) : declaresVariable(enclosingBody(object), receiver) ? undefined : fieldType(object, receiver);
    }
    const head = type === undefined ? undefined : headOf(type);
    if (receiver === undefined || member === undefined || head === undefined) return [];
    return [{ line: invocation.startPosition.row + 1, column: invocation.startPosition.column + 1, receiver, member, holds: { kind: "annotated", type: head.text, line: head.startPosition.row + 1, column: head.startPosition.column + 1 } }];
  });
}

/** The class type a local, a parameter, a loop variable or a one-type catch variable states; none for `var` and varargs. */
function statedType(declaration: Node): Node | undefined {
  if (declaration.type === "variable_declarator") return declaration.parent?.type === "local_variable_declaration" ? declaration.parent.childForFieldName("type") ?? undefined : undefined;
  if (declaration.type === "formal_parameter" || declaration.type === "enhanced_for_statement") return declaration.childForFieldName("type") ?? undefined;
  if (declaration.type === "catch_formal_parameter") {
    const types = declaration.namedChildren.find((child) => child?.type === "catch_type")?.namedChildren ?? [];
    return types.length === 1 ? types[0] ?? undefined : undefined;
  }
  return undefined;
}

/** The first name of a class type: `Map` for `Map<K, V>` and for `Map.Entry`; none for `var`, a primitive or an array. */
function headOf(type: Node): Node | undefined {
  if (!CLASS_TYPES.has(type.type) || type.text === "var") return undefined;
  let head: Node | null = type;
  while (head !== null && head.type !== "type_identifier") head = head.namedChildren[0] ?? null;
  return head ?? undefined;
}

function isPrivate(field: Node): boolean {
  return field.namedChildren.find((child) => child?.type === "modifiers")?.children.some((modifier) => modifier?.type === "private") ?? false;
}
