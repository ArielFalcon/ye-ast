import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "../navigation/fake-code-graph.testing.ts";
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

  assert.deepEqual(answer, { kind: "found", callers: [{ file: "src/page.ts", line: 20, at: 25, kind: "call", provenance: "resolved", confidence: 1, proven: true }] });
});

test("a heuristic edge is a caller that is not proven, and an edge without a position has no line", () => {
  const nodes = [find(), fakeNode("a", "method", "src/a.ts", 1, 9), fakeNode("b", "method", "src/b.ts", 1, 9)];
  const edges = [{ from: "a", to: "find", kind: "calls", line: 4, provenance: "heuristic" as const }, { from: "b", to: "find", kind: "calls" }];

  const answer = callersOf(nodes, edges);

  assert.deepEqual(answer, {
    kind: "found",
    callers: [
      { file: "src/a.ts", line: 1, at: 4, kind: "call", provenance: "heuristic", confidence: 0.3, proven: false },
      { file: "src/b.ts", line: 1, kind: "call", provenance: "resolved", confidence: 1, proven: true },
    ],
  });
});

test("a function that only names the function is a caller that is not proven", () => {
  const answer = callersOf([find(), fakeNode("use", "method", "src/page.ts", 20, 30, "use")], [{ from: "use", to: "find", kind: "references", line: 25 }]);

  assert.deepEqual(answer, { kind: "found", callers: [{ file: "src/page.ts", line: 20, at: 25, kind: "reference", provenance: "resolved", confidence: 1, proven: false }] });
});

test("a function nothing calls has no callers, and one the graph does not know is unresolved", () => {
  assert.deepEqual(callersOf([find()], []), { kind: "found", callers: [] });
  assert.deepEqual(callersOf([find()], [], { ...FIND, symbol: "ghost" }), { kind: "unresolved" });
});

test("a repository without a graph has no callers to give", () => {
  assert.deepEqual(callersOfFunction(undefined, undefined, FIND), { kind: "unavailable" });
});

test("every call occurrence of one caller is kept, so a weaker one beside a certain one has its own place", () => {
  const nodes = [find(), fakeNode("load", "method", "src/page.ts", 20, 30, "load")];
  const edges: FakeEdge[] = [
    { from: "load", to: "find", kind: "calls", line: 25 },
    { from: "load", to: "find", kind: "calls", line: 27, provenance: "heuristic", confidence: 0.8 },
  ];

  const answer = callersOf(nodes, edges);

  assert.ok(answer.kind === "found");
  assert.equal(answer.callers.length, 2);
  assert.deepEqual(answer.callers.map((caller) => [caller.at, caller.proven, caller.provenance, caller.confidence]), [
    [25, true, "resolved", 1],
    [27, false, "heuristic", 0.8],
  ]);
});
