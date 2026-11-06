import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "../impact/fake-code-graph.testing.ts";
import { createInboundEdges } from "../impact/inbound-edges.ts";
import { callersOfFunction } from "./consumer-callers.ts";

const FIND = { file: "src/owner.service.ts", symbol: "find", line: 8 };

function callersOf(nodes: FakeNode[], edges: FakeEdge[], declaration = FIND) {
  const store = fakeCodeGraph(nodes, edges);
  return callersOfFunction(store, createInboundEdges(store, () => false, []), declaration);
}

const find = () => fakeNode("find", "method", "src/owner.service.ts", 8, 14, "find");

test("a certain call with its line is a proven caller", () => {
  const answer = callersOf([find(), fakeNode("load", "method", "src/page.ts", 20, 30, "load")], [{ from: "load", to: "find", kind: "calls", line: 25 }]);

  assert.deepEqual(answer, { kind: "found", callers: [{ file: "src/page.ts", line: 20, lines: [25], proven: true }] });
});

test("a heuristic edge is a caller that is not proven, and an edge without a position has no line", () => {
  const nodes = [find(), fakeNode("a", "method", "src/a.ts", 1, 9), fakeNode("b", "method", "src/b.ts", 1, 9)];
  const edges = [{ from: "a", to: "find", kind: "calls", line: 4, provenance: "heuristic" as const }, { from: "b", to: "find", kind: "calls" }];

  const answer = callersOf(nodes, edges);

  assert.deepEqual(answer, {
    kind: "found",
    callers: [
      { file: "src/a.ts", line: 1, lines: [4], proven: false },
      { file: "src/b.ts", line: 1, lines: [], proven: true },
    ],
  });
});

test("a function that only names the function is a caller that is not proven", () => {
  const answer = callersOf([find(), fakeNode("use", "method", "src/page.ts", 20, 30, "use")], [{ from: "use", to: "find", kind: "references", line: 25 }]);

  assert.deepEqual(answer, { kind: "found", callers: [{ file: "src/page.ts", line: 20, lines: [25], proven: false }] });
});

test("a function nothing calls has no callers, and one the graph does not know is unresolved", () => {
  assert.deepEqual(callersOf([find()], []), { kind: "found", callers: [] });
  assert.deepEqual(callersOf([find()], [], { ...FIND, symbol: "ghost" }), { kind: "unresolved" });
});

test("a repository without a graph has no callers to give", () => {
  assert.deepEqual(callersOfFunction(undefined, undefined, FIND), { kind: "unavailable" });
});
