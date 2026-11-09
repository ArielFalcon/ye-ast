import ts from "typescript";
import { TYPESCRIPT_PROFILE } from "../../domain/languages/profiles.ts";
import type { LineRange } from "../../domain/change/diff-reader.ts";
import type { SourceReading, Token } from "../../domain/change/source-tokens.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import { sourceTree } from "./source-tree.ts";
import { hasSyntaxErrors } from "./syntax.ts";

const REFERENCE_DIRECTIVE = /^\/\/\/\s*<reference\b/;
const TS_PRAGMA = /@ts-(?:expect-error|ignore|nocheck|check)\b/;
const BUNDLER_ANNOTATION = /[@#]__[A-Z0-9_]+__/;
const LINE_TERMINATOR = /[\r\n]/;

/**
 * The tokens of a TypeScript source from the compiler's parse: leaves except comments and JSDoc, plus the directives,
 * pragmas, bundler annotations and `import(...)` comments decision 2 keeps, plus one line-break token per multi-line gap.
 */
export function createTypeScriptTokens(): SourceTokens {
  return {
    tokensOf: async (file): Promise<SourceReading> => {
      const tree = sourceTree(file, ts.ScriptTarget.Latest);
      if (hasSyntaxErrors(tree)) return { status: "unread", reason: "unparsed" };
      const lineOf = (offset: number): number => tree.getLineAndCharacterOfPosition(offset).line + 1;
      const tokenAt = (start: number, end: number): Token => ({ start: lineOf(start), end: lineOf(Math.max(start, end - 1)), text: file.content.slice(start, end) });
      const imports: LineRange[] = [];
      const importArguments: LineRange[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)) imports.push({ start: lineOf(node.getStart(tree)), end: lineOf(node.end) });
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) importArguments.push({ start: node.arguments.pos, end: node.arguments.end });
        ts.forEachChild(node, visit);
      };
      visit(tree);
      const commentIsToken = (offset: number, text: string): boolean =>
        REFERENCE_DIRECTIVE.test(text) || TS_PRAGMA.test(text) || BUNDLER_ANNOTATION.test(text) || importArguments.some((range) => range.start <= offset && offset <= range.end);
      const offsets: { start: number; end: number }[] = [];
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, file.content);
      for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        if (kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
        const start = scanner.getTokenPos();
        if (commentIsToken(start, scanner.getTokenText())) offsets.push({ start, end: scanner.getTextPos() });
      }
      const leaves = (node: ts.Node): void => {
        if (ts.isJSDoc(node) || node.kind === ts.SyntaxKind.EndOfFileToken) return;
        const children = node.getChildren(tree);
        if (children.length > 0) {
          children.forEach(leaves);
          return;
        }
        offsets.push({ start: node.getStart(tree), end: node.end });
      };
      leaves(tree);
      offsets.sort((a, b) => a.start - b.start);
      const tokens: Token[] = [];
      let previous: { start: number; end: number } | undefined;
      for (const offset of offsets) {
        if (previous !== undefined) {
          const gap = file.content.slice(previous.end, offset.start);
          const terminator = gap.search(LINE_TERMINATOR);
          if (terminator >= 0) {
            const line = lineOf(previous.end + terminator);
            tokens.push({ start: line, end: line, text: "\n" });
          }
        }
        tokens.push(tokenAt(offset.start, offset.end));
        previous = offset;
      }
      return { status: "read", language: "typescript", tokens, imports, importOrder: TYPESCRIPT_PROFILE.importOrder };
    },
  };
}
