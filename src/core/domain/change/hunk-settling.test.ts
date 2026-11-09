import assert from "node:assert/strict";
import test from "node:test";
import type { Token, TokenReading } from "./source-tokens.ts";
import { settledOf } from "./hunk-settling.ts";

const token = (start: number, end: number, text: string, startOffset = 0, endOffset = 0): Token => ({ start, end, text, startOffset, endOffset });
/** One line's tokens, each one offset wide, starting at `from`. */
const at = (line: number, texts: readonly string[], from = 0): Token[] => texts.map((text, index) => token(line, line, text, from + index, from + index + 1));
const reading = (tokens: readonly Token[], imports: TokenReading["imports"] = [], importOrder: TokenReading["importOrder"] = "insignificant"): TokenReading => ({ status: "read", language: "java", tokens, imports, importOrder });
const IMPORTS = [...at(3, ["import", "a", ";"], 0), ...at(4, ["import", "b", ";"], 3)];
const IMPORT_RANGES = [{ start: 0, end: 3 }, { start: 3, end: 6 }];
const HUNK = { base: { start: 3, end: 4 }, head: { start: 3, end: 4 }, removedNames: [] };

test("a hunk whose base and head tokens are equal settles as no-token-change", () => {
  const base = reading([token(4, 4, "two"), token(4, 4, "("), token(4, 4, ")"), token(4, 4, ";")]);
  const head = reading([token(4, 4, "two"), token(4, 4, "("), token(4, 4, ")"), token(4, 4, ";")]);
  assert.deepEqual(settledOf(base, head, { base: { start: 4, end: 4 }, head: { start: 4, end: 4 }, removedNames: ["two"] }), { settled: "no-token-change" });
});

test("two swapped Java imports settle as import-order and a TypeScript swap does not", () => {
  const base = reading(IMPORTS, IMPORT_RANGES);
  const head = reading([...at(3, ["import", "b", ";"], 0), ...at(4, ["import", "a", ";"], 3)], IMPORT_RANGES);
  assert.deepEqual(settledOf(base, head, HUNK), { settled: "import-order" });
  assert.deepEqual(settledOf(base, { ...head, importOrder: "significant" }, HUNK), { settled: undefined });
});

test("two imports swapped across two separate hunks both settle", () => {
  const base = reading(IMPORTS, IMPORT_RANGES);
  const head = reading([...at(3, ["import", "b", ";"], 0), ...at(4, ["import", "a", ";"], 3)], IMPORT_RANGES);
  assert.deepEqual(settledOf(base, head, { base: { start: 3, end: 3 }, head: { start: 3, end: 3 }, removedNames: [] }), { settled: "import-order" });
  assert.deepEqual(settledOf(base, head, { base: { start: 4, end: 4 }, head: { start: 4, end: 4 }, removedNames: [] }), { settled: "import-order" });
});

test("an added import does not settle", () => {
  const base = reading(IMPORTS, IMPORT_RANGES);
  const head = reading([...at(3, ["import", "c", ";"], 0), ...at(4, ["import", "a", ";"], 3), ...at(5, ["import", "b", ";"], 6)], [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }]);
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

test("a hunk that moves an imported member between two static imports changes code, not import order", () => {
  const declarations = (first: string, second: string) => [...at(1, ["import", "static", "a", ".", "A", ".", first, ";"], 0), ...at(2, ["import", "static", "b", ".", "B", ".", second, ";"], 8)];
  const ranges = [{ start: 0, end: 8 }, { start: 8, end: 16 }];
  const base = reading(declarations("foo", "bar"), ranges);
  const head = reading(declarations("bar", "foo"), ranges);
  assert.deepEqual(settledOf(base, head, { base: { start: 1, end: 2 }, head: { start: 1, end: 2 }, removedNames: [] }), { settled: undefined });
});

test("a hunk that moves a named import's specifier between two modules changes code, not import order", () => {
  const declarations = (first: string, second: string) => [...at(1, ["import", "{", first, "}", "from", '"./x"', ";"], 0), ...at(2, ["import", "{", second, "}", "from", '"./y"', ";"], 7)];
  const ranges = [{ start: 0, end: 7 }, { start: 7, end: 14 }];
  const base = reading(declarations("a", "b"), ranges);
  const head = reading(declarations("b", "a"), ranges);
  assert.deepEqual(settledOf(base, head, { base: { start: 1, end: 2 }, head: { start: 1, end: 2 }, removedNames: [] }), { settled: undefined });
});

test("code that shares a line with a Java import is not an import token", () => {
  const code = (x: string, y: string) => [
    ...at(1, ["import", "java", ".", "util", ".", "List", ";"], 0),
    ...at(1, ["class", "C", "{", "int", "x", "=", x, ";", "int", "y", "=", y, ";", "}"], 7),
  ];
  const base = reading(code("1", "2"), [{ start: 0, end: 7 }]);
  const head = reading(code("2", "1"), [{ start: 0, end: 7 }]);
  assert.deepEqual(settledOf(base, head, { base: { start: 1, end: 1 }, head: { start: 1, end: 1 }, removedNames: [] }), { settled: undefined });
});

test("code that shares a line with a TypeScript import is not an import token", () => {
  const code = (x: string, y: string) => [
    ...at(1, ["import", "{", "a", "}", "from", '"./a"', ";"], 0),
    ...at(1, ["const", "x", "=", x, ";", "const", "y", "=", y, ";"], 7),
  ];
  const base = reading(code("1", "2"), [{ start: 0, end: 7 }], "insignificant");
  const head = reading(code("2", "1"), [{ start: 0, end: 7 }], "insignificant");
  assert.deepEqual(settledOf(base, head, { base: { start: 1, end: 1 }, head: { start: 1, end: 1 }, removedNames: [] }), { settled: undefined });
});

test("a file-wide swap of two whole imports still settles as import order", () => {
  const base = reading(IMPORTS, IMPORT_RANGES);
  const head = reading([...at(3, ["import", "b", ";"], 0), ...at(4, ["import", "a", ";"], 3)], IMPORT_RANGES);
  assert.deepEqual(settledOf(base, head, HUNK), { settled: "import-order" });
});
