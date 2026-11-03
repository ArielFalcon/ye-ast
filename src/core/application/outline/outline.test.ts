import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode } from "../impact/fake-code-graph.testing.ts";
import { readOutline } from "./outline.ts";

test("a file answers its declarations in line order with their spans, and a file the index does not hold is unheld", () => {
  const store = fakeCodeGraph(
    [
      fakeNode("Order.java", "file", "src/Order.java", 1, 40),
      fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total"),
      fakeNode("Order", "class", "src/Order.java", 3, 40, "Order"),
      fakeNode("Order.id", "field", "src/Order.java", 5, 5, "id"),
      fakeNode("java.util", "import", "src/Order.java", 1, 1, "java.util"),
    ],
    [],
  );
  const read = readOutline(store, ["src/Order.java", "src/Gone.java"]);
  assert.deepEqual(read.unheld, ["src/Gone.java"]);
  assert.deepEqual(read.files, [
    {
      file: "src/Order.java",
      declarations: [
        { kind: "class", name: "Order", line: 3, endLine: 40 },
        { kind: "field", name: "id", line: 5, endLine: 5 },
        { kind: "method", name: "total", line: 20, endLine: 24 },
      ],
      imports: [],
    },
  ]);
});

test("imports name the files the edges reach once each, never the file itself", () => {  const store = fakeCodeGraph(
    [
      fakeNode("a", "file", "src/a.ts", 1, 9),
      fakeNode("a.own", "function", "src/a.ts", 3, 7, "own"),
      fakeNode("b", "file", "src/b.ts", 1, 9),
      fakeNode("b.one", "function", "src/b.ts", 2, 4, "one"),
      fakeNode("c", "file", "src/c.ts", 1, 9),
    ],
    [
      { from: "a", to: "b", kind: "imports", line: 1 },
      { from: "a", to: "c", kind: "imports", line: 2 },
      { from: "a", to: "b", kind: "imports", line: 3 },
      { from: "a", to: "a.own", kind: "contains" },
    ],
  );
  const read = readOutline(store, ["src/a.ts"]);
  assert.deepEqual(read.files.map((file) => file.imports), [["src/b.ts", "src/c.ts"]]);
  assert.deepEqual(read.unheld, []);
});

test("an imports edge whose target the store does not know names no file", () => {
  const store = fakeCodeGraph(
    [fakeNode("a", "file", "src/a.ts", 1, 9), fakeNode("a.own", "function", "src/a.ts", 3, 7, "own")],
    [{ from: "a", to: "gone", kind: "imports", line: 1 }],
  );
  const read = readOutline(store, ["src/a.ts"]);
  assert.deepEqual(read.files.map((file) => file.imports), [[]]);
  assert.deepEqual(read.unheld, []);
});
