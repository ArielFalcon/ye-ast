import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { GraphNodeId } from "../../ports/code-graph.port.ts";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { ImportOrigins, ReceiverMethod } from "../../ports/import-origins.port.ts";
import { createEdgeTargets, NOTHING_DECLARED, type FollowedEdge } from "./edge-targets.ts";
import { fakeCodeGraph, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";

interface World {
  nodes: readonly FakeNode[];
  edges: readonly FakeEdge[];
  /** What `receiverMethods` answers per member; unknown otherwise. */
  receivers?: Readonly<Record<string, ReceiverMethod>>;
  receiverBindings?: readonly ReceiverBinding[];
  memberUses?: readonly MemberUseOrigin[];
}

/** The verdict `EdgeTargets` gives the one call edge out of `from`, as the reverse families read it. */
async function verdictOf(world: World, from: string) {
  const store = fakeCodeGraph(world.nodes, world.edges);
  const origins = {
    rootOrigins: async (sites) => sites.map(() => ({ status: "unknown", reason: "unresolved", evidence: [] })),
    rootBindings: async (sites) => sites.map(() => ({ kind: "unknown" })),
    receiverMethods: async (sites) => sites.map((site) => world.receivers?.[site.member] ?? { kind: "unknown" }),
  } as Pick<ImportOrigins, "rootOrigins" | "rootBindings" | "receiverMethods"> as ImportOrigins;
  const targets = createEdgeTargets({
    origins,
    store,
    syntaxOf: async () => ({ ...NOTHING_DECLARED, receiverBindings: world.receiverBindings ?? [], calls: (world.receiverBindings ?? []).map(({ line, column, receiver, member }) => ({ kind: "calls" as const, line, column, name: `${receiver}.${member}`, owners: [] })) }),
    proofs: async () => ({ fields: [], locals: [], memberUses: world.memberUses ?? [] }),
  });
  const [source] = store.symbolsByIds([from as GraphNodeId]);
  const [edge] = store.outgoingEdges([source!.id], ["calls"]);
  const followed: FollowedEdge = { edge: edge!, source: source!, target: store.symbolsByIds([edge!.target])[0]! };
  const [verdict] = await targets.verdictsOf([followed]);
  return verdict!.kind === "redirect" ? ["redirect", verdict!.to.id] : verdict!.kind === "keep" ? ["keep", verdict!.derivation] : [verdict!.kind];
}

const A = "src/main/java/p/A.java";
const D = "src/main/java/p/D.java";
const USE = "src/main/java/p/Use.java";
const JAVA: World = {
  nodes: [{ id: "A", kind: "class", file: A, start: 3, end: 7 }, { id: "A.go", kind: "method", name: "go", file: A, start: 4, end: 6 }, { id: "D", kind: "class", file: D, start: 3, end: 7 }, { id: "D.go", kind: "method", name: "go", file: D, start: 4, end: 6 }, { id: "run", kind: "method", file: USE, start: 4, end: 7 }],
  edges: [{ from: "A", to: "A.go", kind: "contains" }, { from: "D", to: "D.go", kind: "contains" }, { from: "run", to: "D.go", kind: "calls", line: 6, column: 8 }],
};

test("a Java call edge is redirected to the method the receiver reading names, and kept where that reading names its target or settles nothing (R1)", async () => {
  assert.deepEqual(await verdictOf({ ...JAVA, receivers: { go: { kind: "method", file: A, start: 4, nameLine: 4 } } }, "run"), ["redirect", "A.go"]);
  assert.deepEqual(await verdictOf({ ...JAVA, receivers: { go: { kind: "method", file: D, start: 4, nameLine: 4 } } }, "run"), ["keep", undefined]);
  assert.deepEqual(await verdictOf({ ...JAVA, receivers: { go: { kind: "unproven" } } }, "run"), ["keep", undefined]);
});

const API = "src/api.ts";
const OTHER = "src/other.ts";
const SITE = "src/use.ts";
const TS: World = {
  nodes: [{ id: "Api", kind: "class", file: API, start: 1, end: 9 }, { id: "Api.load", kind: "method", name: "load", file: API, start: 2, end: 4 }, { id: "Sub", kind: "class", file: API, start: 11, end: 15 }, { id: "Sub.load", kind: "method", name: "load", file: API, start: 12, end: 14 }, { id: "Other", kind: "class", file: OTHER, start: 1, end: 5 }, { id: "Other.load", kind: "method", name: "load", file: OTHER, start: 2, end: 4 }, { id: "run", kind: "function", file: SITE, start: 3, end: 6 }],
  edges: [{ from: "Api", to: "Api.load", kind: "contains" }, { from: "Sub", to: "Sub.load", kind: "contains" }, { from: "Sub", to: "Api", kind: "extends" }, { from: "Other", to: "Other.load", kind: "contains" }, { from: "run", to: "Other.load", kind: "calls", line: 4, column: 4 }],
};
const proofOf = (member: string, line: number, receiver = "Api", receiverLine = 1): MemberUseOrigin => ({ owner: { path: SITE, symbol: "run", line: 3 }, receiver: { path: API, symbol: receiver, line: receiverLine }, member: { path: API, symbol: member, line }, reference: { file: SITE, line: 4, column: 5, name: "api.load", kind: "calls" } });
const constructed = (name: string): ReceiverBinding => ({ line: 4, column: 5, receiver: "api", member: "load", holds: { kind: "constructed", name, line: 3, column: 15 } });

test("a call edge on a value receiver is redirected to the method a member proof places (R3)", async () => {
  assert.deepEqual(await verdictOf({ ...TS, receiverBindings: [constructed("Api")], memberUses: [proofOf("Api.load", 2)] }, "run"), ["redirect", "Api.load"]);
});

test("a call edge on a value of a class its file declares is proven at the method that class declares nearest, and redirected there from a method of a class above it (R2)", async () => {
  const world = (holds: string, target: string): World => ({
    nodes: [{ id: "Api", kind: "class", file: SITE, start: 1, end: 5 }, { id: "Api.load", kind: "method", name: "load", file: SITE, start: 2, end: 4 }, { id: "Sub", kind: "class", file: SITE, start: 7, end: 11 }, { id: "Sub.load", kind: "method", name: "load", file: SITE, start: 8, end: 10 }, { id: "Plain", kind: "class", file: SITE, start: 13, end: 13 }, { id: "run", kind: "function", file: SITE, start: 15, end: 18 }],
    edges: [{ from: "Api", to: "Api.load", kind: "contains" }, { from: "Sub", to: "Sub.load", kind: "contains" }, { from: "Sub", to: "Api", kind: "extends" }, { from: "Plain", to: "Api", kind: "extends" }, { from: "run", to: target, kind: "calls", line: 17, column: 4 }],
    receiverBindings: [{ line: 17, column: 5, receiver: "api", member: "load", holds: { kind: "declared", name: holds, line: holds === "Sub" ? 7 : 13 } }],
  });

  assert.deepEqual(await verdictOf(world("Sub", "Api.load"), "run"), ["redirect", "Sub.load"]);
  assert.deepEqual(await verdictOf(world("Plain", "Sub.load"), "run"), ["redirect", "Api.load"]);
  assert.deepEqual(await verdictOf(world("Plain", "Api.load"), "run"), ["keep", "proven"]);
});

test("a call edge on a value of a class that declares several methods of its name stays proven at the one the index chose, and a name match on a class that declares none", async () => {
  const world = (holds: string): World => ({
    nodes: [{ id: "Over", kind: "class", file: SITE, start: 1, end: 6 }, { id: "Over.load1", kind: "method", name: "load", file: SITE, start: 2, end: 2 }, { id: "Over.load2", kind: "method", name: "load", file: SITE, start: 3, end: 5 }, { id: "Empty", kind: "class", file: SITE, start: 8, end: 8 }, { id: "run", kind: "function", file: SITE, start: 10, end: 13 }],
    edges: [{ from: "Over", to: "Over.load1", kind: "contains" }, { from: "Over", to: "Over.load2", kind: "contains" }, { from: "run", to: "Over.load2", kind: "calls", line: 12, column: 4 }],
    receiverBindings: [{ line: 12, column: 5, receiver: "api", member: "load", holds: { kind: "declared", name: holds, line: holds === "Over" ? 1 : 8 } }],
  });

  assert.deepEqual(await verdictOf(world("Over"), "run"), ["keep", "proven"]);
  assert.deepEqual(await verdictOf(world("Empty"), "run"), ["keep", "name-match"]);
});
