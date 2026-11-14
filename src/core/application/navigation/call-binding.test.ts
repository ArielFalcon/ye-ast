import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { GraphNodeId, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DeclaredCallable } from "../../ports/declared-member-names.port.ts";
import type { AcceptedCounts, ArgumentCount, ImportOrigins, OutsideSupertypes, ReceiverMethod, RootBinding } from "../../ports/import-origins.port.ts";
import { createCallBinder, type ReceiverSyntax } from "./call-binder.ts";
import { createCallBindings, type SettledBinding } from "./call-binding.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";
import { createDeclarationModel } from "./declaration-model.ts";
import { createGraphNavigation } from "./graph-navigation.ts";

const USE = "src/use.ts";
const API = "src/api.ts";

test("a proven syntax-only holder binds through the shared model without inventing an index target", async () => {
  const store = fakeCodeGraph([], []);
  const navigation = createGraphNavigation(store, () => false);
  const declarations = createDeclarationModel({ store, declarationsIn: async () => [
    { name: "Holder", kind: "function", invoked: true, placement: { kind: "file" }, span: { start: { line: 1, column: 0 }, end: { line: 8, column: 1 } } },
    { name: "send", kind: "method", invoked: true, span: { start: { line: 3, column: 2 }, end: { line: 3, column: 20 } }, container: { line: 1, column: 0 } },
  ] });
  const importedDeclarations = async () => new Map();
  const binder = createCallBinder({ store, navigation, declarations, importedDeclarations, syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }), proofs: async () => ({ fields: [], locals: [] }), callablesIn: async () => [] });
  const bindings = createCallBindings({ store, navigation, declarations, binder, importedDeclarations, origins: {} as ImportOrigins });
  const answer = await bindings.ofReceiver({ link: "field", holds: { class: { path: API, symbol: "Holder", line: 1 } } }, "send", [], { file: USE, line: 24, column: 3 });
  assert.equal(answer.declaration?.path, "Holder.send");
  assert.equal(answer.target, undefined);
  assert.equal((await bindings.ofReceiver({ link: "none" }, "send", [], { file: USE, line: 24, column: 3 })).declaration, undefined);
});

test("an imported token receiver selects its declaration member without a fabricated graph target", async () => {
  const store = fakeCodeGraph([fakeNode("use", "function", USE, 20, 30), fakeNode("Holder", "constant", API, 1, 8), fakeNode("api-file", "file", API, 1, 8)], [{ from: "api-file", to: "Holder", kind: "contains" }]);
  const navigation = createGraphNavigation(store, () => false);
  const declarations = createDeclarationModel({ store, declarationsIn: async (file) => file === API ? [
    { name: "send", kind: "method", invoked: true, container: { line: 1, column: 0 }, binding: { line: 1, column: 0 }, span: { start: { line: 3, column: 2 }, end: { line: 4, column: 3 } } },
  ] : [] });
  const importedDeclarations = async () => new Map([["S", store.symbolsInFiles([API])[0]!]]);
  const binder = createCallBinder({ store, navigation, declarations, importedDeclarations, proofs: async () => ({ fields: [], locals: [] }), callablesIn: async () => [], syntaxIn: async () => ({
    receiverBindings: new Map([["24:3:send", { line: 24, column: 3, receiver: "s", member: "send", holds: { kind: "token", name: "S", line: 2, column: 20 } }]]),
    callees: new Map([["24:3", ["this.s.send"]]]),
  }) });
  const proof = await binder.receiverOf({ body: store.symbolsInFiles([USE])[0]!, line: 24, column: 3, receiver: "s", member: "send" });
  const bindings = createCallBindings({ store, navigation, declarations, binder, importedDeclarations, origins: {} as ImportOrigins });
  const answer = await bindings.ofReceiver(proof, "send", [], { file: USE, line: 24, column: 3 });
  assert.equal(answer.declaration?.path, "Holder.send");
  assert.equal(answer.target, undefined);
});

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
  /** The callable declarations each file's syntax states, by file; none for a file not listed. */
  callables?: Readonly<Record<string, readonly DeclaredCallable[]>>;
  /** What a file's syntax binds: its receivers by place and member, and the callee each place spells. */
  syntax?: ReceiverSyntax;
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
  const declarations = createDeclarationModel({ store, declarationsIn: async () => [] });
  const binder = createCallBinder({ store, declarations, navigation, syntaxIn: async () => world.syntax ?? { receiverBindings: new Map(), callees: new Map() }, proofs: async () => ({ fields: [], locals: [] }), importedDeclarations, callablesIn: async (file) => world.callables?.[file] ?? [] });
  const bindings = createCallBindings({ store, navigation, origins, binder, declarations, importedDeclarations });
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

/** A class `Client` in `CLIENT` declaring three `save` overloads, and a `run` method that calls `this.save`. */
function overloadedOwnCall(bodies: readonly boolean[]): World {
  const CLIENT = "src/client.ts";
  const saves = bodies.map((body, index) => ({ line: 2 + index, body }));
  return {
    nodes: [fakeNode("Client", "class", CLIENT, 1, 8), ...saves.map(({ line }) => fakeNode(`save${line}`, "method", CLIENT, line, line, "save")), fakeNode("run", "method", CLIENT, 6, 7)],
    edges: [...saves.map(({ line }) => ({ from: "Client", to: `save${line}`, kind: "contains" })), { from: "Client", to: "run", kind: "contains" }],
    callables: { [CLIENT]: [...saves.map(({ line, body }) => ({ name: "save", start: line, nameLine: line, body, overridable: true })), { name: "run", start: 6, nameLine: 6, body: true, overridable: true }] },
  };
}

test("a this-call to a method its class overloads binds to the one implementation the class declares, as an overload link", async () => {
  const [settled] = await bound(overloadedOwnCall([false, false, true]), "run", [{ name: "this.save", line: 6, kind: "calls" }]);

  assert.deepEqual(summary(settled!), ["declaration", "overload", "save4"]);
});

test("a this-call to an overload set with no implementation attributes the class's own overloads and never another class's homonym", async () => {
  const world = overloadedOwnCall([false, false, false]);
  const [settled] = await bound({ ...world, nodes: [...world.nodes, fakeNode("Other.save", "method", "src/other.ts", 3, 3, "save")] }, "run", [{ name: "this.save", line: 6, kind: "calls" }]);

  assert.deepEqual(summary(settled!), ["unbound", "own", ["save2", "save3", "save4"], ["save2", "save3", "save4"]]);
});

const JAVA = "src/main/java/p";
const PORT = `${JAVA}/Port.java`;

/** A Java holder whose `run` calls `port.load(a, b)` at line 7, `port` annotated with the interface `Port`. */
function nominalReceiver(): World {
  return {
    nodes: [fakeNode("Port", "interface", PORT, 1, 8), fakeNode("load3", "method", PORT, 3, 3, "load"), fakeNode("load4", "method", PORT, 4, 4, "load"), fakeNode("Holder", "class", `${JAVA}/Use.java`, 1, 10), fakeNode("run", "method", `${JAVA}/Use.java`, 5, 9)],
    edges: [{ from: "Port", to: "load3", kind: "contains" }, { from: "Port", to: "load4", kind: "contains" }, { from: "Holder", to: "run", kind: "contains" }],
    imports: { Port: "Port" },
    syntax: {
      receiverBindings: new Map([["7:5:load", { line: 7, column: 5, receiver: "port", member: "load", holds: { kind: "annotated", type: "Port", line: 6, column: 17 } }]]),
      callees: new Map([["7:5", ["port.load"]]]),
    },
  };
}

const PORT_CALL = [{ name: "port.load", line: 7, kind: "calls" }];
const asReceiver = (settled: SettledBinding): Extract<SettledBinding, { kind: "receiver" }> => settled as Extract<SettledBinding, { kind: "receiver" }>;

test("a nominal receiver the owner settles by arity binds to that declaration, with the members its type offers as candidates", async () => {
  const [settled] = await bound({ ...nominalReceiver(), receivers: { load: { kind: "method", file: PORT, start: 4, nameLine: 4 } } }, "run", PORT_CALL);
  const binding = asReceiver(settled!);

  assert.equal(binding.target?.id, "load4");
  assert.deepEqual(binding.candidates.map(({ id }) => id), ["load3", "load4"]);
  assert.deepEqual(binding.attributed, []);
});

test("an unproven receiver names the candidates its owner read, never the repository's set of the name", async () => {
  const [settled] = await bound({ ...nominalReceiver(), receivers: { load: { kind: "unproven", candidates: [{ file: PORT, start: 3, nameLine: 3 }] } } }, "run", PORT_CALL);
  const binding = asReceiver(settled!);

  assert.equal(binding.target, undefined);
  assert.deepEqual(binding.candidates.map(({ id }) => id), ["load3"]);
  assert.deepEqual(binding.attributed.map(({ id }) => id), ["load3"]);
});

test("an unsettled receiver's candidates are the members of its type, not the homonyms", async () => {
  const world: World = {
    nodes: [fakeNode("A", "class", "src/a.ts", 1, 8), fakeNode("A.save@3", "method", "src/a.ts", 3, 3, "save"), fakeNode("A.save@4", "method", "src/a.ts", 4, 4, "save"), fakeNode("B", "class", "src/b.ts", 1, 6), fakeNode("B.save", "method", "src/b.ts", 3, 3, "save"), fakeNode("run", "function", USE, 5, 9)],
    edges: [{ from: "A", to: "A.save@3", kind: "contains" }, { from: "A", to: "A.save@4", kind: "contains" }, { from: "B", to: "B.save", kind: "contains" }],
    imports: { A: "A" },
    syntax: {
      receiverBindings: new Map([["7:5:save", { line: 7, column: 5, receiver: "a", member: "save", holds: { kind: "annotated", type: "A", line: 6, column: 17 } }]]),
      callees: new Map([["7:5", ["a.save"]]]),
    },
  };
  const [settled] = await bound(world, "run", [{ name: "a.save", line: 7, kind: "calls" }]);
  const binding = asReceiver(settled!);
  assert.equal(binding.target, undefined);
  assert.deepEqual(binding.candidates.map(({ id }) => id), ["A.save@3", "A.save@4"]);
  assert.deepEqual(binding.attributed.map(({ id }) => id), ["A.save@3", "A.save@4"]);
  const [unproven] = await bound(world, "run", [{ name: "factory().save", line: 8, kind: "calls" }]);
  assert.deepEqual(summary(unproven!), ["unbound", "member", ["A.save@3", "A.save@4", "B.save"], []]);
});

test("a Java written reference uses declared receiver selection and attributes every ambiguous candidate", async () => {
  const file = "src/main/java/p/Use.java";
  const port = "src/main/java/p/Port.java";
  const world: World = {
    nodes: [fakeNode("run", "method", file, 1, 8), fakeNode("load1", "method", port, 3, 3, "load"), fakeNode("load2", "method", port, 4, 4, "load")],
    receivers: { load: { kind: "unproven", candidates: [{ file: port, start: 3, nameLine: 3 }, { file: port, start: 4, nameLine: 4 }] } },
  };
  const [ambiguous] = await bound(world, "run", [{ kind: "references", name: "load", line: 3 }]);
  assert.deepEqual(summary(ambiguous!), ["unbound", "bare", ["load1", "load2"], ["load1", "load2"]]);
  const [resolved] = await bound({ ...world, receivers: { load: { kind: "method", file: port, start: 3, nameLine: 3 } } }, "run", [{ kind: "references", name: "load", line: 3 }]);
  assert.deepEqual(summary(resolved!), ["declaration", "declared-receiver", "load1"]);
});

/** A Java holder whose `run` calls `map.get(k)` at line 7, `map` annotated with a type no repository declaration binds, and `holder.values().get(k)` at line 8. */
function outsideReceiver(receiver: ReceiverMethod): World {
  return {
    nodes: [fakeNode("Api", "class", `${JAVA}/Api.java`, 1, 8), fakeNode("Api.get", "method", `${JAVA}/Api.java`, 3, 3, "get"), fakeNode("Holder", "class", `${JAVA}/Use.java`, 1, 10), fakeNode("run", "method", `${JAVA}/Use.java`, 5, 9)],
    edges: [{ from: "Api", to: "Api.get", kind: "contains" }, { from: "Holder", to: "run", kind: "contains" }],
    receivers: { get: receiver },
    syntax: {
      receiverBindings: new Map([["7:5:get", { line: 7, column: 5, receiver: "map", member: "get", holds: { kind: "annotated", type: "Map", line: 6, column: 17 } }]]),
      callees: new Map([["7:5", ["map.get"]], ["8:5", ["holder.values().get"]]]),
    },
  };
}

test("a Java member call whose receiver the pack reads as a type outside the repository is an outside dispatch, never attributed to the homonyms of its name (ADR-0079 decision 4)", async () => {
  const calls = [{ name: "map.get", line: 7, kind: "calls" }, { name: "holder.values().get", line: 8, kind: "calls" }];
  const dispatched = await bound(outsideReceiver({ kind: "outside", type: "java.util.Map" }), "run", calls);
  const unproven = await bound(outsideReceiver({ kind: "unproven" }), "run", calls);

  for (const settled of dispatched) {
    const binding = asReceiver(settled);
    assert.deepEqual([binding.kind, binding.outside, binding.dispatch, binding.target, binding.attributed], ["receiver", true, { type: "java.util.Map" }, undefined, []]);
  }
  assert.deepEqual(unproven.map((settled) => [settled.kind, "dispatch" in settled ? settled.dispatch : undefined]), [["receiver", undefined], ["unbound", undefined]]);
});

test("a call the index spells as a bare name whose outside receiver runs without dispatch is an exact outside dispatch, and without the mark stays unbound (ADR-0087 decision 5)", async () => {
  const calls = [{ name: "get", line: 9, kind: "calls" }];
  const [exact] = await bound(outsideReceiver({ kind: "outside", type: "com.lib.Base", exact: true }), "run", calls);
  const [virtual] = await bound(outsideReceiver({ kind: "outside", type: "com.lib.Base" }), "run", calls);

  assert.deepEqual(asReceiver(exact!).dispatch, { type: "com.lib.Base", exact: true });
  assert.equal(virtual!.kind, "unbound");
});

/**
 * `mayRunUnder` for the declaration `Api.get` over a pack answering `answer`, asked `times` times; how often the pack was
 * asked. With `homonym`, the file also declares another `get` on line 7, for which the pack answers it.
 */
async function mayRun(type: string, answer: OutsideSupertypes | undefined, times = 1, homonym?: OutsideSupertypes): Promise<{ runs: boolean; asked: number }> {
  const store = fakeCodeGraph([fakeNode("Api.get", "method", `${JAVA}/Api.java`, 3, 3, "get"), ...(homonym === undefined ? [] : [fakeNode("Inner.get", "method", `${JAVA}/Api.java`, 7, 7, "get")])], []);
  const navigation = createGraphNavigation(store, () => false);
  const declarations = createDeclarationModel({ store, declarationsIn: async () => [] });
  let asked = 0;
  const origins = (answer === undefined ? {} : { outsideSupertypes: async (sites: readonly { start: number }[]) => { asked += 1; return sites.map(({ start }) => (start === 7 ? homonym! : answer)); } }) as unknown as ImportOrigins;
  const binder = createCallBinder({ store, declarations, navigation, syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }), proofs: async () => ({ fields: [], locals: [] }), importedDeclarations: async () => new Map(), callablesIn: async () => [] });
  const bindings = createCallBindings({ store, navigation, origins, binder, declarations, importedDeclarations: async () => new Map() });
  const declaration = store.symbolsInFiles([`${JAVA}/Api.java`]).find(({ startLine }) => startLine === 3);
  let runs = false;
  for (let index = 0; index < times; index += 1) runs = await bindings.mayRunUnder({ type }, declaration!);
  return { runs, asked };
}

test("a declaration may run under an outside type unless its pack proves it static, or lists no outside supertype while the type is not the root type (ADR-0079 decision 5)", async () => {
  const root = "java.lang.Object";
  const types = (...listed: string[]): Extract<OutsideSupertypes, { kind: "types" }> => ({ kind: "types", types: listed, root });

  assert.equal((await mayRun("java.util.Map", types())).runs, false);
  assert.equal((await mayRun(root, types())).runs, true);
  assert.equal((await mayRun("java.util.Map", types("java.util.HashMap"))).runs, true);
  assert.equal((await mayRun(root, { ...types("java.util.HashMap"), static: true })).runs, false);
  assert.equal((await mayRun("java.util.Map", { kind: "unknown" })).runs, true);
  assert.equal((await mayRun("java.util.Map", undefined)).runs, true);
});

test("a declaration its pack excludes may still run under an outside type while a homonym of its file that shares its anchor may", async () => {
  const types = (...listed: string[]): OutsideSupertypes => ({ kind: "types", types: listed, root: "java.lang.Object" });

  assert.equal((await mayRun("java.util.Map", types(), 1, types("java.util.HashMap"))).runs, true);
  assert.equal((await mayRun("java.util.Map", types(), 1, types())).runs, false);
});

test("the outside supertypes of a declaration are asked once for the read", async () => {
  assert.equal((await mayRun("java.util.Map", { kind: "types", types: [] }, 3)).asked, 1);
});

/**
 * `takesNoCount` for a call `list.get` and the declaration `get` on line 3 of `Api.java`, over a pack that reads `written`
 * at every call and `accepted` by a declaration's first line; `homonym` adds a second `get` of the file on line 5.
 * How often each reading was asked, and how many sites it was asked for.
 */
async function noCount(written: ArgumentCount, accepted: Readonly<Record<number, AcceptedCounts>>, options: { homonym?: true; times?: number; absent?: true } = {}): Promise<{ excluded: readonly boolean[]; counts: number[]; accepts: number[] }> {
  const nodes = [fakeNode("Api.get", "method", `${JAVA}/Api.java`, 3, 3, "get"), fakeNode("run", "method", `${JAVA}/Use.java`, 5, 9), ...(options.homonym ? [fakeNode("Api.get2", "method", `${JAVA}/Api.java`, 5, 5, "get")] : [])];
  const store = fakeCodeGraph(nodes, []);
  const navigation = createGraphNavigation(store, () => false);
  const declarations = createDeclarationModel({ store, declarationsIn: async () => [] });
  const counts: number[] = [];
  const accepts: number[] = [];
  const origins = (options.absent ? {} : {
    argumentCounts: async (sites: readonly unknown[]) => (counts.push(sites.length), sites.map(() => written)),
    acceptedCounts: async (sites: readonly { start: number }[]) => (accepts.push(sites.length), sites.map(({ start }) => accepted[start] ?? { kind: "unknown" })),
  }) as unknown as ImportOrigins;
  const binder = createCallBinder({ store, declarations, navigation, syntaxIn: async () => ({ receiverBindings: new Map(), callees: new Map() }), proofs: async () => ({ fields: [], locals: [] }), importedDeclarations: async () => new Map(), callablesIn: async () => [] });
  const bindings = createCallBindings({ store, navigation, origins, binder, declarations, importedDeclarations: async () => new Map() });
  const [declaration] = store.symbolsInFiles([`${JAVA}/Api.java`]);
  const [body] = store.symbolsInFiles([`${JAVA}/Use.java`]);
  const call = { body: body!, reference: { from: body!.id, file: `${JAVA}/Use.java`, line: 7, column: 4, name: "list.get", kind: "calls", candidates: [] } };
  let excluded: readonly boolean[] = [];
  for (let index = 0; index < (options.times ?? 1); index += 1) excluded = await bindings.takesNoCount([{ call, declaration: declaration! }, { call, declaration: declaration! }]);
  return { excluded, counts, accepts };
}

test("a call is no call of a declaration that does not accept the number of arguments it writes, unless either count is unknown (ADR-0084 decision 2)", async () => {
  const count = (n: number): ArgumentCount => ({ kind: "count", count: n });

  assert.deepEqual((await noCount(count(1), { 3: { kind: "counts", count: 4 } })).excluded, [true, true]);
  assert.deepEqual((await noCount(count(4), { 3: { kind: "counts", count: 4 } })).excluded, [false, false]);
  assert.deepEqual((await noCount(count(0), { 3: { kind: "counts", count: 1, upward: true } })).excluded, [true, true]);
  assert.deepEqual((await noCount(count(1), { 3: { kind: "counts", count: 1, upward: true } })).excluded, [false, false]);
  assert.deepEqual((await noCount(count(5), { 3: { kind: "counts", count: 1, upward: true } })).excluded, [false, false]);
  assert.deepEqual((await noCount({ kind: "unknown" }, { 3: { kind: "counts", count: 4 } })).excluded, [false, false]);
  assert.deepEqual((await noCount(count(1), {})).excluded, [false, false]);
  assert.deepEqual((await noCount(count(1), { 3: { kind: "counts", count: 4 } }, { absent: true })).excluded, [false, false]);
});

test("a homonym of the file that shares the declaration's anchor and accepts the count keeps the call", async () => {
  const count: ArgumentCount = { kind: "count", count: 2 };

  assert.deepEqual((await noCount(count, { 3: { kind: "counts", count: 3 }, 5: { kind: "counts", count: 2 } }, { homonym: true })).excluded, [false, false]);
  assert.deepEqual((await noCount(count, { 3: { kind: "counts", count: 3 }, 5: { kind: "counts", count: 1 } }, { homonym: true })).excluded, [true, true]);
});

test("each call site and each declaration is read once for the read, in one batch", async () => {
  const { counts, accepts } = await noCount({ kind: "count", count: 1 }, { 3: { kind: "counts", count: 4 } }, { homonym: true, times: 3 });

  assert.deepEqual([counts, accepts], [[1], [2]]);
});
