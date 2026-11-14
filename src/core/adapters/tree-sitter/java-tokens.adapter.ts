import type { Node } from "web-tree-sitter";
import { JAVA_PROFILE } from "../../domain/languages/profiles.ts";
import type { ImportBinding, ImportDeclarationRange, SourceReading, Token } from "../../domain/change/source-tokens.ts";
import { lfLineIndex } from "../../domain/change/source-tokens.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser } from "./java-parser.adapter.ts";

const LINE_COMMENT = "line_comment";
const BLOCK_COMMENT = "block_comment";
const IMPORT_DECLARATION = "import_declaration";
const UNICODE_ESCAPE = "\\u";
const MARKDOWN_DOC_COMMENT = "///";
const BLOCK_DOC_COMMENT = "/**";

/** The tokens of a Java source from its tree-sitter parse, with the doc comments and escaped comments decision 2 keeps as tokens. */
export function createJavaTokens(createParser: () => Promise<JavaParser>): SourceTokens {
  let parser: Promise<JavaParser> | undefined;
  return {
    tokensOf: async (file): Promise<SourceReading> => {
      parser ??= createParser();
      const parsed = (await parser).parse(file);
      if (!parsed.ok) return { status: "unread", reason: "unparsed" };
      const tokens: Token[] = [];
      const imports: ImportDeclarationRange[] = [];
      const lineOf = lfLineIndex(file.content);
      const tokenOf = (text: string, first: Node, last: Node): Token => ({ start: lineOf(first.startIndex), end: lineOf(Math.max(first.startIndex, last.endIndex - 1)), text, startOffset: first.startIndex, endOffset: last.endIndex });
      const sourceText = (first: Node, last: Node): string => file.content.slice(first.startIndex, last.endIndex);
      const visit = (node: Node): void => {
        if (node.type === IMPORT_DECLARATION) imports.push({ start: node.startIndex, end: node.endIndex, ...bindsOf(node) });
        if (node.childCount === 0) {
          tokens.push(tokenOf(sourceText(node, node), node, node));
          return;
        }
        const children = node.children.filter((child): child is Node => child !== null);
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index]!;
          if (child.type === LINE_COMMENT && child.text.startsWith(MARKDOWN_DOC_COMMENT)) {
            let last = child;
            while (children[index + 1]?.type === LINE_COMMENT && children[index + 1]!.text.startsWith(MARKDOWN_DOC_COMMENT) && children[index + 1]!.startPosition.row === last.endPosition.row + 1) {
              index += 1;
              last = children[index]!;
            }
            tokens.push(tokenOf(sourceText(child, last), child, last));
            continue;
          }
          if (child.type === LINE_COMMENT || child.type === BLOCK_COMMENT) {
            if (child.text.startsWith(BLOCK_DOC_COMMENT) || child.text.includes(UNICODE_ESCAPE)) tokens.push(tokenOf(child.text, child, child));
            continue;
          }
          visit(child);
        }
      };
      try {
        visit(parsed.value.root);
      } finally {
        parsed.value.dispose();
      }
      return { status: "read", language: "java", tokens, imports, importOrder: JAVA_PROFILE.importOrder };
    },
  };
}

/** The one name a single-type or single-static import binds; a wildcard binds none a reading can list. */
function bindsOf(declaration: Node): { binds: ImportBinding[] } | undefined {
  const children = declaration.children.filter((child): child is Node => child !== null);
  const qualified = children.find((child) => child.type === "scoped_identifier" || child.type === "identifier");
  if (qualified === undefined || children.some((child) => child.type === "asterisk")) return undefined;
  const name = qualified.childForFieldName("name") ?? qualified;
  const source = `${children.some((child) => child.type === "static") ? "static " : ""}${qualified.text.replace(/\s+/g, "")}`;
  return { binds: [{ name: name.text, source }] };
}
