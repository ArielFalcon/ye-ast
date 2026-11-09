import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { GraphNodeId, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOrigins, ReceiverMethod, RootBinding } from "../../ports/import-origins.port.ts";
import { createCallBinder } from "./call-binder.ts";
import { createCallBindings, type SettledBinding } from "./call-binding.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";
import { createGraphNavigation } from "./graph-navigation.ts";

const USE = "src/use.ts";
const API = "src/api.ts";

interface World {
  nodes: readonly FakeNode[];
  edges?: readonly FakeEdge[];
  /** What `origins` answers per callee spelling; unknown otherwise. */
  origins?: Readonly<Record<string, ImportOrigin>>;
  /** What `rootBindings` answers per spelled root; unknown otherwise. */
  bindings?: Readonly<Record<string, RootBinding>>;
  /** What `rootOrigins` answers per name the site reaches; unknown otherwise. */
  roots?: Readonly<Record<string, ImportOrigin>>;
  /** What `receiverMethods` answers per member; unknown otherwise. */
  receivers?: Readonly<Record<string, ReceiverMethod>>;
  /** The declarations a file's imports bind, by local name. */
  imports?: Readonly<Record<string, string>>;
}

/** The binding of each call `body` writes, as `name@line`, through the base's public seam. */
async function bound(world: World, body: string, calls: readonly Pick<GraphUnresolvedReference, "name" | "line" | "kind">[]): Promise<readonly SettledBinding[]> {
  const store = fakeCodeGraph(world.nodes, world.edges ?? []);
  const navigation = createGraphNavigation(store, () => false);
  const unknown: Finding<ImportOrigin> = { status: "unknown", reason: "unresolved", evidence: [] };
  const origins = {
    origins: async (sites) => sites.map((site) => (site.fullName !== undefined && world.origins?.[site.fullName] !== undefined ? { status: "complete", value: world.origins[site.fullName]!, evidence: [], occurrence: true } : unknown)),
    rootOrigins: async (sites) => sites.map((site) => (world.roots?.[site.name] === undefined ? unknown : { status: "complete", value: world.roots[site.name]!, evidence: [] })),
    rootBindings: async (sites) => sites.map((site) => world.bindings?.[site.spelled] ?? { kind: "unknown" }),
    receiverMethods: async (sites) => sites.map((site) => world.receivers?.[site.member] ?? { kind: "unknown" }),
  } as Pick<ImportOrigins, "origins" | "rootOrigins" | "rootBindings" | "receiverMethods"> as ImportOrigins;
  const imported = new Map(Object.entries(world.imports ?? {}).map(([local, id]) => [local, store.symbolsByIds([id as GraphNodeId])[0]!]));
  const importedDeclarations = async () => imported;
  const binder = createCallBinder({ store, navigation, syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }), proofs: async () => ({ fields: [], locals: [] }), importedDeclarations });
  const bindings = createCallBindings({ store, navigation, origins, binder, importedDeclarations });
  const [from] = store.symbolsByIds([body as GraphNodeId]);
  const file = from!.file;
  return bindings.boundCalls(calls.map((call) => ({ body: from!, reference: { from: from!.id, file, column: 4, candidates: [], ...call } })));
}

const summary = (binding: SettledBinding): unknown =>
  binding.kind === "declaration" ? [binding.kind, binding.link, binding.target.id] : binding.kind === "unbound" ? [binding.kind, binding.form, binding.candidates.map(({ id }) => id), binding.attributed.map(({ id }) => id)] : [binding.kind];

test("a bare call binds the declaration its import proves, the one its file declares where the name is bound, or nothing outside the repository", async () => {
  const world: World = {
    nodes: [fakeNode("run", "function", USE, 5, 9), fakeNode("helper", "function", USE, 1, 3), fakeNode("load", "function", API, 1, 3, "getArticle"), fakeNode("other", "function", API, 5, 7, "helper")],
    imports: { load: "load" },
    bindings: { load: { kind: "import", root: "load", origin: { kind: "repository", file: API } }, helper: { kind: "declared", root: "helper", lines: [1], captured: false } },
    origins: { inject: { kind: "external", module: "@angular/core" } },
  };
  const calls = [{ name: "load", line: 6, kind: "calls" }, { name: "helper", line: 7, kind: "calls" }, { name: "inject", line: 8, kind: "calls" }];

  assert.deepEqual((await bound(world, "run", calls)).map(summary), [["declaration", "import", "load"], ["declaration", "file", "helper"], ["outside"]]);
});

test("a bare call binds the import of its name only where its occurrence reads that import, never under a local binding", async () => {
  const nodes = [fakeNode("run", "function", USE, 5, 9), fakeNode("load", "function", API, 1, 3)];
  const call = [{ name: "load", line: 6, kind: "calls" }];
  const shadowing: readonly RootBinding[] = [
    { kind: "local", root: "load", lines: [5] },
    { kind: "declared", root: "load", lines: [2], captured: true },
    { kind: "unknown" },
  ];

  for (const binding of shadowing) {
    const [settled] = await bound({ nodes, imports: { load: "load" }, bindings: { load: binding } }, "run", call);
    assert.deepEqual(summary(settled!), ["unbound", "bare", ["load"], []], binding.kind);
  }
});

test("a bare Java call to a method its class declares never binds a static import of that name", async () => {
  const USE_JAVA = "src/main/java/app/Use.java";
  const nodes = [fakeNode("run", "method", USE_JAVA, 5, 9), fakeNode("load", "method", "src/main/java/app/Util.java", 1, 3)];
  const [settled] = await bound({ nodes, imports: { load: "load" }, bindings: { load: { kind: "this", member: "load" } } }, "run", [{ name: "load", line: 6, kind: "calls" }]);

  assert.notDeepEqual(summary(settled!), ["declaration", "import", "load"]);
});

test("a bare call nothing binds is attributed only to the declarations of its own file, and a member call on a call result to none (fixture 10)", async () => {
  const world: World = { nodes: [fakeNode("run", "function", USE, 5, 9), fakeNode("save", "function", USE, 1, 3), fakeNode("Repo.save", "method", API, 2, 4, "save")] };
  const calls = [{ name: "save", line: 6, kind: "calls" }, { name: "factory().save", line: 7, kind: "calls" }];

  assert.deepEqual((await bound(world, "run", calls)).map(summary), [["unbound", "bare", ["Repo.save", "save"], ["save"]], ["unbound", "member", ["Repo.save", "save"], []]]);
});

test("a member call on a callback parameter is attributed to none of its homonyms, and one rooted at a library global is outside the repository (fixtures 11 and 12)", async () => {
  const world: World = { nodes: [fakeNode("run", "function", USE, 5, 9), fakeNode("Repo.save", "method", API, 2, 4, "save"), fakeNode("max", "function", API, 6, 8)], roots: { max: { kind: "ambient", name: "Math" } } };
  const calls = [{ name: "item.save", line: 6, kind: "calls" }, { name: "Math.max", line: 7, kind: "calls" }];

  assert.deepEqual((await bound(world, "run", calls)).map(summary), [["unbound", "member", ["Repo.save"], []], ["outside"]]);
});

test("super(...) binds the constructor the receiver reading names; several of its arity are attributed to the superclass's constructors, and a superclass declaring none is its implicit one", async () => {
  const java = (name: string) => `src/main/java/p/${name}.java`;
  const nodes = [fakeNode("A", "class", java("A"), 3, 9), fakeNode("A1", "method", java("A"), 4, 5, "A"), fakeNode("A2", "method", java("A"), 7, 8, "A"), fakeNode("B", "class", java("B"), 3, 9), fakeNode("B1", "method", java("B"), 4, 6, "B"), fakeNode("E", "class", java("E"), 1, 2), fakeNode("F", "class", java("F"), 3, 9), fakeNode("F1", "method", java("F"), 4, 6, "F")];
  const edges: FakeEdge[] = [{ from: "A", to: "A1", kind: "contains" }, { from: "A", to: "A2", kind: "contains" }, { from: "B", to: "B1", kind: "contains" }, { from: "B", to: "A", kind: "extends" }, { from: "F", to: "F1", kind: "contains" }, { from: "F", to: "E", kind: "extends" }];
  const call = [{ name: "super", line: 5, kind: "calls" }];

  assert.deepEqual((await bound({ nodes, edges, receivers: { super: { kind: "method", file: java("A"), start: 4, nameLine: 4 } } }, "B1", call)).map(summary), [["declaration", "chain", "A1"]]);
  assert.deepEqual((await bound({ nodes, edges, receivers: { super: { kind: "unproven" } } }, "B1", call)).map(summary), [["unbound", "chain", ["A1", "A2"], ["A1", "A2"]]]);
  assert.deepEqual((await bound({ nodes, edges }, "F1", call)).map(summary), [["declaration", "chain", "E"]]);
});
