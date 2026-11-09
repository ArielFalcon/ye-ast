import assert from "node:assert/strict";
import test from "node:test";
import type { Token, TokenReading } from "./source-tokens.ts";
import { settledOf } from "./hunk-settling.ts";

const token = (start: number, end: number, text: string): Token => ({ start, end, text });
const reading = (tokens: readonly Token[], imports: TokenReading["imports"] = [], importOrder: TokenReading["importOrder"] = "insignificant"): TokenReading => ({ status: "read", language: "java", tokens, imports, importOrder });
const IMPORTS = [token(3, 3, "import"), token(3, 3, "a"), token(3, 3, ";"), token(4, 4, "import"), token(4, 4, "b"), token(4, 4, ";")];

test("a hunk whose base and head tokens are equal settles as no-token-change", () => {
  const base = reading([token(4, 4, "two"), token(4, 4, "("), token(4, 4, ")"), token(4, 4, ";")]);
  const head = reading([token(4, 4, "two"), token(4, 4, "("), token(4, 4, ")"), token(4, 4, ";")]);
  assert.deepEqual(settledOf(base, head, { base: { start: 4, end: 4 }, head: { start: 4, end: 4 }, removedNames: ["two"] }), { settled: "no-token-change" });
});

test("two swapped Java imports settle as import-order and a TypeScript swap does not", () => {
  const base = reading(IMPORTS, [{ start: 3, end: 3 }, { start: 4, end: 4 }]);
  const head = reading([token(3, 3, "import"), token(3, 3, "b"), token(3, 3, ";"), token(4, 4, "import"), token(4, 4, "a"), token(4, 4, ";")], [{ start: 3, end: 3 }, { start: 4, end: 4 }]);
  const hunk = { base: { start: 3, end: 4 }, head: { start: 3, end: 4 }, removedNames: [] };
  assert.deepEqual(settledOf(base, head, hunk), { settled: "import-order" });
  assert.deepEqual(settledOf(base, { ...head, importOrder: "significant" }, hunk), { settled: undefined });
});

test("two imports swapped across two separate hunks both settle", () => {
  const base = reading(IMPORTS, [{ start: 3, end: 3 }, { start: 4, end: 4 }]);
  const head = reading([token(3, 3, "import"), token(3, 3, "b"), token(3, 3, ";"), token(4, 4, "import"), token(4, 4, "a"), token(4, 4, ";")], [{ start: 3, end: 3 }, { start: 4, end: 4 }]);
  assert.deepEqual(settledOf(base, head, { base: { start: 3, end: 3 }, head: { start: 3, end: 3 }, removedNames: [] }), { settled: "import-order" });
  assert.deepEqual(settledOf(base, head, { base: { start: 4, end: 4 }, head: { start: 4, end: 4 }, removedNames: [] }), { settled: "import-order" });
});

test("an added import does not settle", () => {
  const base = reading(IMPORTS, [{ start: 3, end: 3 }, { start: 4, end: 4 }]);
  const swapped = [token(3, 3, "import"), token(3, 3, "b"), token(3, 3, ";"), token(4, 4, "import"), token(4, 4, "a"), token(4, 4, ";")];
  const head = reading([...swapped, token(5, 5, "import"), token(5, 5, "c"), token(5, 5, ";")], [{ start: 3, end: 3 }, { start: 4, end: 4 }, { start: 5, end: 5 }]);
  assert.deepEqual(settledOf(base, head, { base: { start: 3, end: 3 }, head: { start: 3, end: 3 }, removedNames: [] }), { settled: undefined });
});

test("a token across the hunk's edge counts whole, so a re-wrapped call still settles", () => {
  const base = reading([token(3, 4, "call("), token(4, 4, "a"), token(4, 4, ");")]);
  const head = reading([token(3, 3, "call("), token(4, 4, "a"), token(4, 4, ");")]);
  assert.deepEqual(settledOf(base, head, { base: { start: 4, end: 4 }, head: { start: 3, end: 4 }, removedNames: [] }), { settled: "no-token-change" });
});

test("an unread side or a hunk with one side keeps today's line rules", () => {
  const read = reading([token(1, 1, "a")]);
  assert.deepEqual(settledOf(read, { status: "unread", reason: "unparsed" }, { base: { start: 1, end: 1 }, head: { start: 1, end: 1 }, removedNames: [] }), { settled: undefined });
  assert.deepEqual(settledOf(read, read, { head: { start: 1, end: 1 }, removedNames: [] }), { settled: undefined });
});
