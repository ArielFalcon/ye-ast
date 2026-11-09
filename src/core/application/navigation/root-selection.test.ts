import assert from "node:assert/strict";
import test from "node:test";
import type { SourceReading } from "../../domain/change/source-tokens.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";
import { rangeChanges, requestedRanges, selectRoots } from "./root-selection.ts";
import type { RawUnknownEntry } from "./snapshot-files.ts";
import type { SnapshotFiles } from "./snapshot-files.ts";

const FILE = "src/A.java";
const TS_FILE = "src/a.ts";
const SOURCE = ["package a;", "", "", "class A {", "  void one() {}", "  // between members", "  /** doc */", "  void two() {}", "}", ""].join("\n");
const NODES = [fakeNode("A", "class", FILE, 4, 9), fakeNode("A.one", "method", FILE, 5, 5, "one"), fakeNode("A.two", "method", FILE, 8, 8, "two")];

function tokens(quiet: Readonly<Record<string, readonly number[]>>): SourceTokens {
  return {
    tokensOf: async (file): Promise<SourceReading> => {
      const lines = file.content.split("\n").length;
      const quietLines = new Set(quiet[file.path] ?? []);
      return { status: "read", language: file.path.endsWith(".ts") ? "typescript" : "java", tokens: Array.from({ length: lines }, (_, index) => index + 1).filter((line) => !quietLines.has(line)).map((line) => ({ start: line, end: line, text: `t${line}`, startOffset: 0, endOffset: 0 })), imports: [], importOrder: file.path.endsWith(".ts") ? "significant" : "insignificant" };
    },
  };
}

const snapshot: SnapshotFiles = { holds: (path) => path === FILE || path === TS_FILE, describe: (entries: readonly RawUnknownEntry[]) => entries.map((entry) => ({ ...entry, absent: false })) };

async function ranges(start: number, end: number, file = FILE, content = SOURCE, quiet: Readonly<Record<string, readonly number[]>> = { [FILE]: [6] }, nodes = NODES) {
  const store = fakeCodeGraph(nodes, []);
  return { store, read: await requestedRanges(store, rangeChanges([{ file, start, end }]), [{ path: file, content }], tokens(quiet), snapshot) };
}

test("a range over a token line inside a class selects it, and a range over trivia alone settles with the file's candidates", async () => {
  const control = await ranges(6, 7, FILE, SOURCE, { [FILE]: [6] });
  assert.deepEqual(control.read.settled, []);
  assert.deepEqual(control.read.changes[0]?.added, [{ start: 7, end: 7 }]);
  assert.deepEqual(selectRoots(control.store, control.read.changes, [], new Map(), control.read.uncovered, undefined, control.read.settled).seeds.map(({ symbol }) => symbol.name), ["A"]);

  const trivia = await ranges(6, 7, FILE, SOURCE, { [FILE]: [6, 7] });
  assert.deepEqual(trivia.read.settled, [{ file: FILE, start: 6, end: 7, candidates: ["A", "one", "two"] }]);
  assert.deepEqual(trivia.read.changes[0]?.added, []);
  const selection = selectRoots(trivia.store, trivia.read.changes, [], new Map(), trivia.read.uncovered, undefined, trivia.read.settled);
  assert.deepEqual(selection.seeds, []);
  assert.deepEqual(selection.missing, []);
  assert.deepEqual(selection.settled, trivia.read.settled);
});

test("a range over trivia outside every declaration answers successfully", async () => {
  const { read, store } = await ranges(2, 3, FILE, SOURCE, { [FILE]: [2, 3, 6] });
  assert.deepEqual(read.settled, [{ file: FILE, start: 2, end: 3, candidates: ["A", "one", "two"] }]);
  assert.deepEqual(read.uncovered, []);
  const selection = selectRoots(store, read.changes, [], new Map(), read.uncovered, undefined, read.settled);
  assert.deepEqual(selection.missing, []);
  assert.deepEqual(selection.seeds, []);
});

test("a range wholly past the end of its file stays uncovered", async () => {
  const { read } = await ranges(900, 901);
  assert.deepEqual(read.settled, []);
  assert.deepEqual(read.uncovered, [{ file: FILE, start: 900, end: 901, candidates: ["A", "one", "two"] }]);
});

test("a range over a Java doc comment selects the class, while the same over a TypeScript JSDoc settles", async () => {
  const doc = await ranges(7, 7);
  assert.deepEqual(doc.read.settled, []);
  assert.deepEqual(doc.read.changes[0]?.added, [{ start: 7, end: 7 }]);

  const tsSource = ["class A {", "  one() {}", "  /** doc */", "  two() {}", "}", ""].join("\n");
  const tsNodes = [fakeNode("A", "class", TS_FILE, 1, 5), fakeNode("A.one", "method", TS_FILE, 2, 2, "one"), fakeNode("A.two", "method", TS_FILE, 4, 4, "two")];
  const ts = await ranges(3, 3, TS_FILE, tsSource, { [TS_FILE]: [3] }, tsNodes);
  assert.deepEqual(ts.read.settled, [{ file: TS_FILE, start: 3, end: 3, candidates: ["A", "one", "two"] }]);
});

test("a range mixing a trivia line and a token line selects through the token line only", async () => {
  const { read } = await ranges(6, 8, FILE, SOURCE, { [FILE]: [6] });
  assert.deepEqual(read.settled, []);
  assert.deepEqual(read.changes[0]?.added, [{ start: 7, end: 8 }]);
});
