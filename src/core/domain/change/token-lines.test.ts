import assert from "node:assert/strict";
import test from "node:test";
import type { Token, TokenReading } from "./source-tokens.ts";
import { importTokensOf, tokenMultiset, tokensIn, tokensInImports, tokensOutsideImports } from "./token-lines.ts";
import { triviaLinesOf } from "./token-lines.ts";

const token = (start: number, end: number, text: string): Token => ({ start, end, text });

const reading = (tokens: readonly Token[], imports: TokenReading["imports"] = []): TokenReading => ({ status: "read", language: "typescript", tokens, imports, importOrder: "significant" });

test("a line no token spans is trivia, and a token across a range edge counts whole", () => {
  const held = reading([token(1, 1, "a"), token(3, 5, "/*x*/"), token(6, 6, ";")]);
  assert.deepEqual([...triviaLinesOf(held, 7)].sort((a, b) => a - b), [2, 7]);
  assert.deepEqual(tokensIn(held, { start: 5, end: 6 }).map(({ text }) => text), ["/*x*/", ";"]);
});

test("import tokens are the ones the import declarations cover", () => {
  const held = reading(
    [token(3, 3, "import"), token(3, 3, "a"), token(3, 3, ";"), token(4, 4, "import"), token(4, 4, "b"), token(4, 4, ";"), token(6, 6, "x")],
    [{ start: 3, end: 3 }, { start: 4, end: 4 }],
  );
  assert.deepEqual(importTokensOf(held).map(({ text }) => text), ["import", "a", ";", "import", "b", ";"]);
  assert.deepEqual(tokensInImports(held, { start: 3, end: 4 }), importTokensOf(held));
  assert.deepEqual(tokensOutsideImports(held, { start: 3, end: 6 }).map(({ text }) => text), ["x"]);
  assert.deepEqual(tokenMultiset(importTokensOf(held)), [";", ";", "a", "b", "import", "import"]);
});
