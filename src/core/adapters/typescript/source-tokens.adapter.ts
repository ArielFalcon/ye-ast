import ts from "typescript";
import { TYPESCRIPT_PROFILE } from "../../domain/languages/profiles.ts";
import type { ImportDeclarationRange, SourceReading, Token } from "../../domain/change/source-tokens.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import { sourceTree } from "./source-tree.ts";
import { hasSyntaxErrors } from "./syntax.ts";

const REFERENCE_DIRECTIVE = /^\/\/\/\s*<reference\b/;
const TS_PRAGMA = /@ts-(?:expect-error|ignore|nocheck|check)\b/;
const BUNDLER_ANNOTATION = /[@#]__[A-Z0-9_]+__/;
const LINE_TERMINATOR = /[\r\n]/;
const NOT_SPACE = /\S/;

interface Span {
  start: number;
  end: number;
}

interface CodeSpan extends Span {
  fullStart: number;
}

/**
 * The tokens of a TypeScript source from the compiler's parse: leaves except comments and JSDoc, plus the directives,
 * pragmas, bundler annotations and `import(...)` comments decision 2 keeps, plus one line-break token per multi-line gap.
 * Comments are read from the parse's token boundaries, so a template or a regular expression never hides one; a text the
 * parse does not account for, outside trivia, answers `unparsed`, never a reading that could settle.
 */
export function createTypeScriptTokens(): SourceTokens {
  return {
    tokensOf: async (file): Promise<SourceReading> => {
      const tree = sourceTree(file, ts.ScriptTarget.Latest);
      if (hasSyntaxErrors(tree)) return { status: "unread", reason: "unparsed" };
      const content = file.content;
      const lineOf = (offset: number): number => tree.getLineAndCharacterOfPosition(offset).line + 1;
      const imports: ImportDeclarationRange[] = [];
      const importArguments: Span[] = [];
      const collect = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)) imports.push({ start: node.getStart(tree), end: node.end });
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) importArguments.push({ start: node.arguments.pos, end: node.arguments.end });
        ts.forEachChild(node, collect);
      };
      collect(tree);
      const code: CodeSpan[] = [];
      const leaves = (node: ts.Node): void => {
        if (ts.isJSDoc(node)) return;
        const children = node.getChildren(tree);
        if (children.length > 0) {
          children.forEach(leaves);
          return;
        }
        if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
        const span = ts.isJsxText(node) ? { start: node.pos, end: node.end } : { start: node.getStart(tree), end: node.end };
        code.push({ ...span, fullStart: node.getFullStart() });
      };
      leaves(tree);
      code.sort((a, b) => a.start - b.start);
      const comments = commentsOf(content, tree, code);
      if (!covers(content, [...code, ...comments])) return { status: "unread", reason: "unparsed" };
      const kept = comments.filter((comment) => significant(content.slice(comment.start, comment.end), comment, importArguments));
      const spans = [...code, ...kept].toSorted((a, b) => a.start - b.start);
      const tokens: Token[] = [];
      let previous: Span | undefined;
      const tokenAt = (span: Span): Token => ({ start: lineOf(span.start), end: lineOf(Math.max(span.start, span.end - 1)), text: content.slice(span.start, span.end), startOffset: span.start, endOffset: span.end });
      for (const span of spans) {
        if (previous !== undefined) {
          const gap = content.slice(previous.end, span.start);
          const terminator = gap.search(LINE_TERMINATOR);
          if (terminator >= 0) {
            const line = lineOf(previous.end + terminator);
            tokens.push({ start: line, end: line, text: "\n", startOffset: previous.end, endOffset: span.start });
          }
        }
        tokens.push(tokenAt(span));
        previous = span;
      }
      return { status: "read", language: "typescript", tokens, imports, importOrder: TYPESCRIPT_PROFILE.importOrder };
    },
  };
}

/** Every comment of the parse, read at each token's full start and end, the file's end included. */
function commentsOf(content: string, tree: ts.SourceFile, code: readonly CodeSpan[]): Span[] {
  const comments = new Map<number, Span>();
  const add = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) comments.set(range.pos, { start: range.pos, end: range.end });
  };
  for (const token of code) add(ts.getLeadingCommentRanges(content, token.fullStart));
  for (const token of code) add(ts.getTrailingCommentRanges(content, token.end));
  add(ts.getLeadingCommentRanges(content, tree.endOfFileToken.getFullStart()));
  return [...comments.values()];
}

function significant(text: string, comment: Span, importArguments: readonly Span[]): boolean {
  return REFERENCE_DIRECTIVE.test(text) || TS_PRAGMA.test(text) || BUNDLER_ANNOTATION.test(text) || importArguments.some((range) => comment.start >= range.start && comment.end <= range.end);
}

/** Whether every non-whitespace character of `text` falls inside `spans`. */
function covers(text: string, spans: readonly Span[]): boolean {
  let at = 0;
  for (const span of spans.toSorted((a, b) => a.start - b.start)) {
    if (span.start > at && NOT_SPACE.test(text.slice(at, span.start))) return false;
    at = Math.max(at, span.end);
  }
  return !NOT_SPACE.test(text.slice(at));
}
