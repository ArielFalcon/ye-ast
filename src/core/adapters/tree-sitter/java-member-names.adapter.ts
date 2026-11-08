import type { Node } from "web-tree-sitter";
import { compareText } from "../../domain/shared/code-node.ts";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { DeclaredCallable, DeclaredMemberNames, DeclaredMemberNamesReader, FunctionValueCall, ReceiverBinding, SyntaxCall } from "../../ports/declared-member-names.port.ts";
import { isFunctionValueNode, javaFunctionValueCalls } from "./java-function-value-calls.ts";
import type { SourceSpan } from "../../domain/trace/owning-body.ts";
import { javaReceiverBindings } from "./java-receiver-bindings.ts";
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
      const parsed = (await parser).parse(file);
      if (!parsed.ok) return NONE;
      const names = new Set<string>();
      const callables: DeclaredCallable[] = [];
      const calls: SyntaxCall[] = [];
      const owners: SyntaxCall["owners"][number][] = [];
      const nameOf = (node: Node): void => {
        const name = node.childForFieldName("name");
        if (name !== null) names.add(name.text);
      };
      const functionValues: SourceSpan[] = [];
      const visit = (node: Node): void => {
        const functionValue = isFunctionValueNode(node) || isAnonymousClassBody(node);
        if (functionValue) functionValues.push({ start: { line: node.startPosition.row + 1, column: node.startPosition.column }, end: { line: node.endPosition.row + 1, column: node.endPosition.column } });
        const ownerName = ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "method_declaration", "constructor_declaration", "compact_constructor_declaration"].includes(node.type) || (node.type === "variable_declarator" && MEMBER_FIELDS.includes(node.parent?.type ?? "")) ? node.childForFieldName("name") : null;
        const owns = ownerName !== null || functionValue;
        if (owns) owners.push({ name: ownerName?.text ?? "", start: node.startPosition.row + 1, nameLine: (ownerName ?? node).startPosition.row + 1, nameColumn: (ownerName ?? node).startPosition.column, startColumn: node.startPosition.column, endLine: node.endPosition.row + 1, endColumn: node.endPosition.column });
        if (node.type === "method_invocation" || node.type === "object_creation_expression" || node.type === "explicit_constructor_invocation") {
          const argumentsNode = node.childForFieldName("arguments");
          const type = node.childForFieldName("type");
          const callee = node.childForFieldName("name")?.text ?? (type?.type === "generic_type" ? type.namedChildren[0]?.text : type?.text)?.split(".").at(-1);
          const anchors = [];
          let at: Node | null = node;
          while (at !== null && !["method_declaration", "constructor_declaration", "class_body", "block", "lambda_expression"].includes(at.type)) {
            anchors.push({ line: at.startPosition.row + 1, column: at.startPosition.column + 1 });
            at = at.parent;
          }
          const named = node.childForFieldName("name") ?? type;
          if (named !== null) anchors.push({ line: named.startPosition.row + 1, column: named.startPosition.column + 1 });
          calls.push({ anchors, kind: node.type === "object_creation_expression" ? "instantiates" : "calls", ...(callee === undefined ? {} : { callee }), line: node.startPosition.row + 1, column: node.startPosition.column + 1, name: node.type === "object_creation_expression" ? (type?.type === "generic_type" ? type.namedChildren[0]?.text : type?.text) ?? "new" : file.content.slice(node.startIndex, argumentsNode?.startIndex ?? node.endIndex).trim(), owners: [...owners] });
        }
        if (node.type === "variable_declarator" ? MEMBER_FIELDS.includes(node.parent?.type ?? "") : NAMED.includes(node.type)) nameOf(node);
        if (node.type === "method_declaration" || node.type === "constructor_declaration" || node.type === "compact_constructor_declaration") {
          const name = node.childForFieldName("name");
          const modifiers = node.namedChildren.find((child) => child?.type === "modifiers")?.children ?? [];
          if (name !== null) callables.push({ ...(node.type === "method_declaration" ? {} : { construction: true as const }), name: name.text, start: node.startPosition.row + 1, nameLine: name.startPosition.row + 1, body: node.childForFieldName("body") !== null, overridable: node.type === "method_declaration" && !modifiers.some((modifier) => FIXED.includes(modifier?.type ?? "")) });
        }
        if (node.type === "record_declaration") for (const component of node.childForFieldName("parameters")?.namedChildren ?? []) if (component?.type === "formal_parameter") nameOf(component);
        for (const child of node.namedChildren) if (child !== null) visit(child);
        if (owns) owners.pop();
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
      return { names: [...names].sort(compareText), functionValueCalls, callables, receiverBindings, calls, functionValues };
    },
  };
}

/** The body of a class a `new` expression declares in place: its methods run only when something calls them. */
function isAnonymousClassBody(node: Node): boolean {
  return node.type === "class_body" && node.parent?.type === "object_creation_expression";
}
