import assert from "node:assert/strict";
import test from "node:test";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Fact, Finding } from "../../domain/shared/fact.ts";
import type { TraceStep, TraceValue } from "../../domain/trace/trace-fact.ts";
import type { ImportOriginSite, ReplacedRoots, ResolvedNameSite } from "../../ports/import-origins.port.ts";
import type { CallersTarget } from "../../ports/impact-queries.port.ts";
import type { TraceBudget, TraceRequest } from "../../ports/trace-queries.port.ts";
import { fakeLive, type FakeLive } from "../live/fake-live.testing.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode, type FakeUnresolved } from "../navigation/fake-code-graph.testing.ts";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { RelationExtraction } from "../relations/relation-extractor.ts";
import { createTraceQueries, type TraceQueriesDeps } from "./trace-queries.ts";

const SHA = "a".repeat(40);
const SUMMARY = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "fake", schema: 0, extraction: 0 } };
const A = "src/a.ts";
const B = "src/b.ts";

type Origin = Finding<ImportOrigin> & { occurrence?: true };

interface Options {
  nodes: readonly FakeNode[];
  edges?: readonly FakeEdge[];
  unresolved?: readonly FakeUnresolved[];
  /** What the import origins answer for a site, by its full spelling; unknown otherwise. */
  origins?: Readonly<Record<string, ImportOrigin>>;
  /** Runs when the walk asks for origins. */
  onOrigins?: () => void;
  /** Where the root of an edge's spelled name is bound, by the name the edge reaches, `bare` when the site spells the root alone; unknown otherwise. */
  roots?: Readonly<Record<string, ImportOrigin & { bare?: true }>>;
  matches?: (path: string, glob: string) => boolean;
  indexFails?: boolean;
  live?: FakeLive;
  /** Runs each time the walk reads the store's unresolved references, with the files it asks for. */
  onUnresolved?: (files: readonly string[]) => void;
  /** What every read of the store's edges throws. */
  storeFails?: Error;
  /** The head's sources, as the export reader hands them over. */
  sources?: readonly { path: string; content: string }[];
  /** The trivia lines a tokenizer reads in each source, by path. */
  trivia?: Readonly<Record<string, readonly number[]>>;
  /** Runs each time the walk asks for a file's trivia lines. */
  onTrivia?: (path: string) => void;
  /** The member names each source declares in value positions, by path. */
  memberNames?: Readonly<Record<string, readonly string[]>>;
  /** Runs each time the walk reads a source's member names. */
  onMemberNames?: (path: string) => void;
  /** The receiver bindings each source's syntax proves, by path. */
  receiverBindings?: Readonly<Record<string, readonly ReceiverBinding[]>>;
  /** The roots the snapshot replaces; none by default. */
  replaced?: ReplacedRoots;
  /** The member calls the relations prove. */
  proofs?: Pick<RelationExtraction, "memberUses" | "externalUses">;
}

function setup(options: Options) {
  const log = { closed: 0 };
  const graph = fakeCodeGraph(options.nodes, options.edges ?? [], options.unresolved ?? []);
  const failing = options.storeFails;
  const unresolvedReferences = (files: readonly string[]) => (options.onUnresolved?.(files), graph.unresolvedReferences(files));
  const store = { ...graph, unresolvedReferences, ...(failing && { outgoingEdges: () => { throw failing; } }), close: () => void (log.closed += 1) };
  const answer = (site: ImportOriginSite): Origin => {
    const origin = site.fullName === undefined ? undefined : options.origins?.[site.fullName];
    return origin === undefined ? { status: "unknown", reason: "unresolved", evidence: [] } : { status: "complete", value: origin, evidence: [], occurrence: true };
  };
  const deps = {
    vcs: {
      resolveCommit: async () => ({ ok: true, value: SHA }),
      exportCommit: async () => ({ ok: true, value: { files: [A, B].map((path) => ({ path, blob: "1", written: true })), skipped: [] } }),
    },
    scratch: { create: async () => "/scratch/head", remove: async () => undefined },
    reader: { read: async () => options.sources ?? [] },
    extractor: { extract: () => [] },
    digest: { of: (value: string) => `digest:${value}` },
    producer: { name: "ye-ast", version: "0.0.0" },
    matcher: { matches: options.matches ?? (() => true) },
    graph: {
      index: async () => (options.indexFails ? { ok: false, fault: { kind: "index-failed", detail: "broken" } } : { ok: true, value: SUMMARY }),
      open: () => ({ ok: true, value: store }),
    },
    sourceTrivia: { triviaLines: async (file: { path: string }) => (options.onTrivia?.(file.path), new Set(options.trivia?.[file.path] ?? [])) },
    memberNames: { memberNames: async (file: { path: string }) => (options.onMemberNames?.(file.path), { names: options.memberNames?.[file.path] ?? [], functionValueCalls: [], callables: [], receiverBindings: options.receiverBindings?.[file.path] ?? [] }) },
    importOrigins: () => ({
      replacedRoots: async () => options.replaced ?? { globals: new Set(), packages: new Set() },
      origins: async (sites: readonly ImportOriginSite[]) => { options.onOrigins?.(); return sites.map(answer); },
      rootOrigins: async (sites: readonly ResolvedNameSite[]) => sites.map((site): Finding<ImportOrigin> => {
        const root = options.roots?.[site.name];
        if (root === undefined) return { status: "unknown", reason: "unresolved", evidence: [] };
        const { bare, ...value } = root;
        return { status: "complete", value, evidence: [], ...(bare === undefined ? {} : { bare }) };
      }),
    }),
    relations: { extract: async () => ({ relations: [], fields: [], locals: [], ...options.proofs }) },
    engines: {},
    ...(options.live && { live: options.live.deps, trust: { read: async () => ({ ok: true, value: "trusted" }) } }),
  } as unknown as TraceQueriesDeps;
  return { queries: createTraceQueries(deps), log };
}

async function trace(options: Options, targets: readonly CallersTarget[] = [{ file: A, symbol: "run" }], extra: Partial<TraceRequest> & { budget?: TraceBudget } = {}) {
  const { queries, log } = setup(options);
  const answer = await queries.walk({ repo: "/work/shop", repoId: "shop", revision: "HEAD", targets, ...extra } as TraceRequest);
  return { answer, log };
}

async function factOf(options: Options, targets?: readonly CallersTarget[], extra?: Partial<TraceRequest>): Promise<Fact<TraceValue>> {
  const { answer } = await trace(options, targets, extra);
  assert.ok(answer.ok, answer.ok ? "" : answer.fault.kind);
  return answer.value;
}

function valueOf(fact: Fact<TraceValue>): TraceValue {
  assert.notEqual(fact.status, "unknown");
  return fact.status === "unknown" ? ({} as TraceValue) : fact.value;
}

const cutsOf = (fact: Fact<TraceValue>) => (fact.status === "partial" ? fact.cuts.map(({ kind, at, limit }) => (limit === undefined ? [kind, at] : [kind, at, limit])) : []);

const shape = (steps: readonly TraceStep[]) => steps.map((step) => [step.symbol, step.parent ?? null, step.seen ?? null]);

/** A class `Svc` whose method `run` (lines 5-20) is the usual root; `outward` names a function that calls outside. */
const SVC = fakeNode("Svc", "class", A, 1, 40);
const RUN = fakeNode("run", "method", A, 5, 20);
const CONTAINS: FakeEdge[] = [{ from: "Svc", to: "run", kind: "contains" }];
const OUTWARD_CALL = (from: string, file = A, line = 30): FakeUnresolved => ({ from, name: "Math.max", kind: "calls", file, line, column: 2 });

function callee(id: string, file = A, start = 30): FakeNode {
  return fakeNode(id, "function", file, start, start + 2);
}

const call = (from: string, to: string, line: number, column: number, extra: Partial<FakeEdge> = {}): FakeEdge => ({ from, to, kind: "calls", line, column, ...extra });

test("a resolved call is a step at its call site", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("helper")], edges: [...CONTAINS, call("run", "helper", 8, 4)], unresolved: [OUTWARD_CALL("helper")] });
  const step = valueOf(fact).steps[1]!;
  assert.deepEqual([step.symbol, step.parent, step.at, step.via], ["helper", 0, { line: 8, column: 5 }, "call"]);
});

test("a method no source's syntax states is a dispatch cut when an interface owns it, listing the implementations below", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send"), fakeNode("Impl", "class", B, 5, 7), fakeNode("Impl.send", "method", B, 6, 6, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, { from: "Impl", to: "Impl.send", kind: "contains" }, { from: "Impl", to: "Port", kind: "implements" }, call("run", "Port.send", 8, 4)];

  const fact = await factOf({ nodes, edges });

  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/b.ts:2 send", "src/b.ts::Impl.send"]]]);
});

test("a supertype the index left unresolved names a type only when type arguments are what kept it unresolved", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send"), fakeNode("Impl", "class", B, 5, 7), fakeNode("Impl.send", "method", B, 6, 6, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, { from: "Impl", to: "Impl.send", kind: "contains" }, call("run", "Port.send", 8, 4)];
  const supertype = (name: string): FakeUnresolved => ({ from: "Impl", name, kind: "implements", file: B, line: 5, column: 20 });

  const [plain, parameterized] = await Promise.all([factOf({ nodes, edges, unresolved: [supertype("lib.Port")] }), factOf({ nodes, edges, unresolved: [supertype("Port<String>")] })]);

  assert.deepEqual(cutsOf(plain), [["unresolved-link", ["src/b.ts:2 send"]]]);
  assert.deepEqual(cutsOf(parameterized), [["unresolved-link", ["src/b.ts:2 send", "src/b.ts::Impl.send"]]]);
});

test("an edge whose root the language's libraries bind is a global call, not a step at the repository homonym", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("fetch")], edges: [...CONTAINS, call("run", "fetch", 8, 4)], roots: { fetch: { kind: "ambient", name: "fetch" } } });

  assert.deepEqual(valueOf(fact).steps.map(({ symbol, leaves, external }) => [symbol, leaves, external]), [["run", undefined, [{ kind: "global", names: ["fetch"] }]]]);
});

test("a call codegraph synthesized from a source ye-ast ignores is not a step", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("bridge")], edges: [...CONTAINS, call("run", "bridge", 8, 4, { synthesizedBy: "interface-impl" })] });
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.leaves]), [["run", undefined]]);
});

test("this.<member> inside the class that declares it is a step at the member", async () => {
  const save = fakeNode("save", "method", A, 25, 28);
  const fact = await factOf({
    nodes: [SVC, RUN, save],
    edges: [...CONTAINS, { from: "Svc", to: "save", kind: "contains" }],
    unresolved: [{ from: "run", name: "this.save", kind: "calls", file: A, line: 9, column: 4 }, OUTWARD_CALL("save")],
  });
  assert.equal(fact.status, "complete");
  const step = valueOf(fact).steps[1]!;
  assert.deepEqual([step.symbol, step.via, step.at], ["save", "own-member", { line: 9, column: 5 }]);
});

test("a member call whose name no declaration has leaves the repository, unnamed, and cuts nothing", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], edges: CONTAINS, unresolved: [{ from: "run", name: "items.map", kind: "calls", file: A, line: 9, column: 4 }] });
  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "unnamed", names: ["items.map"] }]);
});

test("a member call some declaration is named after is a cut at the place listing the declarations and codegraph's candidates", async () => {
  const fact = await factOf({
    nodes: [SVC, RUN, fakeNode("Repo.save", "method", B, 3, 5, "save")],
    edges: CONTAINS,
    unresolved: [{ from: "run", name: "repo.save", kind: "calls", file: A, line: 9, column: 4, candidates: ["Repo::save"] }],
  });
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:9 repo.save", "Repo::save", "src/b.ts::save"]]]);
  assert.equal(valueOf(fact).steps[0]?.external, undefined);
});

test("a member call whose name only types have leaves the repository, unnamed, and cuts nothing", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, fakeNode("map", "interface", B, 3, 5), fakeNode("Map", "type_alias", B, 7, 7, "map")], edges: CONTAINS, unresolved: [{ from: "run", name: "items.map", kind: "calls", file: A, line: 9, column: 4 }] });
  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "unnamed", names: ["items.map"] }]);
});

test("a member call whose name a top-level constant has is a cut listing it, since a constant may hold a callable", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, fakeNode("map", "constant", B, 3, 3)], edges: CONTAINS, unresolved: [{ from: "run", name: "items.map", kind: "calls", file: A, line: 9, column: 4 }] });
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:9 items.map", "src/b.ts::map"]]]);
});

test("a member call whose name only a function of no container has is a cut listing it, since the index records no namespace", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, fakeNode("map", "function", B, 3, 5)], edges: CONTAINS, unresolved: [{ from: "run", name: "items.map", kind: "calls", file: A, line: 9, column: 4 }] });
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:9 items.map", "src/b.ts::map"]]]);
});

test("a member call named after a function an object literal holds is a cut listing that function", async () => {
  const fact = await factOf({
    nodes: [SVC, RUN, fakeNode("table", "constant", B, 2, 6), fakeNode("handle", "function", B, 3, 4)],
    edges: CONTAINS,
    unresolved: [{ from: "run", name: "table.handle", kind: "calls", file: A, line: 9, column: 4 }],
  });
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:9 table.handle", "src/b.ts::handle"]]]);
});

test("each file's unresolved references are read once per query, shared by root selection, traversal and supertype lookup", async () => {
  const nodes = [
    SVC, RUN, fakeNode("first", "property", A, 22, 22), fakeNode("second", "property", A, 23, 23),
    fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send"), fakeNode("Impl", "class", B, 5, 7), fakeNode("Impl.send", "method", B, 6, 6, "send"),
  ];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, { from: "Impl", to: "Impl.send", kind: "contains" }, call("run", "Port.send", 8, 4)];
  const unresolved: FakeUnresolved[] = [OUTWARD_CALL("first", A, 22), OUTWARD_CALL("second", A, 23), OUTWARD_CALL("run", A, 9), { from: "Impl", name: "Port<String>", kind: "implements", file: B, line: 5, column: 20 }];
  const reads: string[] = [];

  const fact = await factOf({ nodes, edges, unresolved, onUnresolved: (files) => reads.push(...files) }, [{ file: A, symbol: "first" }, { file: A, symbol: "second" }, { file: A, symbol: "run" }]);

  assert.deepEqual(reads.sort(), [A, B]);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/b.ts:2 send", "src/b.ts::Impl.send"]]]);
});

const SOURCES = [{ path: A, content: "" }, { path: B, content: "" }];
const MEMBER_CALLS: FakeUnresolved[] = [
  { from: "run", name: "items.map", kind: "calls", file: A, line: 9, column: 4 },
  { from: "run", name: "store.setErrors", kind: "calls", file: A, line: 10, column: 4 },
];

test("the member names are read once per query from each source, however many member calls the syntax rule settles", async () => {
  const read: string[] = [];

  const fact = await factOf({ nodes: [SVC, RUN], edges: CONTAINS, unresolved: MEMBER_CALLS, sources: SOURCES, memberNames: { [B]: ["setErrors"] }, onMemberNames: (path) => read.push(path) });

  assert.deepEqual(read, [A, B]);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:10 store.setErrors", "src/b.ts::setErrors"]]]);
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "unnamed", names: ["items.map"] }]);
});

test("when no member call reaches the syntax rule, only the sources of the methods the walk expands are read", async () => {
  const read: string[] = [];

  await factOf({ nodes: [SVC, RUN, fakeNode("Repo.setErrors", "method", B, 3, 5, "setErrors")], edges: CONTAINS, unresolved: [MEMBER_CALLS[1]!], sources: SOURCES, onMemberNames: (path) => read.push(path) });

  assert.deepEqual(read, [A]);
});

test("a source outside the declared scope is not read for member names and keeps no member call in the repository", async () => {
  const read: string[] = [];

  const fact = await factOf(
    { nodes: [SVC, RUN], edges: CONTAINS, unresolved: [MEMBER_CALLS[1]!], sources: SOURCES, memberNames: { [B]: ["setErrors"] }, onMemberNames: (path) => read.push(path), matches: (path) => path === B },
    [{ file: A, symbol: "run" }],
    { scope: { exclude: ["src/b.ts"] } },
  );

  assert.deepEqual(read, [A]);
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "unnamed", names: ["store.setErrors"] }]);
});

test("a declaration outside the declared scope does not keep a member call in the repository", async () => {
  const fact = await factOf(
    { nodes: [SVC, RUN, fakeNode("Repo.save", "method", B, 3, 5, "save")], edges: CONTAINS, unresolved: [{ from: "run", name: "repo.save", kind: "calls", file: A, line: 9, column: 4 }], matches: (path) => path === B },
    [{ file: A, symbol: "run" }],
    { scope: { exclude: ["src/b.ts"] } },
  );
  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "unnamed", names: ["repo.save"] }]);
});

test("a bare call imported from a package leaves the repository under that package", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], edges: CONTAINS, unresolved: [{ from: "run", name: "inject", kind: "calls", file: A, line: 9, column: 4 }], origins: { inject: { kind: "external", module: "@angular/core" } } });
  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "import", module: "@angular/core", names: ["inject"] }]);
});

test("a bare call the language's own libraries declare is a global call", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], edges: CONTAINS, unresolved: [{ from: "run", name: "setTimeout", kind: "calls", file: A, line: 9, column: 4 }], origins: { setTimeout: { kind: "ambient", name: "setTimeout" } } });
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "global", names: ["setTimeout"] }]);
});

test("a bare call through a parameter is a cut listing the declarations of its name", async () => {
  const fact = await factOf({
    nodes: [SVC, RUN, callee("cb", B, 3)],
    edges: CONTAINS,
    unresolved: [{ from: "run", name: "cb", kind: "calls", file: A, line: 9, column: 4 }],
    origins: { cb: { kind: "local-parameter", name: "cb" } },
  });
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:9 cb", "src/b.ts::cb"]]]);
});

test("a computed callee is a cut", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], edges: CONTAINS, unresolved: [{ from: "run", name: "(this as any)[key]", kind: "calls", file: A, line: 9, column: 4 }] });
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:9 (this as any)[key]"]]]);
});

test("a function the body passes as a value is a deferred step", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("onDone")], edges: [...CONTAINS, { from: "run", to: "onDone", kind: "references", line: 9, column: 15 }], unresolved: [OUTWARD_CALL("onDone")] });
  const step = valueOf(fact).steps[1]!;
  assert.deepEqual([step.symbol, step.via, step.deferred], ["onDone", "reference", true]);
});

test("a nested function the body never calls is not reached", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, fakeNode("inner", "function", A, 10, 11)], edges: [...CONTAINS, { from: "run", to: "inner", kind: "contains" }] });
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.leaves]), [["run", undefined]]);
});

test("a declaration called twice is expanded once and seen the second time", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("inner")], edges: [...CONTAINS, call("run", "inner", 9, 14), call("run", "inner", 9, 4)], unresolved: [OUTWARD_CALL("inner")] });
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.at, step.seen ?? null]), [
    ["run", undefined, null],
    ["inner", { line: 9, column: 5 }, null],
    ["inner", { line: 9, column: 15 }, 1],
  ]);
});

test("children follow the line and then the column of their call", async () => {
  const fact = await factOf({
    nodes: [SVC, RUN, callee("late", A, 30), callee("early", A, 34), callee("left", A, 38)],
    edges: [...CONTAINS, call("run", "late", 12, 0), call("run", "early", 8, 9), call("run", "left", 8, 2)],
    unresolved: ["late", "early", "left"].map((from) => OUTWARD_CALL(from)),
  });
  assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run", "left", "early", "late"]);
});

test("a call at column zero keeps its column", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("helper")], edges: [...CONTAINS, call("run", "helper", 8, 0)], unresolved: [OUTWARD_CALL("helper")] });
  assert.deepEqual(valueOf(fact).steps[1]?.at, { line: 8, column: 1 });
});

test("a reference at a resolved call's place under the callee's name is that call, not another", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("helper")], edges: [...CONTAINS, call("run", "helper", 8, 4)], unresolved: [{ from: "run", name: "helper", kind: "calls", file: A, line: 8, column: 4 }, OUTWARD_CALL("helper")] });
  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run", "helper"]);
});

test("a chain on a resolved call keeps both links: the head as a step and the member settled on its own", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("head")], edges: [...CONTAINS, call("run", "head", 8, 4)], unresolved: [{ from: "run", name: "head().tail", kind: "calls", file: A, line: 8, column: 4 }, OUTWARD_CALL("head")] });
  const [run, head] = valueOf(fact).steps;
  assert.deepEqual([head?.symbol, run?.external], ["head", [{ kind: "unnamed", names: ["head().tail"] }]]);
});

test("an edge the store places nowhere is a step without a place, after the placed ones, and stands for no reference", async () => {
  const fact = await factOf({
    nodes: [SVC, RUN, callee("helper"), callee("placed", A, 34)],
    edges: [...CONTAINS, { from: "run", to: "helper", kind: "calls" }, call("run", "placed", 12, 0)],
    unresolved: [{ from: "run", name: "helper", kind: "calls", file: A, line: 8, column: 4 }, OUTWARD_CALL("helper"), OUTWARD_CALL("placed")],
  });
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.at]), [["run", undefined], ["placed", { line: 12, column: 1 }], ["helper", undefined]]);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:8 helper", "src/a.ts::helper"]]]);
});

test("a cycle ends at the step that expanded the declaration", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("again")], edges: [...CONTAINS, call("run", "again", 8, 4), call("again", "run", 31, 2)] });
  assert.deepEqual(shape(valueOf(fact).steps), [["run", null, null], ["again", 0, null], ["run", 1, 0]]);
});

/** root → first, second; first → middle → second. */
const SHARED: Options = {
  nodes: [SVC, RUN, callee("first", A, 22), callee("middle", A, 26), callee("second", A, 30)],
  edges: [...CONTAINS, call("run", "first", 8, 4), call("run", "second", 9, 4), call("first", "middle", 23, 2), call("middle", "second", 27, 2)],
  unresolved: [OUTWARD_CALL("second", A, 31)],
};

test("an occurrence the depth bound stops is a cut and does not keep a shallower one from expanding", async () => {
  const fact = await factOf(SHARED, undefined, { budget: { depth: 3 } });
  assert.deepEqual(shape(valueOf(fact).steps), [["run", null, null], ["first", 0, null], ["middle", 1, null], ["second", 2, null], ["second", 0, null]]);
  assert.deepEqual(valueOf(fact).steps[4]?.external, [{ kind: "unnamed", names: ["Math.max"] }]);
  assert.deepEqual(cutsOf(fact), [["depth", ["src/a.ts::second"], 3]]);
});

test("once the expansions are spent every later occurrence is a cut, never seen", async () => {
  const fact = await factOf(SHARED, undefined, { budget: { expansions: 3 } });
  const steps = valueOf(fact).steps;
  assert.deepEqual(shape(steps), [["run", null, null], ["first", 0, null], ["middle", 1, null], ["second", 2, null], ["second", 0, null]]);
  assert.equal(valueOf(fact).cost.expanded, 3);
  assert.deepEqual(cutsOf(fact), [["caller-budget", ["src/a.ts::second"], 3]]);
});

test("a step whose callee a bound stopped stays a step, and so does the callee", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("first", A, 22), callee("leaf", A, 26)], edges: [...CONTAINS, call("run", "first", 8, 4), call("first", "leaf", 23, 2)] }, undefined, { budget: { depth: 2 } });
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.leaves]), [["run", undefined], ["first", undefined], ["leaf", undefined]]);
});

test("a proven terminal callee folds into its caller's leaves with its location", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("getId", B, 3)], edges: [...CONTAINS, call("run", "getId", 8, 4)] });
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.leaves]), [["run", [{ symbol: "getId", file: B, start: 3, end: 5 }]]]);
});

test("a terminal callee passed as a value folds deferred, and a direct call to it beside folds as a separate plain leaf", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("onDone", B, 3)], edges: [...CONTAINS, call("run", "onDone", 8, 4), { from: "run", to: "onDone", kind: "references", line: 9, column: 15 }] });
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.leaves]), [["run", [{ symbol: "onDone", file: B, start: 3, end: 5 }, { symbol: "onDone", file: B, start: 3, end: 5, deferred: true }]]]);
});

test("a callee whose only call is unsettled stays a step", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("open")], edges: [...CONTAINS, call("run", "open", 8, 4)], unresolved: [{ from: "open", name: "(x)[k]", kind: "calls", file: A, line: 31, column: 2 }] });
  assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run", "open"]);
});

test("identical stores in any order give identical bytes", async () => {
  const shuffled: Options = { nodes: [...SHARED.nodes].reverse(), edges: [...SHARED.edges!].reverse(), unresolved: [...SHARED.unresolved!].reverse() };
  const once = JSON.stringify(await factOf(SHARED));
  assert.equal(JSON.stringify(await factOf(SHARED)), once);
  assert.equal(JSON.stringify(await factOf(shuffled)), once);
});

const TWINS: FakeNode[] = [fakeNode("Left", "class", A, 1, 10), fakeNode("Left.save", "method", A, 3, 5, "save"), fakeNode("Right", "class", A, 12, 20), fakeNode("Right.save", "method", A, 14, 16, "save")];
const TWIN_EDGES: FakeEdge[] = [{ from: "Left", to: "Left.save", kind: "contains" }, { from: "Right", to: "Right.save", kind: "contains" }];

test("every declaration a homonym selects is a root of one forest, and the target lists them all", async () => {
  const fact = await factOf({ nodes: TWINS, edges: TWIN_EDGES }, [{ file: A, symbol: "save" }]);
  const value = valueOf(fact);
  assert.deepEqual(value.steps.map((step) => [step.id, step.symbol, step.line, step.depth]), [[0, "save", 3, 0], [1, "save", 14, 0]]);
  assert.deepEqual(value.roots, [{ target: "src/a.ts:save", steps: [0, 1] }]);
});

test("a line range selecting two declarations gives two roots", async () => {
  const fact = await factOf({ nodes: [fakeNode("open", "function", A, 3, 5), fakeNode("close", "function", A, 6, 9)] }, [{ file: A, start: 4, end: 7 }]);
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.id, step.symbol]), [[0, "open"], [1, "close"]]);
  assert.deepEqual(valueOf(fact).roots, [{ target: "src/a.ts:4-7", steps: [0, 1] }]);
});

test("a line range selects the declarations it intersects, never the file's other declarations through a blank line between them", async () => {
  const content = ["function f() {", "  return 1;", "}", "", "function g() {", "  return 2;", "}", "", "function h() {}", ""].join("\n");
  const nodes = [fakeNode("f", "function", B, 1, 3), fakeNode("g", "function", B, 5, 7), fakeNode("h", "function", B, 9, 9)];
  const fact = await factOf({ nodes, sources: [{ path: B, content }], trivia: { [B]: [4, 8, 10] } }, [{ file: B, start: 3, end: 5 }]);
  assert.deepEqual(valueOf(fact).roots, [{ target: "src/b.ts:3-5", steps: [0, 1] }]);
  assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["f", "g"]);
});

test("a line range that selects no declaration, past the end of its file or only over trivia between declarations, is an unknown-symbol fault", async () => {
  const content = ["function f() {", "  return 1;", "}", "", "function g() {", "  return 2;", "}", "", "function h() {}", ""].join("\n");
  const nodes = [fakeNode("f", "function", B, 1, 3), fakeNode("g", "function", B, 5, 7), fakeNode("h", "function", B, 9, 9)];
  for (const [start, end] of [[20, 25], [4, 4]] as const) {
    const { answer } = await trace({ nodes, sources: [{ path: B, content }], trivia: { [B]: [4, 8, 10] } }, [{ file: B, start, end }]);
    assert.ok(!answer.ok, `${start}-${end}`);
    assert.equal(answer.fault.kind, "unknown-symbol");
    assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [{ file: B, start, end, candidates: ["f", "g", "h"] }]);
  }
});

test("a trace reads a file's trivia lines once, however many of its ranges it is asked", async () => {
  const content = ["function f() {", "  return 1;", "}", "", "function g() {", "  return 2;", "}", "", "function h() {}", ""].join("\n");
  const asked: string[] = [];
  await factOf({ nodes: [fakeNode("f", "function", B, 1, 3), fakeNode("g", "function", B, 5, 7), fakeNode("h", "function", B, 9, 9)], sources: [{ path: B, content }], trivia: { [B]: [4, 8, 10] }, onTrivia: (path) => void asked.push(path) }, [{ file: B, start: 3, end: 5 }, { file: B, start: 7, end: 9 }]);
  assert.deepEqual(asked, [B]);
});

test("a root an earlier root already expanded is seen at that step", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("helper")], edges: [...CONTAINS, call("run", "helper", 8, 4)], unresolved: [OUTWARD_CALL("helper")] }, [{ file: A, symbol: "run" }, { file: A, symbol: "helper" }]);
  assert.deepEqual(shape(valueOf(fact).steps), [["run", null, null], ["helper", 0, null], ["helper", null, 1]]);
  assert.deepEqual(valueOf(fact).roots, [{ target: "src/a.ts:helper", steps: [2] }, { target: "src/a.ts:run", steps: [0] }]);
});

test("a symbol that names no declaration is an unknown-symbol fault with what the file declares", async () => {
  const { answer } = await trace({ nodes: [SVC, RUN] }, [{ file: A, symbol: "missing" }]);
  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "unknown-symbol");
  assert.deepEqual(answer.fault.kind === "unknown-symbol" ? answer.fault.entries : [], [{ file: A, symbol: "missing", candidates: ["Svc", "run"] }]);
});

test("a target outside the declared scope is unknown with its evidence", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], matches: (path) => path === A }, undefined, { scope: { exclude: [A] } });
  assert.equal(fact.status, "unknown");
  assert.deepEqual([fact.status === "unknown" ? fact.reason : "", fact.evidence], ["out-of-scope", [{ path: A, line: 1 }]]);
});

test("a trace records its targets once each in a fixed order and its bounds, and reads its plan from the steps", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("helper", B, 3)], edges: [...CONTAINS, call("run", "helper", 8, 4)], unresolved: [OUTWARD_CALL("helper", B, 4)] }, [{ file: A, symbol: "run" }, { file: A, symbol: "run" }], { budget: { depth: 5 } });
  assert.deepEqual(fact.inputs.declaredConfig, { walk: { depth: 5 }, targets: ["src/a.ts:run"] });
  assert.deepEqual(valueOf(fact).readingPlan, { ranges: [{ file: A, start: 5, end: 20, steps: [0] }, { file: B, start: 3, end: 5, steps: [1] }], lines: 19 });
});

test("a trace closes the store it read", async () => {
  const { log } = await trace({ nodes: [SVC, RUN] });
  assert.equal(log.closed, 1);
});

test("an index that cannot be built is unknown, never an empty trace", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], indexFails: true });
  assert.deepEqual([fact.status, fact.status === "unknown" ? fact.reason : ""], ["unknown", "index-unavailable"]);
});

test("aborting during the walk answers the cancellation fault and closes the store", async () => {
  const controller = new AbortController();
  const { answer, log } = await trace(
    { nodes: [SVC, RUN], edges: CONTAINS, unresolved: [{ from: "run", name: "cb", kind: "calls", file: A, line: 9, column: 4 }], onOrigins: () => controller.abort() },
    undefined,
    { signal: controller.signal },
  );
  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "aborted");
  assert.equal(log.closed, 1);
});

test("a live trace reads the held mirror of a trusted repository, answers at a live snapshot and releases the mirror and the store", async () => {
  const mirror = fakeLive({ [A]: "1" });
  const { queries, log } = setup({ nodes: [SVC, RUN, callee("getId")], edges: [...CONTAINS, call("run", "getId", 8, 4)], live: mirror });

  const answer = await queries.walk({ repo: "/work/shop", repoId: "shop", targets: [{ file: A, symbol: "run" }], live: true });

  assert.ok(answer.ok);
  assert.equal(answer.value.snapshot.kind, "live");
  assert.deepEqual(valueOf(answer.value).steps.map((step) => [step.symbol, step.leaves?.map(({ symbol }) => symbol)]), [["run", ["getId"]]]);
  assert.deepEqual([log.closed, mirror.held], [1, { locks: 1, released: 1 }]);
});

test("a store that fails while the walk reads it closes and fails with its own error, never an empty trace", async () => {
  const failure = new RangeError("store read failed");
  const { queries, log } = setup({ nodes: [SVC, RUN], edges: CONTAINS, storeFails: failure });

  await assert.rejects(queries.walk({ repo: "/work/shop", repoId: "shop", revision: "HEAD", targets: [{ file: A, symbol: "run" }] }), (error) => error === failure);
  assert.equal(log.closed, 1);
});

/** A class `Repo` in `src/b.ts` whose method `save` a call `this.repo.save` at line 9 of `run` may reach. */
const REPO = fakeNode("Repo", "class", B, 1, 10);
const REPO_SAVE = fakeNode("Repo.save", "method", B, 3, 5, "save");
const FIELD_CALL: FakeUnresolved = { from: "run", name: "this.repo.save", kind: "calls", file: A, line: 9, column: 4 };
const SAVE_PROOF = {
  owner: { path: A, symbol: "Svc", line: 1 },
  receiver: { path: B, symbol: "Repo", line: 1 },
  member: { path: B, symbol: "save", line: 3 },
  reference: { file: A, line: 9, column: 5, name: "this.repo.save", kind: "calls" as const },
};
const fieldCallOptions = (proofs: NonNullable<Options["proofs"]>): Options => ({
  nodes: [SVC, RUN, REPO, REPO_SAVE],
  edges: [...CONTAINS, { from: "Repo", to: "Repo.save", kind: "contains" }],
  unresolved: [FIELD_CALL, OUTWARD_CALL("Repo.save", B, 4)],
  proofs,
});

test("a member call the relations prove runs a repository method is a step at that method, not a cut at its name", async () => {
  const fact = await factOf(fieldCallOptions({ memberUses: [SAVE_PROOF], externalUses: [] }));

  assert.equal(fact.status, "complete");
  const step = valueOf(fact).steps[1]!;
  assert.deepEqual([step.symbol, step.parent, step.at, step.via], ["save", 0, { line: 9, column: 5 }, "call"]);
});

test("a member proof whose receiver a provider may replace, that names its place twice, or whose class the index does not place as the method's owner leaves the call a cut", async () => {
  const substitutes = [{ class: { path: B, symbol: "Other", line: 20 }, at: { path: A, line: 2 } }];
  const replaced = await factOf(fieldCallOptions({ memberUses: [{ ...SAVE_PROOF, substitutes }], externalUses: [] }));
  const twice = await factOf(fieldCallOptions({ memberUses: [SAVE_PROOF], externalUses: [{ owner: SAVE_PROOF.owner, field: "repo", holds: "pkg#Repo", reference: SAVE_PROOF.reference }] }));
  const misplaced = await factOf(fieldCallOptions({ memberUses: [{ ...SAVE_PROOF, receiver: { path: B, symbol: "Other", line: 20 } }], externalUses: [] }));

  for (const fact of [replaced, twice, misplaced]) assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:9 this.repo.save", "src/b.ts::Repo.save"]]]);
});

test("a call the relations prove runs on a field holding a package type is a leaf under that package, and a global type a global", async () => {
  const proved = (holds: string) => fieldCallOptions({ memberUses: [], externalUses: [{ owner: SAVE_PROOF.owner, field: "repo", holds, reference: SAVE_PROOF.reference }] });

  const [packaged, global] = await Promise.all([factOf(proved("@angular/common/http#HttpClient")), factOf(proved("global#Map"))]);

  assert.equal(packaged.status, "complete");
  assert.deepEqual(valueOf(packaged).steps[0]?.external, [{ kind: "import", module: "@angular/common/http", names: ["this.repo.save"] }]);
  assert.deepEqual(valueOf(global).steps[0]?.external, [{ kind: "global", names: ["this.repo.save"] }]);
});

test("a member call whose plain receiver root the language's libraries bind is a global leaf, even when a repository declaration has its name", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("max", B, 3)], edges: CONTAINS, unresolved: [{ from: "run", name: "Math.max", kind: "calls", file: A, line: 9, column: 4 }], roots: { max: { kind: "ambient", name: "Math" } } });

  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "global", names: ["Math.max"] }]);
});

test("a member call whose receiver root a package binds is a leaf under that package", async () => {
  const fact = await factOf({ nodes: [SVC, RUN, callee("map", B, 3)], edges: CONTAINS, unresolved: [{ from: "run", name: "_.fp.map", kind: "calls", file: A, line: 9, column: 4 }], roots: { map: { kind: "external", module: "lodash" } } });

  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "import", module: "lodash", names: ["_.fp.map"] }]);
});

test("a member call on a call result or on this keeps its cut whatever its root is bound to", async () => {
  const unresolved: FakeUnresolved[] = [{ from: "run", name: "Math.random().max", kind: "calls", file: A, line: 9, column: 4 }, { from: "run", name: "this.cache.max", kind: "calls", file: A, line: 10, column: 4 }];
  const fact = await factOf({ nodes: [SVC, RUN, callee("max", B, 3)], edges: CONTAINS, unresolved, roots: { max: { kind: "ambient", name: "Math" } } });

  assert.deepEqual(cutsOf(fact).map(([, at]) => (at as string[])[0]), ["src/a.ts:10 this.cache.max", "src/a.ts:9 Math.random().max"]);
});

/** A call `store.save()` at line 9, column 5 of `run`, whose receiver the source binds as `holds` says. */
const boundCall = (holds: ReceiverBinding["holds"], member = "save"): Options => ({
  nodes: [SVC, RUN, REPO, REPO_SAVE, fakeNode("Other.save", "method", A, 30, 32, "save")],
  edges: [...CONTAINS, { from: "Repo", to: "Repo.save", kind: "contains" }],
  unresolved: [{ from: "run", name: "store.save", kind: "calls", file: A, line: 9, column: 4 }, OUTWARD_CALL("Repo.save", B, 4)],
  receiverBindings: { [A]: [{ line: 9, column: 5, receiver: "store", member, holds }] },
  sources: [{ path: A, content: "" }],
});

test("a member call on a local the source binds to a class it declares, or to one whose name is rooted at a repository file, is a step at that class's method", async () => {
  const declared = await factOf({ ...boundCall({ kind: "declared", name: "Repo", line: 1 }), nodes: [SVC, RUN, fakeNode("Repo", "class", A, 22, 28), fakeNode("Repo.save", "method", A, 24, 26, "save"), fakeNode("Other.save", "method", B, 30, 32, "save")], edges: [...CONTAINS, { from: "Repo", to: "Repo.save", kind: "contains" }], unresolved: [{ from: "run", name: "store.save", kind: "calls", file: A, line: 9, column: 4 }, OUTWARD_CALL("Repo.save", A, 25)], receiverBindings: { [A]: [{ line: 9, column: 5, receiver: "store", member: "save", holds: { kind: "declared", name: "Repo", line: 22 } }] }, sources: [{ path: A, content: "" }] });
  const constructed = await factOf({ ...boundCall({ kind: "constructed", name: "Repo", line: 8, column: 17 }), roots: { Repo: { kind: "repository", file: B, bare: true } } });

  for (const fact of [declared, constructed]) {
    assert.equal(fact.status, "complete");
    assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, at, via }) => [symbol, at, via]), [["save", { line: 9, column: 5 }, "call"]]);
  }
  assert.deepEqual([valueOf(declared).steps[1]?.file, valueOf(constructed).steps[1]?.file], [A, B]);
});

test("a member call on a local bound to a literal, or constructed from a name only the libraries declare, is a global leaf", async () => {
  const literal = await factOf(boundCall({ kind: "literal", type: "Array" }));
  const library = await factOf({ ...boundCall({ kind: "constructed", name: "Map", line: 8, column: 17 }), roots: { Map: { kind: "ambient", name: "Map", bare: true } } });

  for (const fact of [literal, library]) {
    assert.equal(fact.status, "complete");
    assert.deepEqual(valueOf(fact).steps[0]?.external, [{ kind: "global", names: ["store.save"] }]);
  }
});

test("a receiver binding for another member, a class the repository file does not declare, or an unproven root leaves the call a cut", async () => {
  const cut = [["unresolved-link", ["src/a.ts:9 store.save", "src/a.ts::save", "src/b.ts::Repo.save"]]];
  const otherMember = await factOf({ ...boundCall({ kind: "literal", type: "Array" }, "push") });
  const elsewhere = await factOf({ ...boundCall({ kind: "constructed", name: "Repo", line: 8, column: 17 }), roots: { Repo: { kind: "repository", file: "src/c.ts", bare: true } } });
  const unproven = await factOf(boundCall({ kind: "constructed", name: "Repo", line: 8, column: 17 }));

  for (const fact of [otherMember, elsewhere, unproven]) assert.deepEqual(cutsOf(fact), cut);
});

test("an external leaf under a global or a package the repository replaces stays a cut, wherever the walk settles it", async () => {
  const globals = (...names: string[]): ReplacedRoots => ({ globals: new Set(names), packages: new Set() });
  const packages = (...names: string[]): ReplacedRoots => ({ globals: new Set(), packages: new Set(names) });
  const memberCall = (name: string): FakeUnresolved[] => [{ from: "run", name, kind: "calls", file: A, line: 9, column: 4 }];
  const homonym = callee("max", B, 3);
  const external = (holds: string) => ({ ...fieldCallOptions({ memberUses: [], externalUses: [{ owner: SAVE_PROOF.owner, field: "repo", holds, reference: SAVE_PROOF.reference }] }) });
  const cases: [string, Options][] = [
    ["edge", { nodes: [SVC, RUN, callee("fetch")], edges: [...CONTAINS, call("run", "fetch", 8, 4)], roots: { fetch: { kind: "ambient", name: "fetch" } }, replaced: globals("fetch") }],
    ["bare", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("fetch"), origins: { fetch: { kind: "ambient", name: "fetch" } }, replaced: globals("fetch") }],
    ["bare package", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("tap"), origins: { tap: { kind: "external", module: "rxjs" } }, replaced: packages("rxjs") }],
    ["rooted", { nodes: [SVC, RUN, homonym], edges: CONTAINS, unresolved: memberCall("Math.max"), roots: { max: { kind: "ambient", name: "Math" } }, replaced: globals("Math") }],
    ["rooted package", { nodes: [SVC, RUN, homonym], edges: CONTAINS, unresolved: memberCall("_.fp.max"), roots: { max: { kind: "external", module: "lodash" } }, replaced: packages("lodash") }],
    ["literal", { ...boundCall({ kind: "literal", type: "Array" }), replaced: globals("Array") }],
    ["constructed", { ...boundCall({ kind: "constructed", name: "Map", line: 8, column: 17 }), roots: { Map: { kind: "ambient", name: "Map", bare: true } }, replaced: globals("Map") }],
    ["field global", { ...external("global#Map"), replaced: globals("Map") }],
    ["field package", { ...external("@angular/common/http#HttpClient"), replaced: packages("@angular/common") }],
    ["every global", { ...boundCall({ kind: "literal", type: "Array" }), replaced: { globals: "all", packages: new Set() } }],
  ];

  for (const [name, options] of cases) {
    const fact = await factOf(options);
    assert.equal(fact.status, "partial", name);
    assert.deepEqual(valueOf(fact).steps.flatMap((step) => step.external ?? []), [], name);
  }
});
