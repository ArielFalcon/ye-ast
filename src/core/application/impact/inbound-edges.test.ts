import { test } from "node:test";
import assert from "node:assert/strict";
import { relation, type RelationKind, type Relation, type SymbolRef } from "../../domain/relations/relation.ts";
import type { GraphSymbol } from "../../ports/code-graph.port.ts";
import { createInboundEdges, type InboundEdges } from "./inbound-edges.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";

const isTestFile = (path: string): boolean => path.includes("/test/");

interface Setup {
  inbound: InboundEdges;
  symbol(id: string): GraphSymbol;
  callers(id: string, contractChanged?: boolean): string[];
  callLike(id: string): boolean[];
  scored(id: string, contractChanged?: boolean): [string, number, string | undefined][];
}

function setup(nodes: FakeNode[], edges: FakeEdge[], relations: readonly Relation[] = []): Setup {
  const graph = fakeCodeGraph(nodes, edges);
  const inbound = createInboundEdges(graph, isTestFile, relations);
  const symbol = (id: string): GraphSymbol => {
    const [found] = graph.symbolsByIds([id as GraphSymbol["id"]]);
    assert.ok(found, id);
    return found;
  };
  return {
    inbound,
    symbol,
    callers: (id, contractChanged = false) => inbound.callersOf(symbol(id), contractChanged).map((edge) => edge.from.id),
    callLike: (id) => inbound.callersOf(symbol(id), false).map((edge) => edge.callLike),
    scored: (id, contractChanged = false) => inbound.callersOf(symbol(id), contractChanged).map((edge) => [edge.from.id, edge.confidence, edge.bridge]),
  };
}

const A = "src/A.java";
const B = "src/B.java";

test("a call or an instantiation from code is a caller with the score of its edge", () => {
  const s = setup(
    [fakeNode("target", "method", A, 1), fakeNode("caller", "method", B, 5), fakeNode("maker", "function", B, 9)],
    [{ from: "caller", to: "target", kind: "calls", confidence: 0.9 }, { from: "maker", to: "target", kind: "instantiates", confidence: 0.5 }],
  );
  assert.deepEqual(s.scored("target"), [["caller", 0.9, undefined], ["maker", 0.5, undefined]]);
});

test("an edge with no score counts 1, unless it is heuristic, and then 0.3", () => {
  const s = setup(
    [fakeNode("target", "method", A, 1), fakeNode("sure", "method", B, 5), fakeNode("guess", "method", B, 9)],
    [{ from: "sure", to: "target", kind: "calls" }, { from: "guess", to: "target", kind: "calls", provenance: "heuristic", synthesizedBy: "callback" }],
  );
  assert.deepEqual(s.scored("target"), [["sure", 1, undefined], ["guess", 0.3, undefined]]);
});

test("two edges from one caller make one caller with the stronger score", () => {
  const s = setup(
    [fakeNode("target", "method", A, 1), fakeNode("caller", "method", B, 5)],
    [{ from: "caller", to: "target", kind: "calls", confidence: 0.4 }, { from: "caller", to: "target", kind: "references", confidence: 0.9 }],
  );
  assert.deepEqual(s.scored("target"), [["caller", 0.9, undefined]]);
});

test("callers come in position order", () => {
  const s = setup(
    [fakeNode("target", "method", A, 1), fakeNode("late", "method", B, 30), fakeNode("early", "method", B, 3), fakeNode("other", "method", "src/0.java", 99)],
    ["late", "early", "other"].map((from) => ({ from, to: "target", kind: "calls" })),
  );
  assert.deepEqual(s.callers("target"), ["other", "early", "late"]);
});

test("a type that references a DTO is a caller, a field that references it is not", () => {
  const s = setup(
    [fakeNode("Dto", "interface", A, 1), fakeNode("use", "function", B, 5), fakeNode("alias", "type_alias", B, 9), fakeNode("field", "field", B, 12)],
    ["use", "alias", "field"].map((from) => ({ from, to: "Dto", kind: "references" })),
  );
  assert.deepEqual(s.callers("Dto"), ["use", "alias"]);
});

test("a subtype is a caller of its supertype", () => {
  const s = setup(
    [fakeNode("Base", "class", A, 1, 9), fakeNode("Sub", "class", B, 1, 9), fakeNode("Impl", "class", B, 20, 29)],
    [{ from: "Sub", to: "Base", kind: "extends" }, { from: "Impl", to: "Base", kind: "implements" }],
  );
  assert.deepEqual(s.callers("Base"), ["Sub", "Impl"]);
});

test("navigation, imports, containment and type edges are no calls", () => {
  const s = setup(
    [fakeNode("target", "method", A, 1), fakeNode("n", "method", B, 5), fakeNode("i", "method", B, 9), fakeNode("c", "method", B, 12), fakeNode("t", "method", B, 15)],
    [{ from: "n", to: "target", kind: "navigates" }, { from: "i", to: "target", kind: "imports" }, { from: "c", to: "target", kind: "contains" }, { from: "t", to: "target", kind: "type_of" }],
  );
  assert.deepEqual(s.callers("target"), []);
});

test("template, event and interface-bridge edges codegraph synthesizes are not followed", () => {
  const s = setup(
    [fakeNode("target", "method", A, 1), fakeNode("tpl", "method", B, 5), fakeNode("evt", "method", B, 9), fakeNode("bridge", "method", B, 12), fakeNode("cb", "method", B, 15)],
    [
      { from: "tpl", to: "target", kind: "calls", provenance: "heuristic", synthesizedBy: "angular-template" },
      { from: "evt", to: "target", kind: "calls", provenance: "heuristic", synthesizedBy: "angular-event" },
      { from: "bridge", to: "target", kind: "calls", provenance: "heuristic", synthesizedBy: "interface-impl" },
      { from: "cb", to: "target", kind: "calls", provenance: "heuristic", synthesizedBy: "callback" },
    ],
  );
  assert.deepEqual(s.callers("target"), ["cb"]);
});

test("code in a test file is never a caller", () => {
  const s = setup(
    [fakeNode("target", "method", A, 1), fakeNode("test", "method", "src/test/java/ATest.java", 5), fakeNode("real", "method", B, 5)],
    ["test", "real"].map((from) => ({ from, to: "target", kind: "calls" })),
  );
  assert.deepEqual(s.callers("target"), ["real"]);
});

test("a method stands for the type that declares it, and only a method does", () => {
  const s = setup(
    [fakeNode("Order", "class", A, 1, 20), fakeNode("total", "method", A, 5, 8), fakeNode("Inner", "class", A, 10, 12), fakeNode("TestOrder", "class", "src/test/java/T.java", 1, 3)],
    [{ from: "Order", to: "total", kind: "contains" }, { from: "Order", to: "Inner", kind: "contains" }, { from: "TestOrder", to: "total", kind: "contains" }],
  );
  assert.deepEqual(s.inbound.ownersOf(s.symbol("total")).map((owner) => owner.id), ["Order"]);
  assert.deepEqual(s.inbound.ownersOf(s.symbol("Inner")), []);
});

const HIERARCHY_NODES: FakeNode[] = [
  fakeNode("Repo", "interface", "src/Repo.java", 1, 9),
  fakeNode("Repo.save", "method", "src/Repo.java", 3, 3, "save"),
  fakeNode("Repo.find", "method", "src/Repo.java", 4, 4, "find"),
  fakeNode("Mem", "class", "src/Mem.java", 1, 9),
  fakeNode("Mem.save", "method", "src/Mem.java", 3, 3, "save"),
  fakeNode("Mem.find", "method", "src/Mem.java", 4, 4, "find"),
  fakeNode("Db", "class", "src/Db.java", 1, 9),
  fakeNode("Db.save", "method", "src/Db.java", 3, 3, "save"),
  fakeNode("use", "method", "src/Use.java", 3),
];
const HIERARCHY_EDGES: FakeEdge[] = [
  { from: "Mem", to: "Repo", kind: "implements", confidence: 0.8 },
  { from: "Db", to: "Repo", kind: "implements", confidence: 0.9 },
  { from: "Repo", to: "Repo.save", kind: "contains" },
  { from: "Repo", to: "Repo.find", kind: "contains" },
  { from: "Mem", to: "Mem.save", kind: "contains" },
  { from: "Mem", to: "Mem.find", kind: "contains" },
  { from: "Db", to: "Db.save", kind: "contains" },
  { from: "use", to: "Repo.save", kind: "calls", confidence: 0.9 },
];

test("an implementation is called by whoever calls the method it implements, through that method", () => {
  const s = setup(HIERARCHY_NODES, HIERARCHY_EDGES);
  assert.deepEqual(s.scored("Mem.save"), [["Repo.save", 0.8, "up"]]);
  assert.deepEqual(s.scored("Db.save"), [["Repo.save", 0.9, "up"]]);
  assert.deepEqual(s.callers("Repo.save"), ["use"]);
});

test("a changed declaration is also called by the methods that implement it, and a reached caller is not", () => {
  const s = setup(HIERARCHY_NODES, HIERARCHY_EDGES);
  assert.deepEqual(s.scored("Repo.save", true), [["Db.save", 0.9, "down"], ["Mem.save", 0.8, "down"], ["use", 0.9, undefined]]);
  assert.deepEqual(s.callers("Repo.save", false), ["use"]);
});

test("a changed implementation is called through the method it implements as well", () => {
  const s = setup(HIERARCHY_NODES, HIERARCHY_EDGES);
  assert.deepEqual(s.callers("Mem.save", true), ["Repo.save"]);
});

test("a method is bridged only to methods of its own name", () => {
  const s = setup(HIERARCHY_NODES, HIERARCHY_EDGES);
  assert.deepEqual(s.callers("Mem.find"), ["Repo.find"]);
  assert.deepEqual(s.callers("Repo.find", true), ["Mem.find"]);
});

test("the bridge climbs more than one level and keeps the weakest edge on the way", () => {
  const nodes = [
    fakeNode("Top", "interface", "src/Top.java", 1, 9),
    fakeNode("Top.run", "method", "src/Top.java", 2, 2, "run"),
    fakeNode("Mid", "class", "src/Mid.java", 1, 9),
    fakeNode("Leaf", "class", "src/Leaf.java", 1, 9),
    fakeNode("Leaf.run", "method", "src/Leaf.java", 2, 2, "run"),
  ];
  const edges: FakeEdge[] = [
    { from: "Mid", to: "Top", kind: "implements", confidence: 0.9 },
    { from: "Leaf", to: "Mid", kind: "extends", confidence: 0.6 },
    { from: "Top", to: "Top.run", kind: "contains" },
    { from: "Leaf", to: "Leaf.run", kind: "contains" },
  ];
  assert.deepEqual(setup(nodes, edges).scored("Leaf.run"), [["Top.run", 0.6, "up"]]);
});

test("an interface with more than forty implementations bridges to every one", () => {
  const impls = Array.from({ length: 45 }, (_, i) => `Impl${String(i).padStart(2, "0")}`);
  const nodes = [
    fakeNode("Port", "interface", "src/Port.java", 1, 9),
    fakeNode("Port.go", "method", "src/Port.java", 2, 2, "go"),
    ...impls.flatMap((id, i) => [fakeNode(id, "class", `src/${id}.java`, 1, 9), fakeNode(`${id}.go`, "method", `src/${id}.java`, 2, 2, "go"), fakeNode(`unused${i}`, "method", "src/u.java", i + 1)]),
  ];
  const edges: FakeEdge[] = [
    { from: "Port", to: "Port.go", kind: "contains" },
    ...impls.flatMap((id) => [{ from: id, to: "Port", kind: "implements" }, { from: id, to: `${id}.go`, kind: "contains" }]),
  ];
  assert.equal(setup(nodes, edges).callers("Port.go", true).length, 45);
});

test("a hierarchy that loops back on itself still ends", () => {
  const nodes = [
    fakeNode("X", "class", "src/X.java", 1, 9),
    fakeNode("X.run", "method", "src/X.java", 2, 2, "run"),
    fakeNode("Y", "class", "src/Y.java", 1, 9),
    fakeNode("Y.run", "method", "src/Y.java", 2, 2, "run"),
  ];
  const edges: FakeEdge[] = [{ from: "X", to: "Y", kind: "extends" }, { from: "Y", to: "X", kind: "extends" }, { from: "X", to: "X.run", kind: "contains" }, { from: "Y", to: "Y.run", kind: "contains" }];
  assert.deepEqual(setup(nodes, edges).callers("X.run", true), ["Y.run"]);
});

test("an implementation in a test file is not bridged to", () => {
  const nodes = [...HIERARCHY_NODES, fakeNode("Fake", "class", "src/test/java/Fake.java", 1, 9), fakeNode("Fake.save", "method", "src/test/java/Fake.java", 3, 3, "save")];
  const edges = [...HIERARCHY_EDGES, { from: "Fake", to: "Repo", kind: "implements" }, { from: "Fake", to: "Fake.save", kind: "contains" }];
  assert.deepEqual(setup(nodes, edges).callers("Repo.save", true), ["Db.save", "Mem.save", "use"]);
});

const TOP_LEVEL_NODES: FakeNode[] = [
  fakeNode("target", "function", A, 1, 3),
  fakeNode("main.ts", "file", "src/main.ts", 1, 30),
  fakeNode("boot", "function", "src/main.ts", 2, 9),
  fakeNode("inner", "function", "src/main.ts", 4, 6),
  fakeNode("App", "class", "src/main.ts", 12, 20),
  fakeNode("LIMIT", "constant", "src/main.ts", 22),
];

test("code a file runs at its top level reaches its top-level functions and classes, not its nested code or values", () => {
  const s = setup(TOP_LEVEL_NODES, [{ from: "main.ts", to: "target", kind: "calls", confidence: 0.9 }]);
  assert.deepEqual(s.scored("target"), [["boot", 0.9, undefined], ["App", 0.9, undefined]]);
});

test("a class nothing calls is reached through the top-level code of the files that import it", () => {
  const nodes = [...TOP_LEVEL_NODES, fakeNode("Svc", "class", A, 1, 9), fakeNode("Fn", "function", A, 20, 22)];
  const edges: FakeEdge[] = [{ from: "main.ts", to: "Svc", kind: "imports", confidence: 0.9 }, { from: "main.ts", to: "Fn", kind: "imports" }];
  const s = setup(nodes, edges);
  assert.deepEqual(s.callers("Svc"), ["boot", "App"]);
  assert.deepEqual(s.callers("Fn"), []);
});

test("a class a file uses at its top level is reached through that file alone, not through every file that imports it", () => {
  const nodes = [...TOP_LEVEL_NODES, fakeNode("Svc", "class", A, 1, 9), fakeNode("other.ts", "file", "src/other.ts", 1, 9), fakeNode("elsewhere", "function", "src/other.ts", 2, 4)];
  const edges: FakeEdge[] = [{ from: "main.ts", to: "Svc", kind: "instantiates" }, { from: "other.ts", to: "Svc", kind: "imports" }];
  assert.deepEqual(setup(nodes, edges).callers("Svc"), ["boot", "App"]);
});

test("a class with a caller is not also reached through its importers", () => {
  const nodes = [...TOP_LEVEL_NODES, fakeNode("Svc", "class", A, 1, 9), fakeNode("user", "method", B, 5)];
  const edges: FakeEdge[] = [{ from: "main.ts", to: "Svc", kind: "imports" }, { from: "user", to: "Svc", kind: "instantiates" }];
  assert.deepEqual(setup(nodes, edges).callers("Svc"), ["user"]);
});

test("top-level code of a test file never reaches a symbol", () => {
  const nodes = [fakeNode("Svc", "class", A, 1, 9), fakeNode("spec", "file", "src/test/x.ts", 1, 9), fakeNode("check", "function", "src/test/x.ts", 2, 4)];
  assert.deepEqual(setup(nodes, [{ from: "spec", to: "Svc", kind: "imports" }]).callers("Svc"), []);
});

const ref = (path: string, symbol: string, line: number): SymbolRef => ({ path, symbol, line });
const SVC = "src/app/svc.ts";
const CMP = "src/app/cmp.ts";

test("a class that injects or uses another in its template is a certain caller of it, one row per relation kind", () => {
  const kinds: RelationKind[] = ["injects", "uses-component", "uses-directive", "uses-pipe"];
  const s = setup(
    [fakeNode("Target", "class", SVC, 3, 9), ...kinds.map((kind, index) => fakeNode(kind, "class", CMP, 10 * (index + 1), 10 * (index + 1) + 5))],
    [],
    kinds.map((kind, index) => relation(kind, ref(CMP, kind, 10 * (index + 1) + 1), ref(SVC, "Target", 4))),
  );
  assert.deepEqual(s.scored("Target"), kinds.map((kind) => [kind, 1, undefined]));
  assert.deepEqual(s.callLike("Target"), [false, false, false, false]);
});

test("a relation joins its classes by file, a line inside the span and the simple name, never by position alone", () => {
  const s = setup(
    [
      fakeNode("Target", "class", SVC, 3, 9, "Svc"),
      fakeNode("Good", "class", CMP, 10, 20, "Good"),
      fakeNode("Late", "class", CMP, 30, 40, "Late"),
      fakeNode("Named", "class", CMP, 50, 60, "Named"),
      fakeNode("Moved", "class", "src/app/moved.ts", 10, 20, "Moved"),
    ],
    [],
    [
      relation("injects", ref(CMP, "Good", 12), ref(SVC, "Svc", 4)),
      relation("injects", ref(CMP, "Late", 25), ref(SVC, "Svc", 4)),
      relation("injects", ref(CMP, "Wrong", 55), ref(SVC, "Svc", 4)),
      relation("injects", ref("src/app/other.ts", "Moved", 12), ref(SVC, "Svc", 4)),
      relation("injects", ref(CMP, "Named", 55), ref(SVC, "Svc", 12)),
      relation("injects", ref(CMP, "Named", 55), ref(SVC, "Other", 4)),
      relation("injects", ref(CMP, "Named", 55), ref(CMP, "Svc", 4)),
    ],
  );
  assert.deepEqual(s.callers("Target"), ["Good"]);
});

test("a method, a test file, or a missing class is no end of a relation", () => {
  const s = setup(
    [
      fakeNode("Target", "class", SVC, 3, 9, "Svc"),
      fakeNode("Fn", "function", CMP, 10, 20, "Fn"),
      fakeNode("TestCmp", "class", "src/app/test/cmp.ts", 1, 9, "TestCmp"),
      fakeNode("Real", "class", CMP, 30, 40, "Real"),
      fakeNode("Method", "method", SVC, 5, 6, "Svc"),
    ],
    [],
    [
      relation("injects", ref(CMP, "Fn", 12), ref(SVC, "Svc", 4)),
      relation("injects", ref("src/app/test/cmp.ts", "TestCmp", 2), ref(SVC, "Svc", 4)),
      relation("injects", ref(CMP, "Real", 31), ref(SVC, "Svc", 4)),
      relation("injects", ref(CMP, "Real", 31), ref(SVC, "Svc", 5)),
    ],
  );
  assert.deepEqual(s.callers("Target"), ["Real"]);
  assert.deepEqual(s.callers("Method"), []);
});
