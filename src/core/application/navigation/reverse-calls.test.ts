import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { CallBindings, SettledBinding, UnboundCall } from "./call-binding.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";
import { createGraphNavigation } from "./graph-navigation.ts";
import type { BodyCalls, ReconciledCalls } from "./reconciled-calls.ts";
import { createReverseCalls } from "./reverse-calls.ts";

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
function setup(nodes: readonly FakeNode[], edges: readonly FakeEdge[], written: readonly Written[], bind: (call: UnboundCall) => SettledBinding, imports: Readonly<Record<string, Readonly<Record<string, string>>>> = {}, text: Readonly<Record<string, string>> = {}) {
  const store = fakeCodeGraph(nodes, edges);
  const navigation = createGraphNavigation(store, () => false);
  const read: string[] = [];
  const empty: BodyCalls = { edges: [], references: [], contradicted: [], writtenOnly: [], ambiguous: [], deferredOnly: [] };
  const reconciled: ReconciledCalls = {
    ownedIn: async () => new Map(),
    async callsOf(body) {
      read.push(body.id);
      const mine = written.filter((call) => call.body === body.id).map((call): GraphUnresolvedReference & { deferred?: true } => ({ from: body.id, file: body.file, line: call.line, column: 2, name: call.name, kind: call.kind ?? "calls", candidates: [], ...(call.deferred ? { deferred: true } : {}) }));
      return { ...empty, writtenOnly: mine.filter((call) => call.deferred !== true), deferredOnly: mine.filter((call) => call.deferred === true) };
    },
  };
  const bindings = { boundCalls: async (calls: readonly UnboundCall[]) => calls.map(bind) } as unknown as CallBindings;
  const files = [...new Set(nodes.map(({ file }) => file))];
  const sources = files.map((path) => ({ path, content: text[path] ?? written.filter((call) => nodes.find(({ id }) => id === call.body)?.file === path).map(({ name }) => `${name}();`).join("\n") }));
  const importedDeclarations = async (file: string) => new Map(Object.entries(imports[file] ?? {}).map(([local, id]) => [local, store.symbolsByIds([id as GraphNodeId])[0]!]));
  const reverse = createReverseCalls({ store, navigation, reconciled, bindings, importedDeclarations, sources, constructs: async () => false });
  const symbol = (id: string): GraphSymbol => store.symbolsByIds([id as GraphNodeId])[0]!;
  return { reverse, symbol, read };
}

const declaration = (target: GraphSymbol): SettledBinding => ({ kind: "declaration", target, link: "import" });

test("an import alias is looked up only in the file whose import binds it, even in a source another name aligns, and a deferred call counts as any other", async () => {
  const nodes = [fakeNode("fetch", "function", "src/api.ts", 1, 3), fakeNode("a", "constant", "src/a.ts", 2, 4), fakeNode("b", "constant", "src/b.ts", 2, 4)];
  const edges: FakeEdge[] = [{ from: "a", to: "fetch", kind: "imports", line: 1, column: 0 }];
  const { reverse, symbol } = setup(nodes, edges, [{ body: "a", line: 3, name: "load", deferred: true }, { body: "b", line: 3, name: "load" }], () => declaration(symbol("fetch")), { "src/a.ts": { load: "fetch" } }, { "src/b.ts": "load(); fetch;" });

  const { edges: found } = await reverse.into([symbol("fetch")]);
  assert.deepEqual(found.map(({ source, edge }) => `${source.id}@${edge.line}`), ["a@3"]);
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

  assert.deepEqual(read, ["a"]);
});
