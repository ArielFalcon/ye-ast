import type { Node } from "web-tree-sitter";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import { declaredVariablesOnce, declaresLocal, typeVariableAround } from "./java-declared-variables.ts";
import { enclosingBody, fieldsOf, isRecordComponent, localBinding, thisField } from "./java-function-value-calls.ts";

/** Types a declaration may state that name a class or an interface. */
const CLASS_TYPES: ReadonlySet<string> = new Set(["type_identifier", "scoped_type_identifier", "generic_type"]);
/** A call whose name says it reads or writes a field by reflection or through a handle. */
const REFLECTIVE = /Field|VarHandle|Getter|Setter/;

/**
 * The member calls of a Java tree whose receiver one declaration types: a bare `r` bound by `localBinding` (lambda
 * parameters first) to a parameter, a local or a loop or catch variable with a stated class type, or, when no variable of
 * the name is declared in the type body, to a field; `this.r` to a field. A field counts only when the enclosing type
 * body declares it once and `private`, and the file names it through no receiver but `this` and reads no field by
 * reflection; a record component is the private field it declares, never in a static context of its record. The binding
 * holds the type where it is written, by its first name (ADR-0029 decision 9).
 * `declaredFields` admits other fields for nominal repository-member selection, never external-leaf proof.
 * `includeUnproven` also retains annotation candidates marked unproven; they prove no receiver value. Both options scope
 * the shadowing variable to the method or constructor that declares it, so a constructor parameter named like its field
 * does not shadow the field in other methods.
 */
export function javaReceiverBindings(root: Node, { includeUnproven = false, declaredFields = false }: { includeUnproven?: boolean; declaredFields?: boolean } = {}): ReceiverBinding[] {
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
  const declaresVariable = (body: Node | undefined, name: string, at?: Node): boolean => body !== undefined && declaresLocal(declaredIn(body), name, at);

  const fieldType = (at: Node, name: string): { node: Node; unproven: boolean } | undefined => {
    const body = enclosingBody(at);
    const declared = body === undefined ? [] : fieldsOf(body).filter((declarator) => declarator.childForFieldName("name")?.text === name);
    const only = declared.length === 1 ? declared[0]! : undefined;
    const component = only !== undefined && isRecordComponent(only);
    if (component && inStaticContext(at, body!)) return undefined;
    const field = component ? only : only?.parent;
    if (field == null || (!component && field.type !== "field_declaration")) return undefined;
    const unproven = reflects || otherReceivers.has(name) || !(component || isPrivate(field));
    if (unproven && !includeUnproven && !declaredFields) return undefined;
    const node = field.childForFieldName("type");
    return node === null ? undefined : { node, unproven: unproven && !declaredFields };
  };

  return invocations.flatMap((invocation): ReceiverBinding[] => {
    const object = invocation.childForFieldName("object")!;
    const member = invocation.childForFieldName("name")?.text;
    let receiver: string | undefined;
    let type: Node | undefined;
    let unproven = false;
    const fieldAt = (at: Node, name: string) => {
      const held = fieldType(at, name);
      unproven = held?.unproven ?? false;
      return held?.node;
    };
    const field = thisField(object);
    if (field !== undefined) {
      receiver = field;
      type = fieldAt(object, field);
    } else if (object.type === "identifier") {
      receiver = object.text;
      const local = localBinding(object);
      if (local !== undefined) type = statedType(local);
      else {
        const shadowed = declaresVariable(enclosingBody(object), receiver, declaredFields || includeUnproven ? object : undefined);
        if (!shadowed || includeUnproven) {
          type = fieldAt(object, receiver);
          unproven ||= shadowed;
        }
      }
    }
    const head = type === undefined ? undefined : headOf(type);
    if (receiver === undefined || member === undefined || head === undefined) return [];
    const scoped = typeVariableAround(head) !== undefined;
    return [{ line: invocation.startPosition.row + 1, column: invocation.startPosition.column + 1, receiver, member, ...(unproven ? { unproven: true } : {}), holds: { kind: "annotated", type: head.text, line: head.startPosition.row + 1, column: head.startPosition.column + 1, ...(scoped ? { scoped: true } : {}) } }];
  });
}

/** The class type a local, a parameter, a loop variable or a one-type catch variable states; none for `var` and varargs. */
export function statedType(declaration: Node): Node | undefined {
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

/** Whether the use lies in a static method, initializer or field of its type body, where no instance field is in scope (JLS 8.1.3). */
function inStaticContext(at: Node, body: Node): boolean {
  for (let scope = at.parent; scope !== null && scope.id !== body.id; scope = scope.parent) {
    if (scope.type === "static_initializer") return true;
    if ((scope.type === "method_declaration" || scope.type === "field_declaration") && scope.namedChildren.find((child) => child?.type === "modifiers")?.children.some((modifier) => modifier?.type === "static")) return true;
  }
  return false;
}

function isPrivate(field: Node): boolean {
  return field.namedChildren.find((child) => child?.type === "modifiers")?.children.some((modifier) => modifier?.type === "private") ?? false;
}
