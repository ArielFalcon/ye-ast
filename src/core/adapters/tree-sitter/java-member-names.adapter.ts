import type { Node } from "web-tree-sitter";
import { compareText } from "../../domain/shared/code-node.ts";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { DeclaredCallable, DeclaredMemberNames, DeclaredMemberNamesReader, FunctionValueCall } from "../../ports/declared-member-names.port.ts";
import { isFunctionValueNode, javaFunctionValueCalls } from "./java-function-value-calls.ts";
import type { SourceSpan } from "../../domain/trace/owning-body.ts";
import { javaReceiverBindings } from "./java-receiver-bindings.ts";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { JavaParser } from "./java-parser.adapter.ts";

const NONE: DeclaredMemberNames = { names: [], functionValueCalls: [], callables: [], receiverBindings: [], functionValues: [] };
/** Modifiers that keep a subtype from overriding a method. */
const FIXED: readonly string[] = ["static", "private", "final"];

/** Nodes that declare one name under their `name` field. */
const NAMED: readonly string[] = ["method_declaration", "enum_constant", "variable_declarator"];
/** Nodes whose `variable_declarator` children are members, not locals. */
const MEMBER_FIELDS: readonly string[] = ["field_declaration", "constant_declaration"];

/**
 * The member names a Java source declares: the methods and fields of every type, local and anonymous classes included,
 * enum constants, and a record's components, which name its accessors; every method as a callable; and the member calls
 * whose receiver one declaration types (`javaReceiverBindings`). The tree is freed before they return.
 */
export function createJavaMemberNames(createParser: () => Promise<JavaParser>): DeclaredMemberNamesReader {
  let parser: Promise<JavaParser> | undefined;
  return {
    memberNames: async (file) => {
      if (!isJavaSource(file.path)) return NONE;
      parser ??= createParser();
      const parsed = (await parser).parse(file.content);
      if (!parsed.ok) return NONE;
      const names = new Set<string>();
      const callables: DeclaredCallable[] = [];
      const nameOf = (node: Node): void => {
        const name = node.childForFieldName("name");
        if (name !== null) names.add(name.text);
      };
      const functionValues: SourceSpan[] = [];
      const visit = (node: Node): void => {
        if (isFunctionValueNode(node) || isAnonymousClassBody(node)) functionValues.push({ start: { line: node.startPosition.row + 1, column: node.startPosition.column }, end: { line: node.endPosition.row + 1, column: node.endPosition.column } });
        if (node.type === "variable_declarator" ? MEMBER_FIELDS.includes(node.parent?.type ?? "") : NAMED.includes(node.type)) nameOf(node);
        if (node.type === "method_declaration") {
          const name = node.childForFieldName("name");
          const modifiers = node.namedChildren.find((child) => child?.type === "modifiers")?.children ?? [];
          if (name !== null) callables.push({ name: name.text, start: node.startPosition.row + 1, nameLine: name.startPosition.row + 1, body: node.childForFieldName("body") !== null, overridable: !modifiers.some((modifier) => FIXED.includes(modifier?.type ?? "")) });
        }
        if (node.type === "record_declaration") for (const component of node.childForFieldName("parameters")?.namedChildren ?? []) if (component?.type === "formal_parameter") nameOf(component);
        for (const child of node.namedChildren) if (child !== null) visit(child);
      };
      let functionValueCalls: FunctionValueCall[];
      let receiverBindings: ReceiverBinding[];
      try {
        visit(parsed.value.root);
        functionValueCalls = javaFunctionValueCalls(parsed.value.root);
        receiverBindings = javaReceiverBindings(parsed.value.root);
      } finally {
        parsed.value.dispose();
      }
      return { names: [...names].sort(compareText), functionValueCalls, callables, receiverBindings, functionValues };
    },
  };
}

/** The body of a class a `new` expression declares in place: its methods run only when something calls them. */
function isAnonymousClassBody(node: Node): boolean {
  return node.type === "class_body" && node.parent?.type === "object_creation_expression";
}
