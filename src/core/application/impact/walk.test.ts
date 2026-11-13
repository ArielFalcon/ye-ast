import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import { createInboundEdges, type InboundEdges } from "./inbound-edges.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "../navigation/fake-code-graph.testing.ts";
import type { ImpactBudget } from "../../domain/impact/impact-fact.ts";
import { walkImpact } from "./walk.ts";

function fn(id: string, line = 1, file = `src/${id}.ts`): FakeNode {
  return fakeNode(id, "function", file, line, line);
}

function call(from: string, to: string, confidence: number | null = 0.9): FakeEdge {
  return { from, to, kind: "calls", confidence };
}

function walk(nodes: FakeNode[], edges: FakeEdge[], seedIds: string[], budget: ImpactBudget = {}, wrap: (inbound: InboundEdges) => InboundEdges = (inbound) => inbound) {
  const graph = fakeCodeGraph(nodes, edges);
  const seeds = graph.symbolsByIds(seedIds.map((id) => id as GraphNodeId));
  const ordered = seedIds.map((id) => seeds.find((seed) => seed.id === id) as GraphSymbol);
  return walkImpact(ordered, wrap(createInboundEdges(graph, (path) => path.includes("/test/"), [])), budget);
}

const summary = (result: ReturnType<typeof walk>) => result.reached.map((r) => `${r.symbol.id}@${r.depth}`);

test("callers are reached level by level with the symbol that first reached them", () => {
  const result = walk([fn("a"), fn("b"), fn("c"), fn("d")], [call("b", "a"), call("c", "b"), call("d", "a")], ["a"]);
  assert.deepEqual(summary(result), ["a@0", "b@1", "d@1", "c@2"]);
  assert.deepEqual(result.reached.map((r) => r.via?.symbol.id), [undefined, "a", "a", "b"]);
});

test("a symbol is expanded once and the walk ends on a cycle", () => {
  const asked: string[] = [];
  const counting = (inbound: InboundEdges): InboundEdges => ({
    ownersOf: inbound.ownersOf,
    settledUses: inbound.settledUses,
    memberProofs: inbound.memberProofs,
    followed: inbound.followed,
    callersOf: (node, contractChanged, throughMember) => {
      asked.push(node.id);
      return inbound.callersOf(node, contractChanged, throughMember);
    },
  });
  const result = walk([fn("a"), fn("b"), fn("c")], [call("b", "a"), call("c", "b"), call("a", "c"), call("c", "a")], ["a"], {}, counting);
  assert.deepEqual(summary(result), ["a@0", "b@1", "c@1"]);
  assert.deepEqual(asked.toSorted(), ["a", "b", "c"]);
});

test("confidence is the strongest weakest edge over every path, not that of the shortest", () => {
  const nodes = [fn("seed"), fn("weak"), fn("mid"), fn("strong"), fn("target")];
  const edges = [call("target", "seed", 0.2), call("mid", "seed", 0.9), call("strong", "mid", 0.8), call("target", "strong", 0.7)];
  const result = walk(nodes, edges, ["seed"]);
  const target = result.reached.find((r) => r.symbol.id === "target")!;
  assert.equal(target.depth, 1);
  assert.equal(target.confidence, 0.7);
  assert.equal(result.reached.find((r) => r.symbol.id === "seed")!.confidence, 1);
});

test("a level is expanded in position order whatever order the seeds came in", () => {
  const nodes = [fn("zseed", 1, "src/z.ts"), fn("aseed", 1, "src/a.ts"), fn("shared")];
  const result = walk(nodes, [call("shared", "zseed"), call("shared", "aseed")], ["zseed", "aseed"]);
  assert.equal(result.reached.find((r) => r.symbol.id === "shared")!.via?.symbol.id, "aseed");
});

test("a path is as sure as its weakest edge wherever that edge is, and seeds flow through every level", () => {
  const result = walk([fn("s"), fn("x"), fn("y"), fn("z")], [call("x", "s", 0.3), call("y", "x", 0.9), call("z", "y", 0.8)], ["s"]);
  assert.deepEqual(result.reached.map((r) => [r.symbol.id, r.confidence, r.seeds]), [["s", 1, [0]], ["x", 0.3, [0]], ["y", 0.3, [0]], ["z", 0.3, [0]]]);
});

test("a symbol names each seed that reaches it", () => {
  const nodes = [fn("s1"), fn("s2"), fn("both"), fn("only1")];
  const edges = [call("both", "s1"), call("both", "s2"), call("only1", "s1")];
  const result = walk(nodes, edges, ["s1", "s2"]);
  assert.deepEqual(result.reached.map((r) => [r.symbol.id, r.seeds]), [["s1", [0]], ["s2", [1]], ["both", [0, 1]], ["only1", [0]]]);
});

test("a seed that is also reached from another seed stays at depth 0", () => {
  const result = walk([fn("s1"), fn("s2")], [call("s2", "s1")], ["s1", "s2"]);
  assert.deepEqual(result.reached.map((r) => [r.symbol.id, r.depth, r.seeds]), [["s1", 0, [0]], ["s2", 0, [0, 1]]]);
});

test("a reached method reaches its type at its own depth, through the method, and the type does not expand into whoever uses it", () => {
  const nodes = [fn("a"), fakeNode("m", "method", "src/O.ts", 5, 6), fakeNode("O", "class", "src/O.ts", 1, 9), fn("user", 3, "src/U.ts")];
  const edges = [call("m", "a"), { from: "O", to: "m", kind: "contains" }, call("user", "O")];
  const result = walk(nodes, edges, ["a"]);
  assert.deepEqual(summary(result), ["a@0", "O@1", "m@1"]);
  assert.equal(result.reached.find((r) => r.symbol.id === "O")!.via?.symbol.id, "m");
  assert.equal(result.reached.find((r) => r.symbol.id === "O")!.confidence, 0.9);
});

test("a type reached through one of its members expands only into a subtype, not into whoever calls, references or instantiates it", () => {
  const nodes = [
    fn("a"),
    fakeNode("m", "method", "src/O.ts", 5, 6),
    fakeNode("O", "class", "src/O.ts", 1, 9),
    fakeNode("Sub", "class", "src/Sub.ts", 1, 9),
    fn("caller", 3, "src/U.ts"),
    fn("holder", 3, "src/H.ts"),
    fn("maker", 3, "src/M.ts"),
  ];
  const edges: FakeEdge[] = [
    call("m", "a"),
    { from: "O", to: "m", kind: "contains" },
    call("caller", "O"),
    { from: "holder", to: "O", kind: "references" },
    { from: "maker", to: "O", kind: "instantiates" },
    { from: "Sub", to: "O", kind: "extends" },
  ];
  assert.deepEqual(summary(walk(nodes, edges, ["a"])), ["a@0", "O@1", "m@1", "Sub@2"]);
});

test("a type one of its members reached first keeps every row from the level its own edge reaches it at", () => {
  const type = [fakeNode("m", "method", "src/O.ts", 5, 6), fakeNode("O", "class", "src/O.ts", 1, 9), fn("user", 3, "src/U.ts")];
  const owned: FakeEdge[] = [{ from: "O", to: "m", kind: "contains" }, call("user", "O")];
  const sameLevel: FakeEdge[] = [...owned, call("m", "a"), call("x", "a"), { from: "O", to: "x", kind: "references" }];
  const expandedBefore = walk([fn("a"), fn("x"), ...type], sameLevel, ["a"]);
  assert.deepEqual(summary(expandedBefore), ["a@0", "O@1", "m@1", "x@1", "user@3"]);
  assert.equal(expandedBefore.cost.expansionsUsed, 5);
  assert.ok(expandedBefore.wholeDeclarations.has("O" as GraphNodeId));
  assert.deepEqual(summary(walk([fn("a"), fn("x"), ...type], sameLevel, ["a"], { expansions: 4 })), summary(expandedBefore));
  assert.deepEqual(summary(walk([fn("a"), fn("x", 1, "src/A.ts"), ...type], sameLevel, ["a"])), ["a@0", "x@1", "O@1", "m@1", "user@3"]);
  const pending = walk([fn("a"), fn("p", 1, "src/A.ts"), fn("q", 1, "src/Z.ts"), ...type], [...owned, call("p", "a"), call("q", "a"), call("m", "p"), { from: "O", to: "q", kind: "references" }], ["a"]);
  assert.deepEqual(summary(pending), ["a@0", "p@1", "q@1", "O@2", "m@2", "user@3"]);
});

test("a type reached through one of its members does not expand through the importers of its file", () => {
  const nodes = [fn("a"), fakeNode("m", "method", "src/N.ts", 5, 6), fakeNode("N", "class", "src/N.ts", 1, 9), fakeNode("main.ts", "file", "src/main.ts", 1, 30), fakeNode("boot", "function", "src/main.ts", 2, 9)];
  const edges: FakeEdge[] = [
    call("m", "a"),
    { from: "N", to: "m", kind: "contains" },
    { from: "main.ts", to: "N", kind: "imports" },
  ];
  assert.deepEqual(summary(walk(nodes, edges, ["a"])), ["a@0", "N@1", "m@1"]);
});

test("the type of a seed method is reached at depth 0 and a seed type keeps no via", () => {
  const nodes = [fakeNode("m", "method", "src/O.ts", 5, 6), fakeNode("O", "class", "src/O.ts", 1, 9)];
  const edges: FakeEdge[] = [{ from: "O", to: "m", kind: "contains" }];
  const both = walk(nodes, edges, ["m", "O"]);
  assert.deepEqual(both.reached.map((r) => [r.symbol.id, r.depth, r.via?.symbol.id]), [["O", 0, undefined], ["m", 0, undefined]]);
  const methodOnly = walk(nodes, edges, ["m"]);
  assert.deepEqual(methodOnly.reached.map((r) => [r.symbol.id, r.depth, r.via?.symbol.id]), [["O", 0, "m"], ["m", 0, undefined]]);
});

test("each reached symbol reports its callers, those past the bound included", () => {
  const result = walk([fn("a"), fn("b"), fn("c"), fn("d")], [call("b", "a"), call("c", "b"), call("d", "b")], ["a"], { depth: 1 });
  assert.deepEqual(result.reached.map((r) => [r.symbol.id, r.fanIn]), [["a", 1], ["b", 2]]);
});

const CHAIN_NODES = [fn("a"), fn("b"), fn("c"), fn("d")];
const CHAIN_EDGES = [call("b", "a"), call("c", "b"), call("d", "c")];

test("a depth bound stops at that level and cuts where more callers were left", () => {
  const result = walk(CHAIN_NODES, CHAIN_EDGES, ["a"], { depth: 2 });
  assert.deepEqual(summary(result), ["a@0", "b@1", "c@2"]);
  assert.deepEqual(result.cuts, [{ kind: "depth", at: ["src/c.ts::c"], limit: 2, reason: "depth", reach: { kind: "anything" } }]);
});

test("a budget that stops several symbols is one cut per symbol, sorted by name, not by position", () => {
  const nodes = [fn("seed"), fn("zeta", 1, "src/same.ts"), fn("alpha", 2, "src/same.ts"), fn("beyondZ"), fn("beyondA")];
  const edges = [call("zeta", "seed"), call("alpha", "seed"), call("beyondZ", "zeta"), call("beyondA", "alpha")];
  const result = walk(nodes, edges, ["seed"], { depth: 1 });
  assert.deepEqual(result.cuts, [
    { kind: "depth", at: ["src/same.ts::alpha"], limit: 1, reason: "depth", reach: { kind: "anything" } },
    { kind: "depth", at: ["src/same.ts::zeta"], limit: 1, reason: "depth", reach: { kind: "anything" } },
  ]);
});

test("a depth bound that stops where nothing is left cuts nothing", () => {
  const result = walk(CHAIN_NODES, CHAIN_EDGES, ["a"], { depth: 3 });
  assert.deepEqual(summary(result), ["a@0", "b@1", "c@2", "d@3"]);
  assert.deepEqual(result.cuts, []);
});

test("a depth of zero reaches the seeds alone", () => {
  const result = walk(CHAIN_NODES, CHAIN_EDGES, ["a"], { depth: 0 });
  assert.deepEqual(summary(result), ["a@0"]);
  assert.deepEqual(result.cuts, [{ kind: "depth", at: ["src/a.ts::a"], limit: 0, reason: "depth", reach: { kind: "anything" } }]);
});

test("a symbol with more callers than the hub bound is kept and not expanded; one at the bound is expanded", () => {
  const nodes = [fn("hub"), fn("c1"), fn("c2"), fn("c3"), fn("beyond"), fn("seed")];
  const edges = [call("hub", "seed"), call("c1", "hub"), call("c2", "hub"), call("c3", "hub"), call("beyond", "c1")];
  const stopped = walk(nodes, edges, ["seed"], { hubFanIn: 2 });
  assert.deepEqual(summary(stopped), ["seed@0", "hub@1"]);
  assert.deepEqual(stopped.cuts, [{ kind: "hub", at: ["src/hub.ts::hub"], limit: 2, reason: "hub", reach: { kind: "anything" } }]);
  const atBound = walk(nodes, edges, ["seed"], { hubFanIn: 3 });
  assert.deepEqual(summary(atBound), ["seed@0", "hub@1", "c1@2", "c2@2", "c3@2", "beyond@3"]);
  assert.deepEqual(atBound.cuts, []);
});

test("the hub bound and the reported fan-in count calls and instantiations alone, though the walk follows every policy edge", () => {
  const nodes = [fn("seed"), fn("hub"), fn("c1"), fn("r1"), fn("r2"), fn("i1")];
  const reference = (from: string, to: string): FakeEdge => ({ from, to, kind: "references", confidence: 0.9 });
  const edges = [call("hub", "seed"), call("c1", "hub"), reference("r1", "hub"), reference("r2", "hub"), { from: "i1", to: "hub", kind: "instantiates", confidence: 0.9 }];
  const bounded = walk(nodes, edges, ["seed"], { hubFanIn: 2 });
  assert.deepEqual(summary(bounded), ["seed@0", "hub@1", "c1@2", "i1@2", "r1@2", "r2@2"]);
  assert.equal(bounded.reached.find((r) => r.symbol.id === "hub")?.fanIn, 2);
  const tighter = walk(nodes, edges, ["seed"], { hubFanIn: 1 });
  assert.deepEqual(summary(tighter), ["seed@0", "hub@1"]);
  assert.deepEqual(tighter.cuts, [{ kind: "hub", at: ["src/hub.ts::hub"], limit: 1, reason: "hub", reach: { kind: "anything" } }]);
});

test("a caller that both references and calls a symbol counts once, whichever edge is the stronger", () => {
  const reference = (confidence: number): FakeEdge => ({ from: "x", to: "t", kind: "references", confidence });
  const pairs: FakeEdge[][] = [[reference(0.95), call("x", "t", 0.4)], [reference(0.4), call("x", "t", 0.95)]];
  for (const edges of [...pairs, ...pairs.map((pair) => pair.toReversed())]) {
    assert.equal(walk([fn("t"), fn("x")], edges, ["t"]).reached.find((r) => r.symbol.id === "t")?.fanIn, 1);
  }
});

test("an expansion budget follows the callers of that many symbols in position order and cuts the rest", () => {
  const nodes = [fn("a"), fn("b", 1), fn("c", 2), fn("x"), fn("y")];
  const edges = [call("b", "a"), call("c", "a"), call("x", "b"), call("y", "c")];
  const result = walk(nodes, edges, ["a"], { expansions: 2 });
  assert.deepEqual(summary(result), ["a@0", "b@1", "c@1", "x@2"]);
  assert.deepEqual(result.cuts, [{ kind: "caller-budget", at: ["src/c.ts::c"], limit: 2, reason: "caller-budget", reach: { kind: "anything" } }]);
});

test("a hub stopped by the bound whose callers were all reached already cuts nothing", () => {
  const result = walk([fn("s1"), fn("s2"), fn("s3")], [call("s2", "s1"), call("s3", "s1")], ["s1", "s2", "s3"], { hubFanIn: 1 });
  assert.deepEqual(summary(result), ["s1@0", "s2@0", "s3@0"]);
  assert.deepEqual(result.cuts, []);
});

test("the walk gives the same answer whatever order the store lists its nodes and edges in", () => {
  const nodes = [fn("a"), fn("b", 1, "src/z.ts"), fn("c", 1, "src/m.ts"), fn("d"), fn("e")];
  const edges = [call("b", "a"), call("c", "a"), call("d", "b"), call("d", "c"), call("e", "d", 0.5)];
  const first = walk(nodes, edges, ["a"]);
  const second = walk(nodes.toReversed(), edges.toReversed(), ["a"]);
  assert.deepEqual(first, second);
});

test("a path that went up to a method does not come down to its sibling implementation", () => {
  const nodes = [
    fakeNode("Repo", "interface", "src/Repo.java", 1, 9),
    fakeNode("Repo.save", "method", "src/Repo.java", 3, 3, "save"),
    fakeNode("Mem", "class", "src/Mem.java", 1, 9),
    fakeNode("Mem.save", "method", "src/Mem.java", 3, 3, "save"),
    fakeNode("Db", "class", "src/Db.java", 1, 9),
    fakeNode("Db.save", "method", "src/Db.java", 3, 3, "save"),
  ];
  const edges: FakeEdge[] = [
    { from: "Mem", to: "Repo", kind: "implements" },
    { from: "Db", to: "Repo", kind: "implements" },
    { from: "Repo", to: "Repo.save", kind: "contains" },
    { from: "Mem", to: "Mem.save", kind: "contains" },
    { from: "Db", to: "Db.save", kind: "contains" },
  ];
  const fromImplementation = walk(nodes, edges, ["Mem.save"]);
  assert.deepEqual(fromImplementation.reached.map((r) => r.symbol.id).filter((id) => id.endsWith(".save")).toSorted(), ["Mem.save", "Repo.save"]);
  const fromDeclaration = walk(nodes, edges, ["Repo.save"]);
  assert.deepEqual(fromDeclaration.reached.map((r) => r.symbol.id).filter((id) => id.endsWith(".save")).toSorted(), ["Db.save", "Mem.save", "Repo.save"]);
});

test("the walk reports the symbols whose callers it followed, not every one it reached", () => {
  const result = walk([fn("a"), fn("b"), fn("c")], [call("b", "a"), call("c", "b")], ["a"]);
  assert.deepEqual(summary(result), ["a@0", "b@1", "c@2"]);
  assert.equal(result.cost.expansionsUsed, 3);
});

test("a symbol the caller budget stopped is reached and does not count as expanded", () => {
  const result = walk([fn("a"), fn("b"), fn("c")], [call("b", "a"), call("c", "b")], ["a"], { expansions: 1 });
  assert.deepEqual(summary(result), ["a@0", "b@1"]);
  assert.equal(result.cost.expansionsUsed, 1);
  assert.deepEqual(result.cuts.map((cut) => cut.kind), ["caller-budget"]);
});

test("an interface-to-implementation hop spends no depth: the dispatch target sits at the method's own level", () => {
  const nodes = [
    fakeNode("I", "class", "src/A.java", 1, 10, "I"),
    fakeNode("mI", "method", "src/A.java", 5, 6, "m"),
    fakeNode("Impl", "class", "src/A.java", 20, 30, "Impl"),
    fakeNode("mImpl", "method", "src/A.java", 25, 26, "m"),
    fakeNode("c", "method", "src/B.java", 3, 4, "c"),
  ];
  const edges: FakeEdge[] = [
    { from: "I", to: "mI", kind: "contains" },
    { from: "Impl", to: "mImpl", kind: "contains" },
    { from: "Impl", to: "I", kind: "implements" },
    { from: "c", to: "mI", kind: "calls" },
  ];

  const result = walk(nodes, edges, ["mImpl"], { depth: 1 });
  assert.deepEqual(summary(result), ["I@0", "mI@0", "Impl@0", "mImpl@0", "c@1"]);
  assert.deepEqual(result.cuts, []);
});

test("expanded IDs include only nodes admitted by walk bounds", () => {
  const nodes = [fn("a"), fn("b"), fn("c")];
  const edges = [call("b", "a"), call("c", "b")];
  assert.deepEqual([...walk(nodes, edges, ["a"], { depth: 1 }).expanded], ["a"]);
  assert.deepEqual([...walk(nodes, edges, ["a"], { expansions: 0 }).expanded], []);
  assert.deepEqual([...walk(nodes, edges, ["a"], { hubFanIn: 0 }).expanded], []);
});

test("via follows the path that determines confidence", () => {
  const nodes = [fn("seed"), fn("mid"), fn("target")];
  const edges = [call("target", "seed", 0.2), call("mid", "seed", 0.9), call("target", "mid", 0.8)];
  const result = walk(nodes, [...edges, call("mid", "target", 0.8)], ["seed"]);
  const target = result.reached.find((rec) => rec.symbol.id === "target");
  assert.equal(target?.confidence, 0.8);
  assert.equal(target?.depth, 1);
  assert.equal(target?.via?.symbol.id, "mid");
  assert.equal(result.reached.find((rec) => rec.symbol.id === "mid")?.via?.symbol.id, "seed");

  const stopped = walk(nodes, edges, ["seed"], { expansions: 1 });
  assert.equal(stopped.reached.find((rec) => rec.symbol.id === "target")?.via?.symbol.id, "seed");
});
