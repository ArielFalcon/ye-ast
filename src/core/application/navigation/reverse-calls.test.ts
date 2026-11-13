import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { BindingCall, CallBinding, CallBindings, SettledBinding, UnboundCall } from "./call-binding.ts";
import type { ReceiverMethod } from "../../ports/import-origins.port.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";
import { createGraphNavigation } from "./graph-navigation.ts";
import type { BodyCalls, OwnedCall, ReconciledCalls } from "./reconciled-calls.ts";
import { createReverseCalls, type ReverseCallsDeps } from "./reverse-calls.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";

interface Written {
  body: string;
  line: number;
  name: string;
  kind?: string;
  deferred?: true;
}

/**
 * `into(nodes)` over written calls no record matches, each bound by `bind` (by spelling), with `imports` the local names
 * each file's imports bind and `text` each source's content (by default its calls' spellings).
 */
function setup(nodes: readonly FakeNode[], edges: readonly FakeEdge[], written: readonly Written[], bind: (call: UnboundCall) => CallBinding, imports: Readonly<Record<string, Readonly<Record<string, string>>>> = {}, text: Readonly<Record<string, string>> = {}, retained?: ReverseCallsDeps["retained"], receiverMethods: readonly ReceiverMethod[] = []) {
  const store = fakeCodeGraph(nodes, edges);
  const navigation = createGraphNavigation(store, () => false);
  const read: string[] = [];
  const empty: BodyCalls = { edges: [], references: [], contradicted: [], writtenOnly: [], ambiguous: [], deferredOnly: [] };
  const reconciled: ReconciledCalls = {
    ownedIn: async (file) => (read.push(`owned ${file}`), new Map(nodes.filter((node) => node.file === file).map((node) => [node.id as GraphNodeId, written.filter((call) => call.body === node.id).map((call): OwnedCall => ({ kind: (call.kind ?? "calls") as OwnedCall["kind"], line: call.line, column: 3, name: call.name, owners: [] }))]))),
    contradictedIn: async () => [],
    async callsOf(body) {
      read.push(body.id);
      const mine = written.filter((call) => call.body === body.id).map((call): GraphUnresolvedReference & { deferred?: true } => ({ from: body.id, file: body.file, line: call.line, column: 2, name: call.name, kind: call.kind ?? "calls", candidates: [], ...(call.deferred ? { deferred: true } : {}) }));
      return { ...empty, writtenOnly: mine.filter((call) => call.deferred !== true), deferredOnly: mine.filter((call) => call.deferred === true) };
    },
  };
  const bound: string[] = [];
  const bindings = {
    bindCalls: async (calls: readonly UnboundCall[]) => calls.map((call) => (bound.push(call.reference.name), bind(call))),
    settleDeclared: (): SettledBinding => ({ kind: "unbound", form: "member", candidates: [], attributed: [] }),
  } as unknown as CallBindings;
  const files = [...new Set(nodes.map(({ file }) => file))];
  const sources = files.map((path) => ({ path, content: text[path] ?? written.filter((call) => nodes.find(({ id }) => id === call.body)?.file === path).map(({ name }) => `${name}();`).join("\n") }));
  const importedDeclarations = async (file: string) => new Map(Object.entries(imports[file] ?? {}).map(([local, id]) => [local, store.symbolsByIds([id as GraphNodeId])[0]!]));
  const reverse = createReverseCalls({ store, navigation, reconciled, bindings, origins: { receiverMethods: async () => receiverMethods }, importedDeclarations, sources, constructs: async () => false, ...(retained === undefined ? {} : { retained }) });
  const symbol = (id: string): GraphSymbol => store.symbolsByIds([id as GraphNodeId])[0]!;
  return { reverse, symbol, read, bound };
}

const declaration = (target: GraphSymbol): SettledBinding => ({ kind: "declaration", target, link: "import" });

test("an import alias is looked up only in the file whose import binds it, even in a source another name aligns, and a deferred call counts as any other", async () => {
  const nodes = [fakeNode("fetch", "function", "src/api.ts", 1, 3), fakeNode("a", "constant", "src/a.ts", 2, 4), fakeNode("b", "constant", "src/b.ts", 2, 4)];
  const edges: FakeEdge[] = [{ from: "a", to: "fetch", kind: "imports", line: 1, column: 0 }];
  const { reverse, symbol } = setup(nodes, edges, [{ body: "a", line: 3, name: "load", deferred: true }, { body: "b", line: 3, name: "load" }], () => declaration(symbol("fetch")), { "src/a.ts": { load: "fetch" } }, { "src/b.ts": "load(); fetch;" });

  const { edges: found } = await reverse.into([symbol("fetch")]);
  assert.deepEqual(found.map(({ source, edge }) => `${source.id}@${edge.line}`), ["a@3"]);
});

test("a default import the binder resolves by the exported name, with its imports edge at the file, is looked up by its alias", async () => {
  const nodes = [fakeNode("apiFile", "file", "src/api.ts", 1, 3), fakeNode("original", "function", "src/api.ts", 1, 1), fakeNode("result", "constant", "src/use.ts", 2, 2)];
  const edges: FakeEdge[] = [{ from: "result", to: "apiFile", kind: "imports", line: 1, column: 7 }];
  const { reverse, symbol } = setup(nodes, edges, [{ body: "result", line: 2, name: "renamed" }], () => declaration(symbol("original")), { "src/use.ts": { renamed: "original" } });

  const { edges: found } = await reverse.into([symbol("original")]);
  assert.deepEqual(found.map(({ source, edge }) => `${source.id}@${edge.line}`), ["result@2"]);
});

test("a default-exported class constructed under its alias is an edge into its constructor, with the imports edge at the file", async () => {
  const nodes = [fakeNode("widgetFile", "file", "src/widget.ts", 1, 9), fakeNode("Widget", "class", "src/widget.ts", 1, 9), fakeNode("Widget.ctor", "method", "src/widget.ts", 2, 4, "constructor"), fakeNode("make", "function", "src/use.ts", 2, 4)];
  const edges: FakeEdge[] = [{ from: "Widget", to: "Widget.ctor", kind: "contains" }, { from: "make", to: "widgetFile", kind: "imports", line: 1, column: 7 }];
  const { reverse, symbol } = setup(nodes, edges, [{ body: "make", line: 3, name: "Panel", kind: "instantiates" }], () => declaration(symbol("Widget")), { "src/use.ts": { Panel: "Widget" } });

  const { edges: found } = await reverse.into([symbol("Widget.ctor")]);
  assert.deepEqual(found.map(({ target, edge }) => `${target.id}@${edge.line}`), ["Widget.ctor@3"]);
});

test("new C() bound to a class is an edge into its one constructor, and an unbound call is a cut only for the declarations it is attributed to", async () => {
  const nodes = [fakeNode("C", "class", "src/c.ts", 1, 9, "C"), fakeNode("C.ctor", "method", "src/c.ts", 2, 4, "constructor"), fakeNode("C.save", "method", "src/c.ts", 5, 7, "save"), fakeNode("D.save", "method", "src/d.ts", 2, 4, "save"), fakeNode("use", "function", "src/use.ts", 1, 9)];
  const edges: FakeEdge[] = [{ from: "C", to: "C.ctor", kind: "contains" }, { from: "C", to: "C.save", kind: "contains" }];
  const written: Written[] = [{ body: "use", line: 2, name: "C", kind: "instantiates" }, { body: "use", line: 3, name: "x.save" }];
  const { reverse, symbol } = setup(nodes, edges, written, (call) => (call.reference.kind === "instantiates" ? declaration(symbol("C")) : { kind: "unbound", form: "member", candidates: [symbol("C.save"), symbol("D.save")], attributed: [symbol("C.save")] }));

  const into = await reverse.into([symbol("C.ctor"), symbol("C.save"), symbol("D.save")]);
  assert.deepEqual(into.edges.map(({ target, edge }) => `${target.id}@${edge.line}`), ["C.ctor@2"]);
  assert.deepEqual(into.attributed.map(({ node, call }) => `${node.id}@${call.reference.line}`), ["C.save@3"]);
});

test("a source whose text spells no name a reached declaration is looked up by is never aligned, and each source is aligned once", async () => {
  const nodes = [fakeNode("fetch", "function", "src/api.ts", 1, 3), fakeNode("a", "constant", "src/a.ts", 2, 4), fakeNode("b", "constant", "src/b.ts", 2, 4)];
  const written: Written[] = [{ body: "a", line: 3, name: "fetch" }, { body: "b", line: 3, name: "other" }];
  const { reverse, symbol, read } = setup(nodes, [], written, () => declaration(symbol("fetch")));
  await reverse.into([symbol("fetch")]);
  await reverse.into([symbol("fetch")]);

  assert.deepEqual(read.filter((entry) => !entry.startsWith("owned ")), ["a"]);
});

test("a source whose text spells a looked-up name but none of whose written calls calls it is never aligned", async () => {
  const nodes = [fakeNode("fetch", "function", "src/api.ts", 1, 3), fakeNode("a", "constant", "src/a.ts", 2, 4), fakeNode("b", "constant", "src/b.ts", 2, 4)];
  const written: Written[] = [{ body: "a", line: 3, name: "api.fetch" }, { body: "b", line: 3, name: "fetch.other" }];
  const { reverse, symbol, read } = setup(nodes, [], written, () => declaration(symbol("fetch")), {}, { "src/b.ts": "fetch.other(); // fetch" });
  await reverse.into([symbol("fetch")]);

  assert.deepEqual(read.filter((entry) => !entry.startsWith("owned ")), ["a"]);
});

test("with the index digest and derived facts, a second read finds the calls the first aligned without aligning any source, and another index aligns again", async () => {
  const kept = new Map<string, string>();
  const facts: DerivedFacts = {
    ofFile: (_slot, _file, derive) => derive(),
    async ofInputs(slot, inputs, derive) {
      const key = JSON.stringify([slot, inputs]);
      if (!kept.has(key)) kept.set(key, JSON.stringify(await derive()));
      return JSON.parse(kept.get(key)!);
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
  const nodes = [fakeNode("fetch", "function", "src/api.ts", 1, 3), fakeNode("a", "constant", "src/a.ts", 2, 4), fakeNode("b", "constant", "src/b.ts", 2, 4)];
  const written: Written[] = [{ body: "a", line: 3, name: "fetch" }, { body: "b", line: 3, name: "other" }];
  const read = (index: string) => {
    const world = setup(nodes, [], written, () => declaration(world.symbol("fetch")), {}, {}, { facts, index });
    return world;
  };

  const first = read("one");
  const found = await first.reverse.into([first.symbol("fetch")]);
  const again = read("one");
  const refound = await again.reverse.into([again.symbol("fetch")]);
  const other = read("two");
  await other.reverse.into([other.symbol("fetch")]);

  assert.deepEqual(first.read, ["owned src/a.ts", "a"]);
  assert.deepEqual(refound.edges.map(({ source, edge }) => `${source.id}@${edge.line}`), found.edges.map(({ source, edge }) => `${source.id}@${edge.line}`));
  assert.deepEqual(found.edges.map(({ source }) => source.id), ["a"]);
  assert.deepEqual(again.read, []);
  assert.deepEqual(other.read, ["owned src/a.ts", "a"]);
});

test("a retained call whose body the index no longer holds realigns its source instead of being dropped", async () => {
  const kept = new Map<string, string>();
  const facts: DerivedFacts = {
    ofFile: (_slot, _file, derive) => derive(),
    async ofInputs(slot, inputs, derive) {
      const key = JSON.stringify([slot, inputs]);
      if (!kept.has(key)) kept.set(key, JSON.stringify(await derive()));
      return JSON.parse(kept.get(key)!);
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
  const read = (body: string) => {
    const world = setup([fakeNode("fetch", "function", "src/api.ts", 1, 3), fakeNode(body, "constant", "src/a.ts", 2, 4)], [], [{ body, line: 3, name: "fetch" }], () => declaration(world.symbol("fetch")), {}, { "src/a.ts": "fetch();" }, { facts, index: "same" });
    return world;
  };

  await read("a").reverse.into([read("a").symbol("fetch")]);
  const moved = read("a2");
  const found = await moved.reverse.into([moved.symbol("fetch")]);

  assert.deepEqual(found.edges.map(({ source, edge }) => `${source.id}@${edge.line}`), ["a2@3"]);
  assert.deepEqual(moved.read.filter((entry) => !entry.startsWith("owned ")), ["a2"]);
});

test("an index reference is settled for a reached declaration by what its binding names instead, and never when the binding proves nothing", async () => {
  const nodes = [fakeNode("Api.get", "method", "src/api.ts", 2, 4, "get"), fakeNode("Store.get", "method", "src/store.ts", 2, 4, "get"), fakeNode("C", "class", "src/c.ts", 1, 9, "C"), fakeNode("C.one", "method", "src/c.ts", 2, 3, "constructor"), fakeNode("C.two", "method", "src/c.ts", 4, 5, "constructor"), fakeNode("use", "function", "src/use.ts", 1, 9)];
  const edges: FakeEdge[] = [{ from: "C", to: "C.one", kind: "contains" }, { from: "C", to: "C.two", kind: "contains" }];
  const written: Written[] = [{ body: "use", line: 2, name: "Paths.get" }, { body: "use", line: 3, name: "repo.get" }, { body: "use", line: 4, name: "store.get" }, { body: "use", line: 5, name: "row.get" }, { body: "use", line: 6, name: "x.get" }, { body: "use", line: 7, name: "C", kind: "instantiates" }];
  const { reverse, symbol } = setup(nodes, edges, written, (call): CallBinding => {
    const byLine: Record<number, CallBinding> = {
      2: { kind: "outside", form: "chain", origin: { kind: "external", module: "java.nio.file" } },
      3: { kind: "declared", member: "get", form: "member", call: call as BindingCall },
      4: declaration(symbol("Store.get")),
      5: { kind: "unbound", form: "member", candidates: [symbol("Api.get"), symbol("Store.get")], attributed: [] },
      6: { kind: "receiver", proof: { link: "none" }, candidates: [], attributed: [symbol("Store.get")] },
      7: declaration(symbol("C")),
    };
    return byLine[call.reference.line]!;
  }, {}, {}, undefined, [{ kind: "generated" }]);

  const { settled } = await reverse.into([symbol("Api.get"), symbol("C.one")]);
  assert.deepEqual(settled.map((entry) => `${entry.node.id}@${JSON.parse(entry.occurrence)[1]}:${"away" in entry ? entry.away.map(({ id }) => id).join(",") : `via ${entry.via.id}`}`), ["Api.get@2:", "Api.get@3:", "Api.get@4:Store.get", "Api.get@6:Store.get"]);
});

test("a written call whose name no reached declaration is looked up by is never passed to the binder", async () => {
  const nodes = [fakeNode("fetch", "function", "src/api.ts", 1, 3), fakeNode("a", "constant", "src/a.ts", 2, 4)];
  const written: Written[] = [{ body: "a", line: 3, name: "api.fetch" }, { body: "a", line: 4, name: "api.store" }];
  const { reverse, symbol, bound } = setup(nodes, [], written, () => declaration(symbol("fetch")));
  await reverse.into([symbol("fetch")]);

  assert.deepEqual(bound, ["api.fetch"]);
});
