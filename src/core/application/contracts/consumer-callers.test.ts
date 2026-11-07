import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "../navigation/fake-code-graph.testing.ts";
import { relation } from "../../domain/relations/relation.ts";
import { createInboundEdges } from "../impact/inbound-edges.ts";
import { callersOfFunction, occurrencesOfMember } from "./consumer-callers.ts";

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

const MEMBER = { file: "src/svc.ts", owner: "Svc", member: "items" };

function occurrencesOf(nodes: FakeNode[], edges: FakeEdge[], member = MEMBER) {
  const store = fakeCodeGraph(
    [fakeNode("Svc", "class", "src/svc.ts", 1, 30), fakeNode("items", "property", "src/svc.ts", 5, 5, "items"), ...nodes],
    [{ from: "Svc", to: "items", kind: "contains" }, ...edges],
  );
  return occurrencesOfMember(store, createInboundEdges(store, () => false, []), member);
}

test("a member read gets the receiver the graph resolved: this in the owner and its subtypes, injected elsewhere, other for a guess", () => {
  const nodes = [
    fakeNode("own", "method", "src/svc.ts", 10, 12, "own"),
    fakeNode("Sub", "class", "src/sub.ts", 1, 20),
    fakeNode("inSub", "method", "src/sub.ts", 5, 8, "inSub"),
    fakeNode("page", "method", "src/page.ts", 20, 30, "page"),
    fakeNode("guess", "method", "src/guess.ts", 1, 9, "guess"),
  ];
  const edges: FakeEdge[] = [
    { from: "Sub", to: "Svc", kind: "extends" },
    { from: "own", to: "items", kind: "calls", line: 11 },
    { from: "inSub", to: "items", kind: "calls", line: 6 },
    { from: "page", to: "items", kind: "calls", line: 25 },
    { from: "guess", to: "items", kind: "calls", line: 4, provenance: "heuristic" },
  ];

  const answer = occurrencesOf(nodes, edges);

  assert.deepEqual(answer, {
    kind: "found",
    occurrences: [
      { file: "src/guess.ts", line: 4, column: 1, receiver: "other" },
      { file: "src/page.ts", line: 25, column: 1, receiver: "injected" },
      { file: "src/sub.ts", line: 6, column: 1, receiver: "this" },
      { file: "src/svc.ts", line: 11, column: 1, receiver: "this" },
    ],
  });
});

test("a class that injects the owner or a subtype of it, and names the member through a field, is a candidate read the graph's own edges do not list", () => {
  const nodes = [fakeNode("Sub", "class", "src/sub.ts", 1, 20), fakeNode("Page", "class", "src/page.ts", 1, 30), fakeNode("Elsewhere", "class", "src/else.ts", 1, 30)];
  const store = fakeCodeGraph(
    [fakeNode("Svc", "class", "src/svc.ts", 1, 30), fakeNode("items", "property", "src/svc.ts", 5, 5, "items"), ...nodes],
    [{ from: "Svc", to: "items", kind: "contains" }, { from: "Sub", to: "Svc", kind: "extends" }],
    [
      { from: "Page", name: "this.svc.items", kind: "calls", file: "src/page.ts", line: 12 },
      { from: "Page", name: "this.svc.other", kind: "calls", file: "src/page.ts", line: 13 },
      { from: "Elsewhere", name: "this.thing.items", kind: "calls", file: "src/else.ts", line: 9 },
    ],
  );
  const ref = (path: string, symbol: string, line: number) => ({ path, symbol, line });
  const inbound = createInboundEdges(store, () => false, [relation("injects", ref("src/page.ts", "Page", 1), ref("src/sub.ts", "Sub", 1))]);

  assert.deepEqual(occurrencesOfMember(store, inbound, MEMBER), { kind: "found", occurrences: [{ file: "src/page.ts", line: 12, column: 1, receiver: "injected" }] });
});

test("a member the graph does not hold is unresolved, a member nothing reads has no occurrences, and a repository without a graph is unavailable", () => {
  assert.deepEqual(occurrencesOf([], [], { ...MEMBER, member: "ghost" }), { kind: "unresolved" });
  assert.deepEqual(occurrencesOf([], []), { kind: "found", occurrences: [] });
  assert.deepEqual(occurrencesOfMember(undefined, undefined, MEMBER), { kind: "unavailable" });
});
