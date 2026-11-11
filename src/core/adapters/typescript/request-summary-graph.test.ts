import { test } from "node:test";
import assert from "node:assert/strict";
import { requestSummaryGraph } from "./request-summary-graph.ts";
import type { SummaryCause } from "../../domain/topology/request-summary.ts";

function counts() {
  return { globalVisits: 0, rowScanned: 0, rowVisits: 0, rowPeak: 0, projections: 0 };
}

test("classifies recursive edges across components and opaque targets", () => {
  const graph = requestSummaryGraph(new Map([
    ["a", [{ callee: "b" }, { callee: "opaque" }]],
    ["b", [{ callee: "a" }, { callee: "c" }]],
    ["c", [{ callee: "c" }, { callee: "d" }]],
    ["d", []],
    ["isolated", []],
  ]));
  assert.equal(graph.isRecursive("a", "b"), true);
  assert.equal(graph.isRecursive("b", "c"), false);
  assert.equal(graph.isRecursive("c", "c"), true);
  assert.equal(graph.isRecursive("a", "opaque"), false);
  assert.equal(graph.isRecursive("missing", "other"), false);
  assert.equal(graph.isRecursive("c", "d"), false);
});

test("builds independent graphs without recursion on the JavaScript call stack", () => {
  const edges = new Map<string, { callee: string }[]>();
  for (let i = 0; i < 20000; i++) edges.set(String(i), [{ callee: String(i + 1) }]);
  const graph = requestSummaryGraph(edges);
  assert.equal(graph.isRecursive("0", "1"), false);
  const fresh = requestSummaryGraph(new Map([["0", []]]));
  assert.equal(fresh.isRecursive("0", "1"), false);
});

test("excludes the caller inside its component while reusing outside causes and one row", () => {
  const graph = requestSummaryGraph(new Map([
    ["up", [{ callee: "a" }]],
    ["a", [{ callee: "b" }, { callee: "c" }, { callee: "a" }, { callee: "opaque" }]],
    ["b", [{ callee: "a" }, { callee: "leaf" }]],
    ["c", [{ callee: "a" }]],
    ["leaf", []],
    ["disconnected", []],
  ]));
  const stats = counts();
  const own = new Map<string, SummaryCause[]>([
    ["a", ["source-not-read"]], ["b", ["dispatch-disagreement"]],
    ["c", ["destination-undecidable"]], ["leaf", ["recursive"]],
    ["disconnected", ["source-not-read"]], ["opaque", ["source-not-read"]],
  ]);
  const index = graph.causeIndex(own, stats);
  const causes = index.forCaller("a");
  assert.deepEqual(new Set(causes("b")), new Set(["dispatch-disagreement", "recursive"]));
  assert.deepEqual(new Set(causes("c")), new Set(["destination-undecidable"]));
  assert.deepEqual([...causes("a")], []);
  assert.deepEqual([...causes("opaque")], []);
  assert.deepEqual(new Set(index.forCaller("up")("a")), new Set(["source-not-read", "dispatch-disagreement", "destination-undecidable", "recursive"]));
  assert.equal(stats.rowScanned, 3);
  assert.equal(stats.rowPeak, 2);
  assert.equal(stats.rowVisits, 3);
  assert.equal(stats.projections, 7);
  const fresh = requestSummaryGraph(new Map([["up", [{ callee: "a" }]], ["a", []]])).causeIndex(new Map());
  assert.deepEqual([...fresh.forCaller("up")("a")], []);
});

function diamonds(n: number) {
  const edges = new Map<string, { callee: string }[]>();
  let current = "root";
  for (let i = 0; i < n; i++) {
    const a = `a${i}`, b = `b${i}`, join = `join${i}`;
    edges.set(current, [{ callee: a }, { callee: b }]);
    edges.set(a, [{ callee: join }]);
    edges.set(b, [{ callee: join }]);
    current = join;
  }
  edges.set(current, []);
  return { edges, leaf: current };
}

test("shares global propagation across convergent DAGs without caller rows", () => {
  for (const n of [4, 8, 16, 32]) {
    const { edges, leaf } = diamonds(n);
    const stats = counts();
    const index = requestSummaryGraph(edges).causeIndex(new Map([[leaf, ["source-not-read"]]]), stats);
    for (const [caller, calls] of edges) {
      const causes = index.forCaller(caller);
      for (const call of calls) assert.deepEqual([...causes(call.callee)], ["source-not-read"]);
    }
    assert.deepEqual(stats, { globalVisits: 4 * n, rowScanned: 0, rowVisits: 0, rowPeak: 0, projections: 4 * n });
  }
});

test("limits excluded rows to a small component even beside a large DAG", () => {
  const { edges, leaf } = diamonds(32);
  edges.set("x", [{ callee: "y" }, { callee: "root" }]);
  edges.set("y", [{ callee: "x" }]);
  const stats = counts();
  const index = requestSummaryGraph(edges).causeIndex(new Map([[leaf, ["source-not-read"]], ["y", ["recursive"]]]), stats);
  assert.deepEqual([...index.forCaller("x")("y")], ["recursive"]);
  assert.deepEqual(stats, { globalVisits: 133, rowScanned: 2, rowVisits: 1, rowPeak: 1, projections: 1 });
});

test("fully cyclic graphs perform one local row per caller", () => {
  const graph = requestSummaryGraph(new Map([["a", [{ callee: "b" }]], ["b", [{ callee: "c" }]], ["c", [{ callee: "a" }]]]));
  const stats = counts();
  const index = graph.causeIndex(new Map([["a", ["source-not-read"]]]), stats);
  assert.deepEqual([...index.forCaller("a")("b")], []);
  assert.deepEqual([...index.forCaller("b")("c")], ["source-not-read"]);
  assert.deepEqual([...index.forCaller("c")("a")], ["source-not-read"]);
  assert.deepEqual(stats, { globalVisits: 3, rowScanned: 9, rowVisits: 3, rowPeak: 2, projections: 2 });
});

test("matches caller-excluded reachability across small directed graphs", () => {
  const keys = ["a", "b", "c"];
  for (let edgeMask = 0; edgeMask < 512; edgeMask++) {
    const edges = new Map(keys.map((key, i) => [key, keys.filter((_, j) => (edgeMask & (1 << (3 * i + j))) !== 0).map((callee) => ({ callee }))]));
    const graph = requestSummaryGraph(edges);
    for (let causeMask = 0; causeMask < 8; causeMask++) {
      const own = new Map<string, SummaryCause[]>(keys.map((key, i) => [key, [(causeMask & (1 << i)) ? "source-not-read" : "destination-undecidable"]]));
      const index = graph.causeIndex(own);
      for (const caller of keys) {
        const causes = index.forCaller(caller);
        for (const { callee } of edges.get(caller)!) {
          const seen = new Set([caller]);
          const pending = [callee];
          const expected = new Set<SummaryCause>();
          while (pending.length > 0) {
            const key = pending.pop()!;
            if (seen.has(key)) continue;
            seen.add(key);
            for (const cause of own.get(key)!) expected.add(cause);
            for (const edge of edges.get(key)!) pending.push(edge.callee);
          }
          assert.deepEqual(causes(callee), expected, `edges=${edgeMask}, causes=${causeMask}, ${caller}->${callee}`);
        }
      }
    }
  }
});
