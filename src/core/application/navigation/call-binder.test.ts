import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNodeId } from "../../ports/code-graph.port.ts";
import type { DeclaredCallable } from "../../ports/declared-member-names.port.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import { createCallBinder } from "./call-binder.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";
import { createGraphNavigation } from "./graph-navigation.ts";

const STORE = "src/store.ts";
const API = "src/api.ts";
const CLIENT = "src/client.ts";
const STRATEGY = "src/strategy.ts";
const CALL = { file: "src/caller.ts", line: 20, column: 5 };

function callable(name: string, start: number, body: boolean): DeclaredCallable {
  return { name, start, nameLine: start, body, overridable: true };
}

/** A binder whose callables read answers `callables` per file, and nothing the fixture did not state. */
function settling(nodes: readonly FakeNode[], edges: readonly FakeEdge[], callables: Readonly<Record<string, readonly DeclaredCallable[]>>) {
  const store = fakeCodeGraph(nodes, edges);
  const settle = createCallBinder({
    store,
    navigation: createGraphNavigation(store, () => false),
    syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }),
    proofs: async () => ({ fields: [], locals: [] }),
    importedDeclarations: async () => new Map(),
    callablesIn: async (file) => callables[file] ?? [],
  });
  return { settle, store };
}

/** `store.ts` line 3 writes `api\n    .remove(id)` inside `drop`; the relations prove `api.remove` there runs `Api.remove`. */
function binder() {
  const store = fakeCodeGraph(
    [fakeNode("drop", "function", STORE, 2, 5), fakeNode("Api", "class", API, 1, 6), fakeNode("remove", "method", API, 2, 4)],
    [{ from: "Api", to: "remove", kind: "contains" }],
  );
  const memberUses: MemberUseOrigin[] = [
    { owner: { path: STORE, symbol: "drop", line: 2 }, receiver: { path: API, symbol: "Api", line: 1 }, member: { path: API, symbol: "Api.remove", line: 2 }, reference: { file: STORE, line: 3, column: 5, name: "api.remove", kind: "calls" } },
  ];
  const settle = createCallBinder({
    store,
    navigation: createGraphNavigation(store, () => false),
    syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }),
    proofs: async () => ({ fields: [], locals: [], memberUses }),
    importedDeclarations: async () => new Map(),
    callablesIn: async () => [],
  });
  const [drop] = store.symbolsByIds(["drop" as GraphNodeId]);
  return { settle, drop: drop! };
}

/** A class of `file` spanning its members' lines, declaring one `method` node per member, named as given. */
function classWith(type: string, file: string, members: readonly { line: number; name: string }[]) {
  const nodes = [fakeNode(type, "class", file, members[0]!.line - 1, members.at(-1)!.line + 1), ...members.map(({ line, name }) => fakeNode(`${name}${line}`, "method", file, line, line, name))];
  const edges: FakeEdge[] = members.map(({ line, name }) => ({ from: type, to: `${name}${line}`, kind: "contains" }));
  return { nodes, edges };
}

test("an overload set binds to its one implementation, the member with a body", async () => {
  const { nodes, edges } = classWith("Client", CLIENT, [2, 3, 4, 5].map((line) => ({ line, name: "post" })));
  const { settle, store } = settling(nodes, edges, { [CLIENT]: [callable("post", 2, false), callable("post", 3, false), callable("post", 4, false), callable("post", 5, true)] });
  const [type] = store.symbolsByIds(["Client" as GraphNodeId]);

  for (const place of [CALL, { ...CALL, line: 24, column: 9 }]) assert.equal((await settle.memberOf(type!, "post", place))?.startLine, 5, JSON.stringify(place));
});

test("a nominal language's overloads are distinct methods: several of the name bind none, never the one that has a body", async () => {
  const SERVICE = "src/main/java/p/CustomerService.java";
  const nodes = [fakeNode("CustomerService", "interface", SERVICE, 1, 5), fakeNode("strict2", "method", SERVICE, 2, 2, "getByNick"), fakeNode("lenient3", "method", SERVICE, 3, 3, "getByNick")];
  const edges: FakeEdge[] = [{ from: "CustomerService", to: "strict2", kind: "contains" }, { from: "CustomerService", to: "lenient3", kind: "contains" }];
  const { settle, store } = settling(nodes, edges, { [SERVICE]: [callable("getByNick", 2, false), callable("getByNick", 3, true)] });
  const [type] = store.symbolsByIds(["CustomerService" as GraphNodeId]);

  assert.equal(await settle.memberOf(type!, "getByNick", CALL), undefined);
});

test("a body of another class in the same file never stands for the member, so the set binds none", async () => {
  const own = classWith("Client", CLIENT, [{ line: 2, name: "post" }, { line: 3, name: "post" }]);
  const nodes = [...own.nodes, fakeNode("Other", "class", CLIENT, 7, 10), fakeNode("post9", "method", CLIENT, 9, 9, "post")];
  const edges: FakeEdge[] = [...own.edges, { from: "Other", to: "post9", kind: "contains" }];
  const { settle, store } = settling(nodes, edges, { [CLIENT]: [callable("post", 2, false), callable("post", 3, false), callable("post", 9, true)] });
  const [type] = store.symbolsByIds(["Client" as GraphNodeId]);

  assert.equal(await settle.memberOf(type!, "post", CALL), undefined);
});

test("an overload set with a body in each of two files binds to none, never to the one its type's own file holds", async () => {
  const MERGED = "src/merged.ts";
  const nodes = [fakeNode("Client", "class", CLIENT, 1, 4), fakeNode("post2", "method", CLIENT, 2, 2, "post"), fakeNode("post3", "method", MERGED, 3, 3, "post")];
  const edges: FakeEdge[] = [{ from: "Client", to: "post2", kind: "contains" }, { from: "Client", to: "post3", kind: "contains" }];
  const { settle, store } = settling(nodes, edges, { [CLIENT]: [callable("post", 2, true)], [MERGED]: [callable("post", 3, true)] });
  const [type] = store.symbolsByIds(["Client" as GraphNodeId]);

  assert.equal(await settle.memberOf(type!, "post", CALL), undefined);
});

test("an overload set whose type's source the reader did not read binds to none", async () => {
  const { nodes, edges } = classWith("Client", CLIENT, [{ line: 2, name: "post" }, { line: 3, name: "post" }]);
  const { settle, store } = settling(nodes, edges, {});
  const [type] = store.symbolsByIds(["Client" as GraphNodeId]);

  assert.equal(await settle.memberOf(type!, "post", CALL), undefined);
});

test("an interface is a declaring type: a receiver typed with it binds the member the interface declares", async () => {
  const { nodes, edges } = classWith("Strategy", STRATEGY, [{ line: 2, name: "expire" }]);
  const iface = nodes.map((node) => (node.id === "Strategy" ? { ...node, kind: "interface" } : node));
  const { settle, store } = settling(iface, edges, { [STRATEGY]: [callable("expire", 2, false)] });
  const [type] = store.symbolsByIds(["Strategy" as GraphNodeId]);

  assert.equal((await settle.memberOf(type!, "expire", CALL))?.id, "expire2");
});

test("a type's members above it are every declaration of the name in its hierarchy, nearest type first", async () => {
  const nodes = [
    fakeNode("B", "class", "src/b.ts", 1, 6),
    fakeNode("B.save", "method", "src/b.ts", 3, 3, "save"),
    fakeNode("A", "class", "src/a.ts", 1, 9),
    fakeNode("A.save3", "method", "src/a.ts", 3, 3, "save"),
    fakeNode("A.save4", "method", "src/a.ts", 4, 4, "save"),
  ];
  const edges: FakeEdge[] = [
    { from: "B", to: "B.save", kind: "contains" },
    { from: "A", to: "A.save3", kind: "contains" },
    { from: "A", to: "A.save4", kind: "contains" },
    { from: "B", to: "A", kind: "extends" },
  ];
  const { settle, store } = settling(nodes, edges, {});
  const [type] = store.symbolsByIds(["B" as GraphNodeId]);

  assert.deepEqual(settle.membersAbove(type!, "save").map(({ id }) => id), ["B.save", "A.save3", "A.save4"]);
});

test("a member proof binds a call whose spelling breaks across lines, as it binds the same call written on one", async () => {
  const { settle, drop } = binder();
  for (const spelling of ["api.remove", "api\n    .remove", "api .remove"]) {
    const proof = await settle.receiverOf({ body: drop, line: 3, column: 5, member: "remove", receiver: "api", spelling });
    assert.equal(proof.link === "member" ? proof.method?.name : proof.link, "remove", JSON.stringify(spelling));
  }
});

test("a member proof binds a call to the one member it names, a method or a property holding a function (R3)", async () => {
  for (const kind of ["method", "property"]) {
    const store = fakeCodeGraph([fakeNode("drop", "function", STORE, 2, 5), fakeNode("Api", "class", API, 1, 6), fakeNode("remove", kind, API, 2, 4)], [{ from: "Api", to: "remove", kind: "contains" }]);
    const memberUses: MemberUseOrigin[] = [{ owner: { path: STORE, symbol: "drop", line: 2 }, receiver: { path: API, symbol: "Api", line: 1 }, member: { path: API, symbol: "Api.remove", line: 2 }, reference: { file: STORE, line: 3, column: 5, name: "api.remove", kind: "calls" } }];
    const settle = createCallBinder({ store, navigation: createGraphNavigation(store, () => false), syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }), proofs: async () => ({ fields: [], locals: [], memberUses }), importedDeclarations: async () => new Map(), callablesIn: async () => [] });
    const [drop] = store.symbolsByIds(["drop" as GraphNodeId]);
    const proof = await settle.receiverOf({ body: drop!, line: 3, column: 5, member: "remove", receiver: "api" });

    assert.equal(proof.link === "member" ? proof.method?.id : proof.link, "remove", kind);
  }
});
