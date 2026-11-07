import ts from "typescript";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import { sourceTree } from "./source-tree.ts";
import { hasSyntaxErrors } from "./syntax.ts";

/**
 * The lines no token of the parsed file touches. The parser's own tokens are read, never a bare scan, because a regular
 * expression and the text of a template after `${...}` are told apart from comments only in the parser's context.
 */
export function createTypeScriptTrivia(): SourceTrivia {
  return {
    triviaLines: async (file) => {
      if (!isTypeScriptSource(file.path)) return new Set();
      const tree = sourceTree(file, ts.ScriptTarget.Latest);
      if (hasSyntaxErrors(tree)) return new Set();
      const code = new Set<number>();
      const visit = (node: ts.Node): void => {
        if (ts.isJSDoc(node) || node.kind === ts.SyntaxKind.EndOfFileToken) return;
        const children = node.getChildren(tree);
        if (children.length > 0) return children.forEach(visit);
        const first = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
        const last = tree.getLineAndCharacterOfPosition(Math.max(node.getStart(tree), node.end - 1)).line;
        for (let line = first; line <= last; line += 1) code.add(line + 1);
      };
      visit(tree);
      const lines = tree.getLineStarts().length;
      return new Set(Array.from({ length: lines }, (_, index) => index + 1).filter((line) => !code.has(line)));
    },
  };
}
