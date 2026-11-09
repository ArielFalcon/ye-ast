import assert from "node:assert/strict";
import test from "node:test";
import type { Token, TokenReading } from "./source-tokens.ts";
import { importDeclarationMultiset, importDeclarationsOf, tokenTexts, tokensIn, tokensInImports, tokensOutsideImports } from "./token-lines.ts";
import { triviaLinesOf } from "./token-lines.ts";

const token = (start: number, end: number, text: string, startOffset = 0, endOffset = 0): Token => ({ start, end, text, startOffset, endOffset });

const reading = (tokens: readonly Token[], imports: TokenReading["imports"] = []): TokenReading => ({ status: "read", language: "typescript", tokens, imports, importOrder: "significant" });

test("a line no token spans is trivia, and a token across a range edge counts whole", () => {
  const held = reading([token(1, 1, "a"), token(3, 5, "/*x*/"), token(6, 6, ";")]);
  assert.deepEqual([...triviaLinesOf(held, 7)].sort((a, b) => a - b), [2, 7]);
  assert.deepEqual(tokensIn(held, { start: 5, end: 6 }).map(({ text }) => text), ["/*x*/", ";"]);
});

test("import declarations are compared whole, and a token outside their spans is not an import token", () => {
  const held = reading(
    [
      token(3, 3, "import", 0, 6), token(3, 3, "a", 6, 7), token(3, 3, ";", 7, 8),
      token(4, 4, "import", 8, 14), token(4, 4, "b", 14, 15), token(4, 4, ";", 15, 16),
      token(6, 6, "x", 16, 17),
    ],
    [{ start: 0, end: 8 }, { start: 8, end: 16 }],
  );
  assert.deepEqual(importDeclarationsOf(held).map(tokenTexts), [["import", "a", ";"], ["import", "b", ";"]]);
  assert.deepEqual(importDeclarationMultiset(held), ["import\u0000a\u0000;", "import\u0000b\u0000;"]);
  assert.deepEqual(tokensInImports(held, { start: 3, end: 4 }).map(({ text }) => text), ["import", "a", ";", "import", "b", ";"]);
  assert.deepEqual(tokensOutsideImports(held, { start: 3, end: 6 }).map(({ text }) => text), ["x"]);

  const sharedLine = reading([token(1, 1, "import", 0, 6), token(1, 1, "x", 6, 7)], [{ start: 0, end: 6 }]);
  assert.deepEqual(tokensInImports(sharedLine, { start: 1, end: 1 }).map(({ text }) => text), ["import"]);
  assert.deepEqual(tokensOutsideImports(sharedLine, { start: 1, end: 1 }).map(({ text }) => text), ["x"]);
});
