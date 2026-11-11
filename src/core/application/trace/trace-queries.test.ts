import { TYPESCRIPT_PROFILE } from "../../domain/languages/profiles.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Fact, Finding } from "../../domain/shared/fact.ts";
import type { TraceStep, TraceValue } from "../../domain/trace/trace-fact.ts";
import type { DeclaredType, DispatchSite, DispatchTargets, ImportOriginSite, ReceiverCallSite, ReceiverMethod, ReplacedRoots, ResolvedNameSite, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import type { TraceBudget, TraceRequest, TraceTarget } from "../../ports/trace-queries.port.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { CallSite, PlacedCallSite } from "../../domain/topology/call-site.ts";
import type { SourceSpan } from "../../domain/shared/owning-body.ts";
import { fakeLive, type FakeLive } from "../live/fake-live.testing.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode, type FakeUnresolved } from "../navigation/fake-code-graph.testing.ts";
import type { DeclaredCallable, ReceiverBinding, SyntaxCall } from "../../ports/declared-member-names.port.ts";
import type { RelationExtraction } from "../relations/relation-extractor.ts";
import type { TypeBindingsAnswer, TypeTarget } from "../../ports/type-bindings.port.ts";
import { createTraceQueries, type TraceQueriesDeps } from "./trace-queries.ts";

const SHA = "a".repeat(40);
const SUMMARY = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "fake", schema: 0, extraction: 0 } };
const A = "src/a.ts";
const B = "src/b.ts";

type Origin = Finding<ImportOrigin> & { occurrence?: true };

const written = (...paths: string[][]): ReplacedRoots => ({ paths, globalObjects: new Set(["globalThis", "window"]), packages: new Set() });

function tokenReading(file: { path: string; content: string }, trivia: Readonly<Record<string, readonly number[]>>) {
  const quiet = new Set(trivia[file.path] ?? []);
  const lines = file.content.split("\n").length;
  return {
    status: "read" as const,
    language: "typescript" as const,
    tokens: Array.from({ length: lines }, (_, index) => index + 1).filter((line) => !quiet.has(line)).map((line) => ({ start: line, end: line, text: `t${line}` })),
    imports: [],
    importOrder: "significant" as const,
  };
}

interface Options {
  workspace?: TraceQueriesDeps["workspace"];
  /** Files the export holds and the index did not; none by default. */
  notIndexed?: readonly string[];
  syntaxCalls?: Readonly<Record<string, readonly SyntaxCall[]>>;
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
  /** The function values each source's syntax states (arrows, function expressions, lambdas, method references, anonymous class bodies), by path. */
  functionValues?: Readonly<Record<string, readonly SourceSpan[]>>;
  /** The member names each source declares in value positions, by path. */
  memberNames?: Readonly<Record<string, readonly string[]>>;
  /** Runs each time the walk reads a source's member names. */
  onMemberNames?: (path: string) => void;
  /** The receiver bindings each source's syntax proves, by path. */
  receiverBindings?: Readonly<Record<string, readonly ReceiverBinding[]>>;
  /** The roots the snapshot replaces; none by default. */
  replaced?: ReplacedRoots;
  /** What binds the root of a resolved call's receiver, by the name the edge reaches; unknown by default. */
  receiverRoots?: Readonly<Record<string, RootBinding>>;
  /** The callables each source's syntax states, by path. */
  callables?: Readonly<Record<string, readonly DeclaredCallable[]>>;
  /** The names each source imports from a repository file, by path, as its module statements bind them; none by default. */
  imports?: Readonly<Record<string, readonly { local: string; from: string }[]>>;
  /** The type each annotation names, by the name it is spelled with; unknown by default. */
  declared?: Readonly<Record<string, DeclaredType>>;
  /** The member calls the relations prove, and the classes fields and `inject()` locals hold. */
  proofs?: Pick<RelationExtraction, "memberUses" | "externalUses"> & Partial<Pick<RelationExtraction, "fields" | "locals">>;
  /** The bodies the declared hierarchy proves a body-less method runs, by its name; unknown by default. */
  dispatch?: Readonly<Record<string, DispatchTargets>>;
  /** The template relations, each component's template and the template calls they prove, as the relations read them; none by default. */
  relations?: Pick<RelationExtraction, "relations" | "templates" | "memberUses">;
  /** The entrypoints the map reads at the head; none by default. */
  findings?: readonly Finding<Entrypoint>[];
  /** Runs each time the map's entrypoints are read. */
  onExtract?: () => void;
  /** The method the receiver's declared type names for a member call, by the member; unknown by default. */
  receivers?: Readonly<Record<string, ReceiverMethod>>;
  /** Called with the members of each read of the receivers' declared types. */
  onReceivers?: (members: readonly string[]) => void;
  /** The call sites the RFC-0011 extraction reads in the snapshot; none by default. */
  callSites?: readonly CallSite[];
  /** The same, each with where its call starts; by default every call site starts at column 0. */
  placedSites?: readonly PlacedCallSite[];
  /** Runs each time the call sites are read. */
  onCallSites?: () => void;
  /** What the type checker answers over a declared build output; nothing is declared by default. */
  typed?: TypeBindingsAnswer;
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
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    vcs: {
      resolveCommit: async () => ({ ok: true, value: SHA }),
      exportCommit: async () => ({ ok: true, value: { files: [A, B, ...(options.notIndexed ?? [])].map((path) => ({ path, blob: "1", written: true })), skipped: [] } }),
    },
    scratch: { create: async () => "/scratch/head", remove: async () => undefined },
    reader: { read: async () => options.sources ?? [] },
    extractor: { extract: async () => (options.onExtract?.(), { findings: options.findings ?? [], readingCuts: [] }) },
    digest: { of: (value: string) => `digest:${value}` },
    producer: { name: "ye-ast", version: "0.0.0" },
    matcher: { matches: options.matches ?? (() => true) },
    graph: {
      index: async () => (options.indexFails ? { ok: false, fault: { kind: "index-failed", detail: "broken" } } : { ok: true, value: { ...SUMMARY, filesNotIndexed: options.notIndexed ?? [] } }),
      open: () => ({ ok: true, value: store }),
    },
    tokens: { tokensOf: async (file: { path: string; content: string }) => (options.onTrivia?.(file.path), tokenReading(file, options.trivia ?? {})) },
    memberNames: { memberNames: async (file: { path: string }) => (options.onMemberNames?.(file.path), { names: options.memberNames?.[file.path] ?? [], functionValueCalls: [], callables: options.callables?.[file.path] ?? [], receiverBindings: options.receiverBindings?.[file.path] ?? [], ...(options.syntaxCalls?.[file.path] === undefined ? {} : { calls: options.syntaxCalls[file.path] }), functionValues: options.functionValues?.[file.path] ?? [] }) },
    importOrigins: () => ({
      replacedRoots: async () => options.replaced ?? written(),
      rootBindings: async (sites: readonly UseSite[]) => sites.map((site) => options.receiverRoots?.[site.spelled] ?? { kind: "unknown" }),
      declaredTypes: async (sites: readonly UseSite[]) => sites.map((site) => options.declared?.[site.spelled] ?? { kind: "unknown" }),
      dispatchTargets: async (sites: readonly DispatchSite[]) => sites.map((site) => options.dispatch?.[site.name] ?? { kind: "unknown" }),
      receiverMethods: async (sites: readonly ReceiverCallSite[]) => (options.onReceivers?.(sites.map((site) => site.member)), sites.map((site) => options.receivers?.[site.member] ?? { kind: "unknown" })),
      origins: async (sites: readonly ImportOriginSite[]) => { options.onOrigins?.(); return sites.map(answer); },
      rootOrigins: async (sites: readonly ResolvedNameSite[]) => sites.map((site): Finding<ImportOrigin> => {
        const root = options.roots?.[site.name];
        if (root === undefined) return { status: "unknown", reason: "unresolved", evidence: [] };
        const { bare, ...value } = root;
        return { status: "complete", value, evidence: [], ...(bare === undefined ? {} : { bare }) };
      }),
    }),
    relations: { language: TYPESCRIPT_PROFILE, extract: async () => ({ relations: [], fields: [], locals: [], ...options.proofs, ...options.relations }) },
    ...(options.imports === undefined ? {} : { moduleReader: { extract: async () => ({ dependencies: Object.entries(options.imports!).flatMap(([file, bound]) => bound.map(({ local, from }, index) => ({ file, line: index + 1, endLine: index + 1, specifier: from, kind: "import", typeOnly: false, target: { kind: "repository", file: from }, bindings: [{ local, imported: local, line: index + 1, column: 10, typeOnly: false, exportedAs: local }] }))) }) } }),
    callSites: { placed: async () => (options.onCallSites?.(), options.placedSites ?? (options.callSites ?? []).map((site) => ({ site, column: 0 }))) },
    engines: {},
    ...(options.typed && { typeBindings: { of: async () => options.typed }, checkerInputs: { filesAt: async () => ({ ok: true, value: { files: [], cuts: [] } }) }, declaredOutputs: () => DECLARED }),
    ...(options.live && { live: options.live.deps, trust: { read: async () => ({ ok: true, value: "trusted" }) } }),
  } as unknown as TraceQueriesDeps;
  return { queries: createTraceQueries(deps), log };
}

async function trace(options: Options, targets: readonly TraceTarget[] = [{ file: A, symbol: "run" }], extra: Partial<TraceRequest> & { budget?: TraceBudget } = {}) {
  const { queries, log } = setup(options);
  const answer = await queries.walk({ repo: "/work/shop", repoId: "shop", revision: "HEAD", targets, ...extra } as TraceRequest);
  return { answer, log };
}

async function factOf(options: Options, targets?: readonly TraceTarget[], extra?: Partial<TraceRequest>): Promise<Fact<TraceValue>> {
  const { answer } = await trace(options, targets, extra);
  assert.ok(answer.ok, answer.ok ? "" : answer.fault.kind);
  return answer.value;
}

function valueOf(fact: Fact<TraceValue>): TraceValue {
  assert.notEqual(fact.status, "unknown");
  return fact.status === "unknown" ? ({} as TraceValue) : fact.value;
}

const cutsOf = (fact: Fact<TraceValue>) => (fact.status === "partial" ? fact.cuts.map(({ kind, at, limit }) => (limit === undefined ? [kind, at] : [kind, at, limit])) : []);

/** Each cut's place with why it exists: the reason, and the sub-reason where it has one. */
const reasonsOf = (fact: Fact<TraceValue>) => (fact.status === "partial" ? fact.cuts.map(({ at, reason, subReason }) => (subReason === undefined ? [at[0], reason] : [at[0], reason, subReason])) : []);

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

test("a file the index did not hold cuts a trace only when it shares the runtime of a walked file", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], edges: CONTAINS, notIndexed: ["src/Order.java", "src/c.ts"] });
  assert.deepEqual(reasonsOf(fact), [["src/c.ts", "not-indexed"]]);
});

test("a method no source's syntax states is a dispatch cut when an interface owns it, listing the implementations below", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send"), fakeNode("Impl", "class", B, 5, 7), fakeNode("Impl.send", "method", B, 6, 6, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, { from: "Impl", to: "Impl.send", kind: "contains" }, { from: "Impl", to: "Port", kind: "implements" }, call("run", "Port.send", 8, 4)];

  const fact = await factOf({ nodes, edges });

  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/b.ts:2 send", "src/b.ts::Impl.send"]]]);
  assert.deepEqual(reasonsOf(fact), [["src/b.ts:2 send", "dispatch", "unproven"]]);
});

test("a body-less method whose declared hierarchy proves one body expands that body below it, via dispatch, with it as the one alternative", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send"), fakeNode("Impl", "class", B, 5, 9), fakeNode("Impl.send", "method", B, 6, 8, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, { from: "Impl", to: "Impl.send", kind: "contains" }, { from: "Impl", to: "Port", kind: "implements" }, call("run", "Port.send", 8, 4)];
  const callables = { [B]: [{ name: "send", start: 2, nameLine: 2, body: false, overridable: true }] };

  const fact = await factOf({ nodes, edges, callables, sources: [{ path: B, content: "" }], unresolved: [OUTWARD_CALL("Impl.send", B, 7)], roots: { max: { kind: "ambient", name: "Math" } }, dispatch: { send: { kind: "bodies", bodies: [{ file: B, start: 6, nameLine: 6 }] } } });

  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps.map(({ symbol, file, line, parent, via, at, alternatives }) => ({ symbol, file, line, parent, via, at, alternatives })), [
    { symbol: "run", file: A, line: 5, parent: undefined, via: undefined, at: undefined, alternatives: undefined },
    { symbol: "send", file: B, line: 2, parent: 0, via: "call", at: { line: 8, column: 5 }, alternatives: [{ symbol: "send", file: B, start: 6, end: 8 }] },
    { symbol: "send", file: B, line: 6, parent: 1, via: "dispatch", at: undefined, alternatives: undefined },
  ]);
});

test("a body-less method whose declared hierarchy proves several bodies is a cut listing them, with every one as an alternative, and expands none", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send"), fakeNode("One", "class", B, 5, 7), fakeNode("One.send", "method", B, 6, 6, "send"), fakeNode("Two", "class", B, 8, 10), fakeNode("Two.send", "method", B, 9, 9, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, { from: "One", to: "One.send", kind: "contains" }, { from: "Two", to: "Two.send", kind: "contains" }, call("run", "Port.send", 8, 4)];
  const callables = { [B]: [{ name: "send", start: 2, nameLine: 2, body: false, overridable: true }] };

  const fact = await factOf({ nodes, edges, callables, sources: [{ path: B, content: "" }], dispatch: { send: { kind: "bodies", bodies: [{ file: B, start: 6, nameLine: 6 }, { file: B, start: 9, nameLine: 9 }] } } });

  assert.deepEqual(valueOf(fact).steps.map(({ symbol, line, alternatives }) => ({ symbol, line, alternatives: alternatives?.map((body) => body.start) })), [
    { symbol: "run", line: 5, alternatives: undefined },
    { symbol: "send", line: 2, alternatives: [6, 9] },
  ]);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/b.ts:2 send", "src/b.ts::One.send", "src/b.ts::Two.send"]]]);
  assert.deepEqual(reasonsOf(fact), [["src/b.ts:2 send", "dispatch", "several-bodies"]]);
});

test("a proven body the index does not place as one method proves nothing: the body-less method stays a cut listing the implementations below its owner", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send"), fakeNode("Impl", "class", B, 5, 7), fakeNode("Impl.send", "method", B, 6, 6, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, { from: "Impl", to: "Impl.send", kind: "contains" }, { from: "Impl", to: "Port", kind: "implements" }, call("run", "Port.send", 8, 4)];
  const callables = { [B]: [{ name: "send", start: 2, nameLine: 2, body: false, overridable: true }] };

  const fact = await factOf({ nodes, edges, callables, sources: [{ path: B, content: "" }], dispatch: { send: { kind: "bodies", bodies: [{ file: B, start: 12, nameLine: 12 }] } } });

  assert.deepEqual(valueOf(fact).steps.map(({ symbol, alternatives }) => [symbol, alternatives]), [["run", undefined], ["send", undefined]]);
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

test("a call the index resolved into an edge of another kind is settled as the call it was, never dropped", async () => {
  const navigates: FakeEdge = { from: "run", to: "route", kind: "navigates", line: 8, column: 4, resolvedFrom: { name: "this.router.navigate", kind: "calls" } };
  const fact = await factOf({ nodes: [SVC, RUN, fakeNode("route", "route", B, 1), callee("navigate", B, 5)], edges: [...CONTAINS, navigates] });

  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:8 this.router.navigate", "src/b.ts::navigate"]]]);
});

test("a property whose initializer's only call the index resolved into an edge of another kind is a root", async () => {
  const property = fakeNode("toArticle", "property", A, 3);
  const navigates: FakeEdge = { from: "toArticle", to: "route", kind: "navigates", line: 3, column: 14, resolvedFrom: { name: "this.router.navigate", kind: "calls" } };
  const fact = await factOf({ nodes: [SVC, property, fakeNode("route", "route", B, 1)], edges: [{ from: "Svc", to: "toArticle", kind: "contains" }, navigates] }, [{ file: A, symbol: "Svc.toArticle" }]);

  assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["toArticle"]);
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

test("a call the receiver's declared type names steps at that method, whatever method the index resolved it to, and a method the index does not place proves nothing", async () => {
  const nodes = [SVC, RUN, fakeNode("Repo.save", "method", B, 3, 5, "save"), fakeNode("Impl.save", "method", B, 7, 9, "save"), fakeNode("Repo.find", "method", B, 11, 13, "find")];
  const unresolved: FakeUnresolved[] = [{ from: "run", name: "this.repo.find", kind: "calls", file: A, line: 10, column: 4 }];
  const options = { nodes, edges: [...CONTAINS, call("run", "Impl.save", 9, 4)], unresolved, sources: [{ path: B, content: "" }] };

  const proven = await factOf({ ...options, receivers: { save: { kind: "method", file: B, start: 3, nameLine: 3 }, find: { kind: "method", file: B, start: 11, nameLine: 11 } } });
  const unplaced = await factOf({ ...options, receivers: { save: { kind: "method", file: B, start: 20, nameLine: 20 }, find: { kind: "method", file: B, start: 20, nameLine: 20 } } });

  assert.deepEqual(cutsOf(proven), []);
  assert.deepEqual(valueOf(proven).steps[0]?.leaves?.map(({ file, start }) => [file, start]), [[B, 3], [B, 11]]);
  assert.deepEqual(cutsOf(unplaced), [
    ["unresolved-link", ["src/a.ts:10 this.repo.find", "src/b.ts::find"]],
    ["unresolved-link", ["src/a.ts:9 save", "src/b.ts:3 save", "src/b.ts:7 save"]],
  ]);
});

test("a method a type variable's bound names proves no step, for a resolved call or an unsettled member call, which stay cuts as an unproven receiver's", async () => {
  const nodes = [SVC, RUN, fakeNode("Repo.save", "method", B, 3, 5, "save"), fakeNode("Repo.find", "method", B, 11, 13, "find")];
  const unresolved: FakeUnresolved[] = [{ from: "run", name: "this.repo.find", kind: "calls", file: A, line: 10, column: 4 }];
  const options = { nodes, edges: [...CONTAINS, call("run", "Repo.save", 9, 4)], unresolved, sources: [{ path: B, content: "" }] };

  const bound = await factOf({ ...options, receivers: { save: { kind: "method", file: B, start: 3, nameLine: 3, bound: true }, find: { kind: "method", file: B, start: 11, nameLine: 11, bound: true } } });
  const unproven = await factOf({ ...options, receivers: { save: { kind: "unproven" }, find: { kind: "unproven" } } });

  assert.deepEqual(valueOf(bound).steps.map((step) => [step.symbol, step.leaves]), [["run", undefined]]);
  assert.deepEqual(cutsOf(bound), cutsOf(unproven));
});

test("a body reads its receivers' declared types once, for its resolved calls and its unsettled member calls together", async () => {
  const reads: (readonly string[])[] = [];
  const nodes = [SVC, RUN, fakeNode("Repo.save", "method", B, 3, 5, "save"), fakeNode("Repo.find", "method", B, 11, 13, "find")];
  const unresolved: FakeUnresolved[] = [{ from: "run", name: "this.repo.find", kind: "calls", file: A, line: 10, column: 4 }];

  await factOf({ nodes, edges: [...CONTAINS, call("run", "Repo.save", 9, 4)], unresolved, onReceivers: (members) => reads.push(members) });

  assert.deepEqual(reads, [["save", "find"]]);
});

test("a call the index resolved on a receiver whose method nothing proves is a cut, and one the receivers say nothing about stays a step", async () => {
  const options = { nodes: [SVC, RUN, fakeNode("Repo.save", "method", B, 3, 5, "save")], edges: [...CONTAINS, call("run", "Repo.save", 9, 4)] };

  assert.deepEqual(cutsOf(await factOf({ ...options, receivers: { save: { kind: "unproven" } } })), [["unresolved-link", ["src/a.ts:9 save", "src/b.ts::save"]]]);
  assert.deepEqual(valueOf(await factOf(options)).steps[0]?.leaves?.map(({ file, start }) => [file, start]), [[B, 3]]);
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

test("a Java member call never lists a TypeScript or configuration declaration, so a name only they declare leaves the repository", async () => {
  const JAVA = "src/main/java/shop/Svc.java";
  const options = {
    nodes: [fakeNode("Svc", "class", JAVA, 1, 40), fakeNode("run", "method", JAVA, 5, 20), fakeNode("Form.save", "method", B, 3, 5, "save"), fakeNode("save", "property", "src/main/resources/application.yml", 2, 2)],
    unresolved: [{ from: "run", name: "repo.save", kind: "calls", file: JAVA, line: 9, column: 4 }],
    memberNames: { [B]: ["save"] },
    sources: [{ path: B, content: "" }],
  };
  const targets = [{ file: JAVA, symbol: "run" }];
  const leaving = await factOf({ ...options, edges: [{ from: "Svc", to: "run", kind: "contains" }] }, targets);
  assert.equal(leaving.status, "complete");
  assert.deepEqual(valueOf(leaving).steps[0]?.external, [{ kind: "unnamed", names: ["repo.save"] }]);

  const repo = fakeNode("Repo.save", "method", "src/main/java/shop/Repo.java", 3, 5, "save");
  const cut = await factOf({ ...options, nodes: [...options.nodes, repo], edges: [{ from: "Svc", to: "run", kind: "contains" }] }, targets);
  assert.deepEqual(cutsOf(cut), [["unresolved-link", [`${JAVA}:9 repo.save`, "src/main/java/shop/Repo.java::save"]]]);
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

test("a line range wholly past the end of its file is an unknown-symbol fault, and one over trivia settles", async () => {
  const content = ["function f() {", "  return 1;", "}", "", "function g() {", "  return 2;", "}", "", "function h() {}", ""].join("\n");
  const nodes = [fakeNode("f", "function", B, 1, 3), fakeNode("g", "function", B, 5, 7), fakeNode("h", "function", B, 9, 9)];
  const past = await trace({ nodes, sources: [{ path: B, content }], trivia: { [B]: [4, 8, 10] } }, [{ file: B, start: 20, end: 25 }]);
  assert.ok(!past.answer.ok);
  assert.equal(past.answer.fault.kind, "unknown-symbol");
  assert.deepEqual(past.answer.fault.kind === "unknown-symbol" && past.answer.fault.entries, [{ file: B, start: 20, end: 25, absent: false, candidates: ["f", "g", "h"] }]);

  const trivia = await trace({ nodes, sources: [{ path: B, content }], trivia: { [B]: [4, 8, 10] } }, [{ file: B, start: 4, end: 4 }]);
  assert.ok(trivia.answer.ok);
  if (!trivia.answer.ok || trivia.answer.value.status === "unknown") assert.fail("expected a trace fact");
  assert.deepEqual(trivia.answer.value.value.settled, [{ basis: "range", file: B, start: 4, end: 4, reason: "no-token", candidates: ["f", "g", "h"] }]);
  assert.deepEqual(trivia.answer.value.value.roots, [{ target: "src/b.ts:4-4", steps: [] }]);
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
  assert.deepEqual(answer.fault.kind === "unknown-symbol" ? answer.fault.entries : [], [{ file: A, symbol: "missing", absent: false, candidates: ["Svc", "run"] }]);
});

test("a symbol target on a path the snapshot does not hold is absent, with the snapshot files that declare that name", async () => {
  const { answer } = await trace({ nodes: [fakeNode("save", "function", A, 3, 5, "save")] }, [{ file: "src/gone.ts", symbol: "save" }]);
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" ? answer.fault.entries : [], [{ file: "src/gone.ts", symbol: "save", absent: true, candidates: [A] }]);
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

test("a member call on a local the source binds to a class it declares, or to one its imports bind, is a step at that class's method", async () => {
  const declared = await factOf({ ...boundCall({ kind: "declared", name: "Repo", line: 1 }), nodes: [SVC, RUN, fakeNode("Repo", "class", A, 22, 28), fakeNode("Repo.save", "method", A, 24, 26, "save"), fakeNode("Other.save", "method", B, 30, 32, "save")], edges: [...CONTAINS, { from: "Repo", to: "Repo.save", kind: "contains" }], unresolved: [{ from: "run", name: "store.save", kind: "calls", file: A, line: 9, column: 4 }, OUTWARD_CALL("Repo.save", A, 25)], receiverBindings: { [A]: [{ line: 9, column: 5, receiver: "store", member: "save", holds: { kind: "declared", name: "Repo", line: 22 } }] }, sources: [{ path: A, content: "" }] });
  const constructed = await factOf({ ...boundCall({ kind: "constructed", name: "Repo", line: 8, column: 17 }), imports: { [A]: [{ local: "Repo", from: B }] } });

  for (const fact of [declared, constructed]) {
    assert.equal(fact.status, "complete");
    assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, at, via }) => [symbol, at, via]), [["save", { line: 9, column: 5 }, "call"]]);
  }
  assert.deepEqual([valueOf(declared).steps[1]?.file, valueOf(constructed).steps[1]?.file], [A, B]);
});

test("a member call whose spelling breaks across lines reads its receiver as the call written on one line does", async () => {
  const options = boundCall({ kind: "constructed", name: "Repo", line: 8, column: 17 });
  const fact = await factOf({ ...options, unresolved: [{ from: "run", name: "store\n      .save", kind: "calls", file: A, line: 9, column: 4 }, OUTWARD_CALL("Repo.save", B, 4)], imports: { [A]: [{ local: "Repo", from: B }] } });

  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, file }) => [symbol, file]), [["save", B]]);
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

test("an external leaf at or below a path the repository writes, under a package it writes through, or calling a member it writes on a prototype the receiver may inherit, stays a cut, wherever the walk settles it", async () => {
  const globals = (...names: string[]): ReplacedRoots => written(...names.map((name) => [name]));
  const packages = (...names: string[]): ReplacedRoots => ({ ...written(), packages: new Set(names) });
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
    ["every global", { ...boundCall({ kind: "literal", type: "Array" }), replaced: written(["*"]) }],
    ["polyfill on a literal's type", { ...boundCall({ kind: "literal", type: "Array" }), replaced: written(["Array", "prototype", "*"]) }],
    ["named member on a literal's type", { ...boundCall({ kind: "literal", type: "Array" }), replaced: written(["Array", "prototype", "save"]) }],
    ["member every object inherits", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("Math.max"), roots: { max: { kind: "ambient", name: "Math" } }, replaced: written(["Object", "prototype", "max"]) }],
    ["through the global object", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("window.fetch"), roots: { fetch: { kind: "ambient", name: "window" } }, replaced: written(["fetch"]) }],
    ["unnamed, named on a prototype", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("list.push"), replaced: written(["Array", "prototype", "push"]) }],
    ["unnamed, polyfill", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("list.push"), replaced: written(["Array", "prototype", "*"]) }],
    ["rooted, on a prototype its receiver inherits", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("document.body.appendChild"), roots: { appendChild: { kind: "ambient", name: "document" } }, replaced: written(["Element", "prototype", "appendChild"]) }],
    ["bare, on a prototype the global object inherits", { nodes: [SVC, RUN, callee("addEventListener")], edges: [...CONTAINS, call("run", "addEventListener", 8, 4)], roots: { addEventListener: { kind: "ambient", name: "addEventListener" } }, replaced: written(["EventTarget", "prototype", "addEventListener"]) }],
    ["constructed, on a prototype its class inherits", { ...boundCall({ kind: "constructed", name: "Map", line: 8, column: 17 }), roots: { Map: { kind: "ambient", name: "Map", bare: true } }, replaced: written(["Base", "prototype", "save"]) }],
  ];

  for (const [name, options] of cases) {
    const fact = await factOf(options);
    assert.equal(fact.status, "partial", name);
    assert.deepEqual(valueOf(fact).steps.flatMap((step) => step.external ?? []), [], name);
  }
});

test("a member call on a receiver annotated with a library or a package type is a leaf under that type, and one whose type is unknown or replaced stays a cut", async () => {
  const annotated = (type: string): Options => boundCall({ kind: "annotated", type, line: 8, column: 20 });
  const cut = [["unresolved-link", ["src/a.ts:9 store.save", "src/a.ts::save", "src/b.ts::Repo.save"]]];
  const global = await factOf({ ...annotated("Storage"), declared: { Storage: { kind: "global", name: "Storage" } } });
  const imported = await factOf({ ...annotated("Store"), declared: { Store: { kind: "package", module: "@ngrx/store", name: "Store" } } });
  const unknown = await factOf(annotated("Repo"));
  const replaced = await factOf({ ...annotated("Storage"), declared: { Storage: { kind: "global", name: "Storage" } }, replaced: written(["Storage", "prototype", "save"]) });

  assert.deepEqual(valueOf(global).steps.flatMap((step) => step.external ?? []), [{ kind: "global", names: ["store.save"] }]);
  assert.deepEqual(valueOf(imported).steps.flatMap((step) => step.external ?? []), [{ kind: "import", module: "@ngrx/store", names: ["store.save"] }]);
  for (const fact of [unknown, replaced]) assert.deepEqual(cutsOf(fact), cut);
});

test("a member call on a receiver annotated with a type the declared types do not place outside the repository steps at the method that type names", async () => {
  const fact = await factOf({ ...boundCall({ kind: "annotated", type: "Repo", line: 8, column: 20 }), receivers: { save: { kind: "method", file: B, start: 3, nameLine: 3 } } });

  assert.deepEqual(valueOf(fact).steps.map((step) => [step.file, step.line, step.via ?? null]), [[A, 5, null], [B, 3, "call"]]);
});

test("a write below another path, beside the called member, or on an object no receiver inherits from leaves the leaf external", async () => {
  const memberCall = (name: string): FakeUnresolved[] => [{ from: "run", name, kind: "calls", file: A, line: 9, column: 4 }];
  const cases: [string, Options][] = [
    ["process.cwd beside process.env", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("process.cwd"), roots: { cwd: { kind: "ambient", name: "process" } }, replaced: written(["process", "env", "*"]) }],
    ["unnamed beside process.env", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("list.push"), replaced: written(["process", "env", "*"]) }],
    ["unnamed beside another prototype member", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("list.push"), replaced: written(["Array", "prototype", "flat"]) }],
    ["literal beside another member", { ...boundCall({ kind: "literal", type: "Array" }), replaced: written(["Array", "prototype", "flat"]) }],
    ["rooted below its member", { nodes: [SVC, RUN], edges: CONTAINS, unresolved: memberCall("Math.max"), roots: { max: { kind: "ambient", name: "Math" } }, replaced: written(["Math", "max", "extra"]) }],
  ];

  for (const [name, options] of cases) assert.equal(valueOf(await factOf(options)).steps.flatMap((step) => step.external ?? []).length, 1, name);
});

const handlerAt = (path: string, symbol: string, line: number) => ({ path, symbol, line });
const route = (name: string, handler: ReturnType<typeof handlerAt>): Finding<Entrypoint> => ({ status: "complete", value: { kind: "http-route", name, method: "POST", path: name.slice(name.indexOf(" ") + 1), handler, basePath: { status: "complete", value: { path: "", source: "none" }, evidence: [] } } as unknown as Entrypoint, evidence: [{ path: handler.path, line: handler.line }] });
const job = (name: string, handler: ReturnType<typeof handlerAt>): Finding<Entrypoint> => ({ status: "complete", value: { kind: "job", name, trigger: { attribute: "cron", value: "0" }, handler }, evidence: [{ path: handler.path, line: handler.line }] });
const page = (name: string, component: ReturnType<typeof handlerAt> | "unknown", at = { path: B, line: 9 }): Finding<Entrypoint> => ({ status: "complete", value: { kind: "ui-route", name, path: name, component, guards: [] }, evidence: [at] });

/** `Api` declares two overloads of `handle` (lines 3 and 7) and `other` (line 12). */
const API: FakeNode[] = [fakeNode("Api", "class", A, 1, 20), fakeNode("Api.handle#1", "method", A, 3, 5, "handle"), fakeNode("Api.handle#2", "method", A, 7, 10, "handle"), fakeNode("Api.other", "method", A, 12, 14, "other")];
const API_EDGES: FakeEdge[] = ["Api.handle#1", "Api.handle#2", "Api.other"].map((to) => ({ from: "Api", to, kind: "contains" }));

test("an entrypoint target roots at the handler of each map entrypoint of its kind and name, at the handler's line", async () => {
  const findings = [route("POST /orders", handlerAt(A, "Api.handle", 7)), route("GET /orders", handlerAt(A, "Api.other", 12)), job("POST /orders", handlerAt(A, "Api.other", 12))];
  const fact = await factOf({ nodes: API, edges: API_EDGES, findings }, [{ kind: "http-route", name: "POST /orders" }]);
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.id, step.symbol, step.line]), [[0, "handle", 7]]);
  assert.deepEqual(valueOf(fact).roots, [{ target: "http-route POST /orders", steps: [0] }]);
});

test("a callback target roots at its handler's line", async () => {
  const finding = { status: "complete", value: { kind: "callback", name: "a.b.A", contract: { type: "a.b.A" }, handler: handlerAt(A, "Api.handle", 7) }, evidence: [{ path: A, line: 7 }] } as Finding<Entrypoint>;
  const fact = await factOf({ nodes: API, edges: API_EDGES, findings: [finding] }, [{ kind: "callback", name: "a.b.A" } as TraceTarget]);
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.line]), [["handle", 7]]);
});

test("a UI route target roots at its component", async () => {
  const fact = await factOf({ nodes: API, edges: API_EDGES, findings: [page("/orders", handlerAt(A, "Api", 1))] }, [{ kind: "ui-route", name: "/orders" }]);
  assert.deepEqual(valueOf(fact).roots, [{ target: "ui-route /orders", steps: [0] }]);
  assert.equal(valueOf(fact).steps[0]!.symbol, "Api");
});

test("a UI route whose component the sources do not name is a cut at the route, with no root", async () => {
  const fact = await factOf({ nodes: API, edges: API_EDGES, findings: [page("/orders", "unknown", { path: B, line: 9 })] }, [{ kind: "ui-route", name: "/orders" }]);
  assert.deepEqual(valueOf(fact).roots, [{ target: "ui-route /orders", steps: [] }]);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", [`${B}:9 /orders`]]]);
});

test("a handler no declaration of the index holds is a cut at the handler, never a silent empty root", async () => {
  const fact = await factOf({ nodes: API, edges: API_EDGES, findings: [route("POST /orders", handlerAt(B, "Gone.handle", 4))] }, [{ kind: "http-route", name: "POST /orders" }]);
  assert.deepEqual(valueOf(fact).roots, [{ target: "http-route POST /orders", steps: [] }]);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", [`${B}:4 Gone.handle`]]]);
  assert.deepEqual(reasonsOf(fact), [[`${B}:4 Gone.handle`, "handler-unplaced"]]);
});

test("an entrypoint the map does not hold is an unknown-entrypoint fault listing the map's names of that kind", async () => {
  const findings = [route("GET /orders", handlerAt(A, "Api.other", 12)), route("DELETE /orders", handlerAt(A, "Api.other", 12)), job("POST /orders", handlerAt(A, "Api.other", 12))];
  const { answer } = await trace({ nodes: API, edges: API_EDGES, findings }, [{ kind: "http-route", name: "POST /orders" }, { file: A, symbol: "other" }]);
  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "unknown-entrypoint");
  assert.deepEqual(answer.fault.kind === "unknown-entrypoint" && answer.fault.entries, [{ kind: "http-route", name: "POST /orders", candidates: ["DELETE /orders", "GET /orders"] }]);
});

test("a trace by declaration never reads the map's entrypoints", async () => {
  let extracted = 0;
  await factOf({ nodes: API, edges: API_EDGES, onExtract: () => void (extracted += 1) }, [{ file: A, symbol: "other" }]);
  assert.equal(extracted, 0);
});

const PAGE_HTML = "src/page.html";
/** A component `Page` whose members are declared out of the order a page runs them, and a component `Child` its template uses. */
const PAGE_MEMBERS: FakeNode[] = [
  fakeNode("Page.ngOnDestroy", "method", A, 3, 4, "ngOnDestroy"),
  fakeNode("Page.save", "method", A, 6, 8, "save"),
  fakeNode("Page.ngOnInit", "method", A, 10, 12, "ngOnInit"),
  fakeNode("Page.data", "property", A, 14, 14, "data"),
  fakeNode("Page.constructor", "method", A, 16, 18, "constructor"),
  fakeNode("Page.helper", "method", A, 20, 22, "helper"),
  fakeNode("Page.ngAfterViewInit", "method", A, 24, 26, "ngAfterViewInit"),
  fakeNode("Page.reset", "method", A, 28, 30, "reset"),
];
const PAGE_NODES: FakeNode[] = [fakeNode("Page", "class", A, 1, 60), ...PAGE_MEMBERS, fakeNode("Child", "class", B, 1, 20), fakeNode("Child.ngOnInit", "method", B, 3, 5, "ngOnInit")];
const PAGE_EDGES: FakeEdge[] = [...PAGE_MEMBERS.map(({ id }) => ({ from: "Page", to: id, kind: "contains" })), { from: "Child", to: "Child.ngOnInit", kind: "contains" }];
const PAGE_OUTWARD: FakeUnresolved[] = [...PAGE_MEMBERS, fakeNode("Child.ngOnInit", "method", B, 3, 5)].map(({ id, file, start }) => OUTWARD_CALL(id, file, start));
const PAGE_REF = { path: A, symbol: "Page", line: 1 };
const CHILD_REF = { path: B, symbol: "Child", line: 1 };
const handlerCall = (member: string, line: number) => ({ file: PAGE_HTML, line, column: 5, member });
const PAGE_RELATIONS: Pick<RelationExtraction, "relations" | "templates"> = {
  relations: [{ status: "complete", value: { kind: "uses-component", name: "Page>Child", from: PAGE_REF, to: CHILD_REF }, evidence: [{ path: PAGE_HTML, line: 4 }] }],
  templates: [{ component: PAGE_REF, handlers: [handlerCall("reset", 3), handlerCall("save", 5), handlerCall("reset", 6)], eventCalls: [], uses: [CHILD_REF] }, { component: CHILD_REF, handlers: [], eventCalls: [], uses: [] }],
};
const pageShape = (fact: Fact<TraceValue>) => valueOf(fact).steps.map((step) => [step.symbol, step.parent ?? null, step.via ?? null]);

test("a UI route's component runs its constructor and field initializers, then its lifecycle hooks in Angular's order, then its template's event handlers, then its template children, then its other members", async () => {
  const fact = await factOf({ nodes: PAGE_NODES, edges: PAGE_EDGES, unresolved: PAGE_OUTWARD, relations: PAGE_RELATIONS, findings: [page("/p", handlerAt(A, "Page", 1))] }, [{ kind: "ui-route", name: "/p" }]);
  assert.deepEqual(pageShape(fact), [
    ["Page", null, null],
    ["data", 0, "member"], ["constructor", 0, "member"],
    ["ngOnInit", 0, "member"], ["ngAfterViewInit", 0, "member"], ["ngOnDestroy", 0, "member"],
    ["reset", 0, "member"], ["save", 0, "member"],
    ["Child", 0, "template"], ["ngOnInit", 8, "member"],
    ["helper", 0, "member"],
  ]);
});

test("the same component traced by its declaration keeps its members in source order, with no template children", async () => {
  const fact = await factOf({ nodes: PAGE_NODES, edges: PAGE_EDGES, unresolved: PAGE_OUTWARD, relations: PAGE_RELATIONS }, [{ file: A, symbol: "Page" }]);
  assert.deepEqual(pageShape(fact).map(([symbol]) => symbol), ["Page", "ngOnDestroy", "save", "ngOnInit", "data", "constructor", "helper", "ngAfterViewInit", "reset"]);
});

test("a handler the template binds that the component does not declare is a cut at the binding, never a silently missing step", async () => {
  const relations = { ...PAGE_RELATIONS, templates: [{ component: PAGE_REF, handlers: [handlerCall("gone", 7)], eventCalls: [], uses: [] }] };
  const fact = await factOf({ nodes: PAGE_NODES, edges: PAGE_EDGES, unresolved: PAGE_OUTWARD, relations, findings: [page("/p", handlerAt(A, "Page", 1))] }, [{ kind: "ui-route", name: "/p" }]);
  assert.ok(cutsOf(fact).some(([kind, at]) => kind === "unresolved-link" && JSON.stringify(at) === JSON.stringify([`${PAGE_HTML}:7 gone`])), JSON.stringify(cutsOf(fact)));
  assert.ok(reasonsOf(fact).some(([at, reason]) => at === `${PAGE_HTML}:7 gone` && reason === "page-unplanned"));
});

test("a page whose template cannot be read, or that the relations hold no template for, is a cut there and still lists what its class runs", async () => {
  const cases = [
    { templates: [{ component: PAGE_REF, handlers: [], eventCalls: [], uses: [], unreadable: { path: PAGE_HTML, line: 1 } }], at: `${PAGE_HTML}:1` },
    { templates: [], at: `${A}:1 Page` },
  ];
  for (const { templates, at } of cases) {
    const fact = await factOf({ nodes: PAGE_NODES, edges: PAGE_EDGES, unresolved: PAGE_OUTWARD, relations: { relations: [], templates }, findings: [page("/p", handlerAt(A, "Page", 1))] }, [{ kind: "ui-route", name: "/p" }]);
    assert.ok(cutsOf(fact).some(([kind, places]) => kind === "unresolved-link" && JSON.stringify(places) === JSON.stringify([at])), at);
    assert.equal(valueOf(fact).steps.filter((step) => step.parent === 0).length, 8, at);
  }
});

test("a page's template item the relations could not place, or a used declaration the index does not hold, is a cut at the template; another component's items are not the page's", async () => {
  const other = { path: B, symbol: "Other", line: 30 };
  const relations: Pick<RelationExtraction, "relations" | "templates"> = {
    relations: [
      { status: "unknown", reason: "unresolved", evidence: [{ path: PAGE_HTML, line: 2 }] },
      { status: "unknown", reason: "unresolved", evidence: [{ path: PAGE_HTML, line: 12 }] },
      { status: "complete", value: { kind: "uses-directive", name: "Page>Lost", from: PAGE_REF, to: { path: B, symbol: "Lost", line: 40 } }, evidence: [{ path: PAGE_HTML, line: 3 }] },
      { status: "complete", value: { kind: "uses-component", name: "Other>Child", from: other, to: CHILD_REF }, evidence: [{ path: "src/other.html", line: 1 }] },
    ],
    templates: [{ component: PAGE_REF, lines: { path: PAGE_HTML, start: 1, end: 10 }, handlers: [], eventCalls: [], uses: [] }],
  };
  const fact = await factOf({ nodes: PAGE_NODES, edges: PAGE_EDGES, unresolved: PAGE_OUTWARD, relations, findings: [page("/p", handlerAt(A, "Page", 1))] }, [{ kind: "ui-route", name: "/p" }]);
  const templateCuts = cutsOf(fact).filter(([, at]) => (at as string[])[0]!.startsWith(PAGE_HTML));
  assert.deepEqual(templateCuts, [["unresolved-link", [`${PAGE_HTML}:2`]], ["unresolved-link", [`${PAGE_HTML}:3 Lost`]]]);
  assert.equal(valueOf(fact).steps.some((step) => step.via === "template"), false);
});

test("a class root beside a page root keeps its members in source order and owes no template", async () => {
  const plain = [fakeNode("Plain", "class", B, 30, 50), fakeNode("Plain.ngOnDestroy", "method", B, 31, 32, "ngOnDestroy"), fakeNode("Plain.ngOnInit", "method", B, 34, 35, "ngOnInit")];
  const fact = await factOf({
    nodes: [...PAGE_NODES, ...plain],
    edges: [...PAGE_EDGES, { from: "Plain", to: "Plain.ngOnDestroy", kind: "contains" }, { from: "Plain", to: "Plain.ngOnInit", kind: "contains" }],
    unresolved: [...PAGE_OUTWARD, OUTWARD_CALL("Plain.ngOnDestroy", B, 31), OUTWARD_CALL("Plain.ngOnInit", B, 34)],
    relations: PAGE_RELATIONS,
    findings: [page("/p", handlerAt(A, "Page", 1))],
  }, [{ kind: "ui-route", name: "/p" }, { file: B, symbol: "Plain" }]);
  const steps = valueOf(fact).steps;
  const plainRoot = steps.find((step) => step.symbol === "Plain")!;
  assert.deepEqual(steps.filter((step) => step.parent === plainRoot.id).map((step) => step.line), [31, 34]);
  assert.equal(cutsOf(fact).some(([, at]) => (at as string[]).includes(`${B}:30 Plain`)), false);
});

test("an event binding's call to a field's method runs the method the relations prove at that place, and any call they prove nothing for is a cut there", async () => {
  const store = [fakeNode("Store", "class", B, 30, 50), fakeNode("Store.save", "method", B, 32, 34, "save")];
  const storeRef = { path: B, symbol: "Store", line: 30 };
  const proof = { owner: PAGE_REF, receiver: storeRef, member: { path: B, symbol: "save", line: 32 }, reference: { file: PAGE_HTML, line: 2, column: 20, name: "store.save", kind: "calls" as const }, template: true as const };
  const relations: Pick<RelationExtraction, "relations" | "templates" | "memberUses"> = {
    relations: [],
    templates: [{ component: PAGE_REF, handlers: [handlerCall("save", 5)], eventCalls: [{ file: PAGE_HTML, line: 2, column: 20, name: "store.save" }, { file: PAGE_HTML, line: 4, column: 9, name: "$event.stopPropagation" }], uses: [] }],
    memberUses: [proof],
  };
  const fact = await factOf({ nodes: [...PAGE_NODES, ...store], edges: [...PAGE_EDGES, { from: "Store", to: "Store.save", kind: "contains" }], unresolved: [...PAGE_OUTWARD, OUTWARD_CALL("Store.save", B, 33)], relations, findings: [page("/p", handlerAt(A, "Page", 1))] }, [{ kind: "ui-route", name: "/p" }]);
  const children = valueOf(fact).steps.filter((step) => step.parent === 0).map((step) => [step.symbol, step.file, step.via]);
  assert.deepEqual(children.slice(5, 7), [["save", B, "template"], ["save", A, "member"]]);
  assert.ok(cutsOf(fact).some(([, at]) => JSON.stringify(at) === JSON.stringify([`${PAGE_HTML}:4 $event.stopPropagation`])), JSON.stringify(cutsOf(fact)));
  assert.equal(cutsOf(fact).some(([, at]) => (at as string[])[0]!.startsWith(`${PAGE_HTML}:2`)), false);
});

test("a page's template children run in the order the template first uses them, never grouped by relation kind", async () => {
  const used = [fakeNode("Mark", "class", B, 30, 40), fakeNode("Fmt", "class", B, 42, 50)];
  const at = (symbol: string, line: number) => ({ path: B, symbol, line });
  const relation = (kind: "uses-component" | "uses-directive" | "uses-pipe", to: { path: string; symbol: string; line: number }) => ({ status: "complete" as const, value: { kind, name: `Page>${to.symbol}`, from: PAGE_REF, to }, evidence: [{ path: PAGE_HTML, line: 4 }] });
  const relations: Pick<RelationExtraction, "relations" | "templates"> = {
    relations: [relation("uses-component", CHILD_REF), relation("uses-directive", at("Mark", 30)), relation("uses-pipe", at("Fmt", 42))],
    templates: [{ component: PAGE_REF, handlers: [], eventCalls: [], uses: [at("Mark", 30), at("Fmt", 42), CHILD_REF] }],
  };
  const fact = await factOf({ nodes: [...PAGE_NODES, ...used], edges: PAGE_EDGES, unresolved: [...PAGE_OUTWARD, OUTWARD_CALL("Mark", B, 31), OUTWARD_CALL("Fmt", B, 43)], relations, findings: [page("/p", handlerAt(A, "Page", 1))] }, [{ kind: "ui-route", name: "/p" }]);
  assert.deepEqual(valueOf(fact).steps.filter((step) => step.via === "template").map((step) => step.symbol), ["Mark", "Fmt", "Child"]);
});

/**
 * A call `store.save()` at line 9, column 5 of `run` that the index resolved to `Repo.save`, whose receiver `store` is a
 * parameter of `run` the source binds as `holds` says, if at all.
 */
const resolvedOnParameter = (holds?: ReceiverBinding["holds"]): Options => ({
  nodes: [SVC, RUN, REPO, REPO_SAVE, fakeNode("Twin", "class", A, 22, 28), fakeNode("Twin.save", "method", A, 24, 26, "save")],
  edges: [...CONTAINS, { from: "Repo", to: "Repo.save", kind: "contains" }, { from: "Twin", to: "Twin.save", kind: "contains" }, call("run", "Repo.save", 9, 4)],
  unresolved: [OUTWARD_CALL("Repo.save", B, 4), OUTWARD_CALL("Twin.save", A, 25)],
  receiverRoots: { save: { kind: "local", root: "store", lines: [5] } },
  receiverBindings: holds === undefined ? {} : { [A]: [{ line: 9, column: 5, receiver: "store", member: "save", holds }] },
  sources: [{ path: A, content: "" }],
});
const PARAMETER_CUT = [["unresolved-link", ["src/a.ts:9 save", "src/a.ts::Twin.save", "src/b.ts::Repo.save"]]];

const DECLARED = [{ kind: "node-modules" as const, at: "", path: "/host/checkout/node_modules" }];
const USED = [{ kind: "node-modules" as const, at: "", verified: false, digest: "read" }];
/** The checker's answer binding the call at `src/a.ts:9:5` named `name` to `target`. */
const typedAt = (name: string, target: TypeTarget): TypeBindingsAnswer => ({ status: "bound", bindings: [{ file: A, line: 9, column: 5, name, target }], unowned: [], refused: [], outputs: USED });
const REPO_SAVE_TYPE: TypeTarget = { kind: "repository", file: B, line: 3, name: "save" };

test("a call the type checker binds to another declaration is a step there, and the trace records the build output it read", async () => {
  const named: Options = { nodes: [SVC, RUN, callee("helper", A, 30), { ...callee("helper-b", B, 12), name: "helper" }], edges: [...CONTAINS, call("run", "helper", 9, 4)], unresolved: [OUTWARD_CALL("helper"), OUTWARD_CALL("helper-b", B, 13)] };

  const fact = await factOf({ ...named, typed: typedAt("helper", { kind: "repository", file: B, line: 12, name: "helper" }) });

  assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, file }) => [symbol, file]), [["helper", B]]);
  assert.deepEqual(fact.inputs.buildOutputs, USED);
});

test("a call on a structural parameter the type checker binds proves the dependence, not what runs: trace keeps its cut (structural parameter, ADR-0045 decision 5)", async () => {
  const fact = await factOf({ ...resolvedOnParameter({ kind: "annotated", type: "Repo", line: 8, column: 20 }), typed: typedAt("save", REPO_SAVE_TYPE) });

  assert.deepEqual(cutsOf(fact), PARAMETER_CUT);
  assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run"]);
});

test("a call on an inject() local a provider may replace that the type checker binds runs no proven class: trace keeps its cut (replaceable provider, ADR-0045 decision 5)", async () => {
  const holds = { class: { path: B, symbol: "Repo", line: 1 } };
  const owner = { path: A, symbol: "Svc", line: 1 };
  const written = (name: string): SyntaxCall => ({ kind: "calls", line: 9, column: 5, name, callee: "save", owners: [] });
  const replaceable: Options = { ...resolvedOnParameter(), syntaxCalls: { [A]: [written("store.save")] }, proofs: { locals: [{ owner, local: "store", holds }], memberUses: [{ ...SAVE_PROOF, reference: { ...SAVE_PROOF.reference, name: "store.save" }, substitutes: [] }], externalUses: [] } };

  const fact = await factOf({ ...replaceable, typed: typedAt("save", REPO_SAVE_TYPE) });

  assert.deepEqual(cutsOf(fact), PARAMETER_CUT);
  assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run"]);
});

test("a call the index resolved on a parameter or a variable nothing proves, or a method passed from one, is a cut listing the declarations of its name, never a step", async () => {
  const parameter = await factOf(resolvedOnParameter());
  const moduleVariable = await factOf({ ...resolvedOnParameter(), receiverRoots: { save: { kind: "declared", root: "store", lines: [2], captured: false } }, nodes: [...resolvedOnParameter().nodes, fakeNode("store", "constant", A, 2)] });
  const passed = await factOf({ ...resolvedOnParameter(), edges: [...resolvedOnParameter().edges!.slice(0, -1), { from: "run", to: "Repo.save", kind: "references", line: 9, column: 4 }] });

  for (const fact of [parameter, moduleVariable, passed]) {
    assert.deepEqual(cutsOf(fact), PARAMETER_CUT);
    assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run"]);
  }
});

test("a call the index resolved on a class, an import, this or a root nothing binds stays a step", async () => {
  for (const binding of [
    { kind: "declared", root: "Repo", lines: [1], captured: false },
    { kind: "import", root: "store", origin: { kind: "repository", file: B } },
    { kind: "this", member: "save" },
    { kind: "unknown" },
  ] satisfies RootBinding[]) {
    const fact = await factOf({ ...resolvedOnParameter(), nodes: [...resolvedOnParameter().nodes, fakeNode("Repo", "class", A, 1, 3)], receiverRoots: { save: binding } });
    assert.equal(fact.status, "complete", binding.kind);
    assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run", "save"], binding.kind);
  }
});

test("a call the index resolved on a variable into an interface keeps its dispatch cut", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, call("run", "Port.send", 8, 4)];

  const fact = await factOf({ nodes, edges, receiverRoots: { send: { kind: "local", root: "port", lines: [5] } } });

  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/b.ts:2 send"]]]);
});

test("a call the index resolved on a variable the source binds to a constructed class, or one the relations prove, is a step at the proven method", async () => {
  const constructed = await factOf({ ...resolvedOnParameter({ kind: "constructed", name: "Twin", line: 8, column: 17 }), roots: { Twin: { kind: "repository", file: A, bare: true } } });
  const proven = await factOf({ ...resolvedOnParameter(), proofs: { memberUses: [{ ...SAVE_PROOF, reference: { ...SAVE_PROOF.reference, name: "store.save" } }], externalUses: [] } });

  assert.deepEqual(valueOf(constructed).steps.slice(1).map(({ symbol, file, at }) => [symbol, file, at]), [["save", A, { line: 9, column: 5 }]]);
  assert.deepEqual(valueOf(proven).steps.slice(1).map(({ symbol, file, at }) => [symbol, file, at]), [["save", B, { line: 9, column: 5 }]]);
  for (const fact of [constructed, proven]) assert.equal(fact.status, "complete");
});

/** `resolvedOnParameter` annotated with `Repo`, which the import origins name nominal, and a class `Sub` below it that may override `save`. */
const nominalCall = (extra: { nodes?: FakeNode[]; edges?: FakeEdge[]; unresolved?: FakeUnresolved[] } = {}): Options => {
  const base = resolvedOnParameter({ kind: "annotated", type: "Repo", line: 8, column: 20 });
  return {
    ...base,
    nodes: [...base.nodes, ...(extra.nodes ?? [])],
    edges: [...base.edges!, ...(extra.edges ?? [])],
    unresolved: [...base.unresolved!, ...(extra.unresolved ?? [])],
    declared: { Repo: { kind: "nominal", file: B, name: "Repo", line: 1 } },
    imports: { [A]: [{ local: "Repo", from: B }] },
    callables: { [B]: [{ name: "save", start: 3, nameLine: 3, body: true, overridable: true }] },
    sources: [{ path: A, content: "" }, { path: B, content: "" }],
  };
};
const SUB = fakeNode("Sub", "class", "src/c.ts", 1, 5);
const SUB_SAVE = fakeNode("Sub.save", "method", "src/c.ts", 2, 4, "save");

test("a call on a receiver annotated with a nominal class is a step at the class's method, with a dispatch cut when a subclass overrides it", async () => {
  const alone = await factOf(nominalCall());
  const overridden = await factOf(nominalCall({ nodes: [SUB, SUB_SAVE], edges: [{ from: "Sub", to: "Sub.save", kind: "contains" }, { from: "Sub", to: "Repo", kind: "extends" }] }));

  assert.equal(alone.status, "complete");
  for (const fact of [alone, overridden]) assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, file }) => [symbol, file]), [["save", B]]);
  assert.deepEqual(cutsOf(overridden), [["unresolved-link", ["src/b.ts:3 save", "src/c.ts::Sub.save"]]]);
  assert.deepEqual(reasonsOf(overridden), [["src/b.ts:3 save", "dispatch", "overridable"]]);
});

test("a nominal class's inherited method is the step, and a class the index does not place, or a declaration of the name under heritage the index leaves unresolved, keeps the cut", async () => {
  const inherited = await factOf({
    ...nominalCall(),
    nodes: [SVC, RUN, REPO, fakeNode("Base", "class", "src/c.ts", 1, 9), fakeNode("Base.save", "method", "src/c.ts", 2, 4, "save")],
    edges: [...CONTAINS, { from: "Base", to: "Base.save", kind: "contains" }, { from: "Repo", to: "Base", kind: "extends" }, call("run", "Base.save", 9, 4)],
    unresolved: [OUTWARD_CALL("Base.save", "src/c.ts", 3)],
  });
  const unplaced = await factOf({ ...nominalCall(), declared: { Repo: { kind: "nominal", file: B, name: "Store", line: 1 } } });
  const unresolvedHeritage = await factOf(nominalCall({ nodes: [SUB, SUB_SAVE], edges: [{ from: "Sub", to: "Sub.save", kind: "contains" }], unresolved: [{ from: "Sub", name: "Alias", kind: "extends", file: "src/c.ts", line: 1, column: 18 }] }));
  const heritageOnValue = await factOf(nominalCall({ nodes: [SUB, SUB_SAVE, fakeNode("Alias", "constant", "src/c.ts", 7)], edges: [{ from: "Sub", to: "Sub.save", kind: "contains" }, { from: "Sub", to: "Alias", kind: "extends" }] }));

  assert.deepEqual(valueOf(inherited).steps.slice(1).map(({ symbol, file }) => [symbol, file]), [["save", "src/c.ts"]]);
  for (const fact of [unplaced, unresolvedHeritage, heritageOnValue]) assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run"]);
});

test("a call the index resolved on a field of this is a step only at what the relations or the field's binding prove, otherwise a cut", async () => {
  const onField: Options = { ...resolvedOnParameter(), receiverRoots: { save: { kind: "this", member: "store" } } };
  const unproven = await factOf(onField);
  const proven = await factOf({ ...onField, proofs: { memberUses: [{ ...SAVE_PROOF, reference: { ...SAVE_PROOF.reference, name: "this.store.save" } }], externalUses: [] } });
  const external = await factOf({ ...onField, proofs: { memberUses: [], externalUses: [{ owner: SAVE_PROOF.owner, field: "store", holds: "@ngrx/store#Store", reference: { ...SAVE_PROOF.reference, name: "this.store.save" } }] } });
  const nominal = await factOf({ ...nominalCall(), receiverRoots: { save: { kind: "this", member: "store" } } });

  assert.deepEqual(cutsOf(unproven), PARAMETER_CUT);
  assert.deepEqual(valueOf(unproven).steps.map((step) => step.symbol), ["run"]);
  for (const fact of [proven, nominal]) assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, file }) => [symbol, file]), [["save", B]]);
  assert.deepEqual(valueOf(external).steps.map(({ symbol, external }) => [symbol, external]), [["run", [{ kind: "import", module: "@ngrx/store", names: ["save"] }]]]);
});

test("a call the index resolved on a field or an inject() local whose origin holds a class is a step at its method, unless a provider may replace the class", async () => {
  const holds = { class: { path: B, symbol: "Repo", line: 1 } };
  const owner = { path: A, symbol: "Svc", line: 1 };
  const written = (name: string): SyntaxCall => ({ kind: "calls", line: 9, column: 5, name, callee: "save", owners: [] });
  const field = await factOf({ ...resolvedOnParameter(), receiverRoots: { save: { kind: "this", member: "store" } }, syntaxCalls: { [A]: [written("this.store.save")] }, proofs: { fields: [{ owner, field: "store", holds }], memberUses: [], externalUses: [] } });
  const local = await factOf({ ...resolvedOnParameter(), syntaxCalls: { [A]: [written("store.save")] }, proofs: { locals: [{ owner, local: "store", holds }], memberUses: [], externalUses: [] } });
  const replaceable = await factOf({ ...resolvedOnParameter(), syntaxCalls: { [A]: [written("store.save")] }, proofs: { locals: [{ owner, local: "store", holds }], memberUses: [{ ...SAVE_PROOF, reference: { ...SAVE_PROOF.reference, name: "store.save" }, substitutes: [] }], externalUses: [] } });

  for (const fact of [field, local]) {
    assert.equal(fact.status, "complete");
    assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, file, at }) => [symbol, file, at]), [["save", B, { line: 9, column: 5 }]]);
  }
  assert.deepEqual(cutsOf(replaceable), PARAMETER_CUT);
});

test("a member call on a value constructed from an imported class is a step at the method the nearest class above it declares", async () => {
  const fact = await factOf({
    ...boundCall({ kind: "constructed", name: "Child", line: 8, column: 17 }),
    nodes: [SVC, RUN, REPO, REPO_SAVE, fakeNode("Child", "class", B, 12, 20)],
    edges: [...CONTAINS, { from: "Repo", to: "Repo.save", kind: "contains" }, { from: "Child", to: "Repo", kind: "extends" }],
    imports: { [A]: [{ local: "Child", from: B }] },
  });

  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps.slice(1).map(({ symbol, file }) => [symbol, file]), [["save", B]]);
});

/** `this.make().save()` at line 9 of `run`: the index resolved both links, `make` to `Svc.make` and `save` to `Repo.save`. */
const resultCall = (holds: ReceiverBinding["holds"], returns?: string): Options => {
  const base = nominalCall();
  return {
    ...base,
    nodes: [...base.nodes, fakeNode("make", "method", A, 34, 36)],
    edges: [...base.edges!, { from: "Svc", to: "make", kind: "contains" }, call("run", "make", 9, 4)],
    unresolved: [...base.unresolved!, OUTWARD_CALL("make", A, 35)],
    receiverRoots: { save: { kind: "this", member: "make" }, make: { kind: "this", member: "make" } },
    receiverBindings: { [A]: [{ line: 9, column: 5, receiver: "", member: "save", holds }] },
    callables: { ...base.callables, [A]: [{ name: "make", start: 34, nameLine: 34, body: true, overridable: false, ...(returns === undefined ? {} : { returns: { kind: "annotated", type: returns, line: 34, column: 30 } }) }] },
  };
};
const MADE: ReceiverBinding["holds"] = { kind: "returned", name: "make", line: 9, column: 5 };

test("a call the index resolved on a call result is a step only when the call's declaration returns a nominal class, otherwise a cut", async () => {
  const nominal = await factOf(resultCall(MADE, "Repo"));
  const unstated = await factOf(resultCall(MADE));
  const other = await factOf(resultCall(MADE, "Promise"));
  const computed = await factOf(resultCall({ kind: "computed" }, "Repo"));

  assert.deepEqual(valueOf(nominal).steps.slice(1).map(({ symbol, file }) => [symbol, file]), [["make", A], ["save", B]]);
  for (const fact of [unstated, other, computed]) assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol), ["run", "make"]);
});

test("a call result proves nothing when its call is itself unproven, or when two calls under the member's name start at its place", async () => {
  const unprovenHead = await factOf({ ...resultCall(MADE, "Repo"), receiverRoots: { save: { kind: "this", member: "make" }, make: { kind: "local", root: "factory", lines: [5] } } });
  const twice = await factOf({ ...resultCall(MADE, "Repo"), receiverBindings: { [A]: [{ line: 9, column: 5, receiver: "", member: "save", holds: MADE }, { line: 9, column: 5, receiver: "", member: "save", holds: MADE }] } });

  for (const fact of [unprovenHead, twice]) assert.deepEqual(valueOf(fact).steps.map((step) => step.symbol).filter((symbol) => symbol === "save"), []);
});

const site = (line: number, overrides: Partial<CallSite> = {}): CallSite => ({
  repo: "shop",
  file: A,
  line,
  symbol: "Svc.run",
  transport: "http",
  target: { status: "complete", value: { method: "POST", path: "/orders/{}/checkout" }, evidence: [{ path: A, line }] },
  ...overrides,
});

/** The traced file as the snapshot holds it, so its syntax states no function value. */
const HELD_A = [{ path: A, content: "" }];

const EFFECTS_BODY: Options = {
  sources: HELD_A,
  nodes: [SVC, RUN, callee("helper"), callee("publish", A, 34)],
  edges: [...CONTAINS, call("run", "helper", 8, 4), call("run", "publish", 9, 4)],
};

test("a call site the extraction resolves at a call of an expanded body is an effect of that step, with its kind and target", async () => {
  const published: CallSite = site(9, { transport: "event", target: { status: "complete", value: { protocol: "nats", destination: "orders.created", role: "publish" }, evidence: [{ path: A, line: 9 }] } });

  const fact = await factOf({ ...EFFECTS_BODY, callSites: [site(8), published] });

  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps[0]!.effects, [
    { kind: "http", line: 8, column: 1, target: { method: "POST", path: "/orders/{}/checkout" } },
    { kind: "message", line: 9, column: 1, target: { protocol: "nats", destination: "orders.created", role: "publish" } },
  ]);
});

test("a call site whose target the extraction does not decide is an unresolved-link cut at its place naming the library, never an effect", async () => {
  const unknown = site(8, { target: { status: "unknown", reason: "unresolved", evidence: [{ path: A, line: 8, via: "com.acme.rest.RestClient" }] } });

  const fact = await factOf({ ...EFFECTS_BODY, callSites: [unknown] });

  assert.equal(valueOf(fact).steps[0]!.effects, undefined);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:8 http effect through com.acme.rest.RestClient"]]]);
});

test("a call site inside a declaration the walk did not expand is no effect of the step around it", async () => {
  const fact = await factOf({ ...EFFECTS_BODY, nodes: [...EFFECTS_BODY.nodes, fakeNode("later", "function", A, 12, 14)], callSites: [site(13)] });

  assert.equal(fact.status, "complete");
  assert.deepEqual(valueOf(fact).steps.map((step) => step.effects), [undefined]);
});

test("a call site in an expanded body at no call place the index records is a cut at the site, never dropped", async () => {
  const fact = await factOf({ ...EFFECTS_BODY, callSites: [site(15)] });

  assert.equal(valueOf(fact).steps[0]!.effects, undefined);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:15 http effect"]]]);
});

test("a call site at a call the body writes that the index records nothing of is an effect of that step", async () => {
  const written: SyntaxCall[] = [8, 9, 15].map((line) => ({ kind: "calls", line, column: 5, name: line === 15 ? "http.post" : line === 8 ? "helper" : "publish", owners: [] }));

  const fact = await factOf({ ...EFFECTS_BODY, syntaxCalls: { [A]: written }, placedSites: [{ site: site(15), column: 4 }] });

  assert.deepEqual(valueOf(fact).steps[0]!.effects?.map((effect) => effect.line), [15]);
});

test("an effect is carried once, by the step that expanded its body, never by a seen occurrence", async () => {
  const nodes = [SVC, RUN, callee("helper"), callee("wrap", A, 34)];
  const edges = [...CONTAINS, call("run", "wrap", 8, 4), call("run", "wrap", 9, 4), call("wrap", "helper", 35, 4)];

  const fact = await factOf({ nodes, edges, sources: HELD_A, callSites: [site(35, { symbol: "wrap" })] });

  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.seen ?? null, step.effects?.length ?? 0]), [["run", null, 0], ["wrap", null, 1], ["wrap", 1, 0]]);
});

test("the call sites are read once per query, however many bodies the walk expands", async () => {
  let reads = 0;
  await factOf({ ...EFFECTS_BODY, callSites: [site(8)], onCallSites: () => (reads += 1) });
  assert.equal(reads, 1);
});

test("a body whose only record at a call site is an edge the walk does not follow stays a step carrying its effect, never folded away", async () => {
  const nodes = [SVC, RUN, callee("helper")];
  const edges = [...CONTAINS, call("run", "helper", 8, 4), { from: "helper", to: "Svc", kind: "references", line: 31, column: 2 }];

  const written: SyntaxCall[] = [{ kind: "calls", line: 8, column: 5, name: "helper", callee: "helper", owners: [] }, { kind: "calls", line: 31, column: 1, name: "http.post", callee: "post", owners: [] }];

  const fact = await factOf({ nodes, edges, sources: HELD_A, syntaxCalls: { [A]: written }, callSites: [site(31, { symbol: "helper" })] });

  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.effects?.map((effect) => effect.line)]), [["run", undefined], ["helper", [31]]]);
});

/** `Api` on lines 3-30 of A: methods placed by line and exact columns, as the index places them. */
const PLACED_API = fakeNode("Api", "class", A, 3, 30);
const valueSpan = (line: number, start: number, end: number, endLine = line): SourceSpan => ({ start: { line, column: start }, end: { line: endLine, column: end } });
const placedNode = (id: string, kind: string, start: number, startColumn: number, end: number, endColumn: number, name = id): FakeNode => ({ ...fakeNode(id, kind, A, start, end, name), startColumn, endColumn });
const globalCall = (from: string, line: number, column: number): FakeUnresolved => ({ from, name: "Math.max", kind: "calls", file: A, line, column });
const MATH = { max: { kind: "ambient" as const, name: "Math" } };
const at = (line: number, column: number, path = "/x", overrides: Partial<CallSite> = {}): PlacedCallSite => ({
  site: site(line, { target: { status: "complete", value: { method: "GET", path }, evidence: [{ path: A, line }] }, ...overrides }),
  column,
});
const effectPaths = (fact: Fact<TraceValue>) => valueOf(fact).steps.flatMap((step) => (step.effects ?? []).map((effect) => [step.symbol, effect.kind === "http" ? effect.target.path : effect.kind === "message" ? effect.target.destination : effect.target?.name]));
const effectCuts = (fact: Fact<TraceValue>) => cutsOf(fact).filter(([, at]) => (at as readonly string[])[0]!.includes(" effect"));

test("a call site in a function the walk did not expand is neither an effect nor a cut of the body around it, even on a line that body calls on", async () => {
  const nodes = [PLACED_API, placedNode("run", "method", 6, 1, 6, 71), placedNode("dead", "function", 6, 22, 6, 50)];
  const edges = [{ from: "Api", to: "run", kind: "contains" }];

  const fact = await factOf({ nodes, edges, unresolved: [globalCall("run", 6, 52)], roots: MATH, placedSites: [at(6, 34, "/dead")] }, [{ file: A, symbol: "run" }]);

  assert.equal(fact.status, "complete");
  assert.deepEqual(effectPaths(fact), []);
});

test("each shape's call sites are effects of the body that owns their exact place, and only of it", async () => {
  const method = (id: string, start: number, startColumn: number, end: number, endColumn: number, kind = "method") => placedNode(id, kind, start, startColumn, end, endColumn);
  const member = (id: string) => ({ from: "Api", to: id, kind: "contains" });
  const nonAscii = "  run() { log('é'); const f = () => get('/f') }";
  const nonAsciiAfter = "  run() { get('/r'); log('é') }";
  const rows: { shape: string; options: Options; target: string; effects: (readonly string[])[]; cuts: readonly string[] }[] = [
    { shape: "same-line methods", target: "b", effects: [["b", "/b"]], cuts: [],
      options: { nodes: [PLACED_API, method("a", 5, 1, 5, 29), method("b", 5, 30, 5, 58)], edges: [member("a"), member("b")], unresolved: [globalCall("a", 5, 7), globalCall("b", 5, 36)], placedSites: [at(5, 7, "/a"), at(5, 36, "/b")] } },
    { shape: "an arrow function the body calls", target: "run", effects: [["dead", "/dead"]], cuts: [],
      options: { nodes: [PLACED_API, method("run", 6, 1, 6, 71), method("dead", 6, 22, 6, 50, "function")], edges: [member("run"), call("run", "dead", 6, 52)], unresolved: [globalCall("dead", 6, 34)], placedSites: [at(6, 34, "/dead")] } },
    { shape: "a lambda or callback passed and invoked, which the index holds as no declaration", target: "run", effects: [], cuts: ["src/a.ts:6 http effect"],
      options: { nodes: [PLACED_API, method("run", 6, 1, 6, 71)], edges: [member("run")], unresolved: [globalCall("run", 6, 40)], functionValues: { [A]: [valueSpan(6, 30, 60)] }, placedSites: [at(6, 40, "/cb")] } },
    { shape: "an immediately invoked function, whose run the walk does not prove", target: "run", effects: [], cuts: ["src/a.ts:7 http effect"],
      options: { nodes: [PLACED_API, method("run", 6, 1, 8, 2)], edges: [member("run")], unresolved: [globalCall("run", 7, 10)], functionValues: { [A]: [valueSpan(6, 12, 1, 8)] }, placedSites: [at(7, 10, "/iife")] } },
    { shape: "a class field initializer", target: "field", effects: [["field", "/field"]], cuts: [],
      options: { nodes: [PLACED_API, method("field", 4, 1, 4, 34, "property"), method("run", 6, 1, 6, 30)], edges: [member("field"), member("run")], unresolved: [globalCall("field", 4, 16), globalCall("run", 6, 10)], placedSites: [at(4, 16, "/field"), at(6, 10, "/run")] } },
    { shape: "a call spread over several lines", target: "run", effects: [["run", "/multi"]], cuts: [],
      options: { nodes: [PLACED_API, method("run", 8, 1, 11, 2)], edges: [member("run")], unresolved: [globalCall("run", 9, 4)], placedSites: [{ ...at(9, 4, "/multi"), site: { ...at(9, 4, "/multi").site, endLine: 10 } }] } },
    { shape: "a request through a wrapper, at the caller that names the path", target: "checkout", effects: [["checkout", "/orders/checkout"]], cuts: [],
      options: { nodes: [PLACED_API, method("checkout", 9, 1, 9, 60), method("post", 12, 1, 14, 2)], edges: [member("checkout"), member("post"), call("checkout", "post", 9, 20), call("post", "Api", 13, 4, { kind: "references" })], placedSites: [at(9, 13, "/orders/checkout")] } },
    { shape: "a client method a declaration states", target: "fetch", effects: [["fetch", "/stock"]], cuts: [],
      options: { nodes: [PLACED_API, method("fetch", 5, 1, 6, 30)], edges: [member("fetch"), call("fetch", "Api", 6, 2, { kind: "references" })], placedSites: [{ ...at(5, 1, "/stock"), declaration: true }] } },
    { shape: "a site with no column, inside the expanded body", target: "run", effects: [], cuts: ["src/a.ts:6 http effect"],
      options: { nodes: [PLACED_API, method("run", 6, 1, 6, 71)], edges: [member("run")], unresolved: [globalCall("run", 6, 10)], placedSites: [{ site: at(6, 40, "/x").site }] } },
    { shape: "a site past its line's first character outside ASCII, where parsers may count columns apart", target: "run", effects: [], cuts: ["src/a.ts:5 http effect"],
      options: { nodes: [PLACED_API, method("run", 5, 2, 5, 48), method("f", 5, 33, 5, 47, "function")], edges: [member("run")], unresolved: [globalCall("run", 5, 11)], sources: [{ path: A, content: `${"\n".repeat(4)}${nonAscii}\n` }], placedSites: [at(5, 37, "/f")] } },
    { shape: "a line whose first character outside ASCII lies after the site", target: "run", effects: [["run", "/r"]], cuts: [],
      options: { nodes: [PLACED_API, method("run", 5, 2, 5, 32)], edges: [member("run")], unresolved: [globalCall("run", 5, 10)], sources: [{ path: A, content: `${"\n".repeat(4)}${nonAsciiAfter}\n` }], placedSites: [at(5, 10, "/r")] } },
  ];
  for (const { shape, options, target, effects, cuts } of rows) {
    const fact = await factOf({ roots: MATH, sources: HELD_A, ...options }, [{ file: A, symbol: target }]);
    assert.deepEqual(effectPaths(fact), effects, shape);
    assert.deepEqual(effectCuts(fact).map(([, at]) => (at as readonly string[])[0]), cuts, shape);
  }
});


test("each function-value shape keeps its call sites from the body around it unless the index declares the value and the walk expands it", async () => {
  const run = placedNode("run", "method", 6, 1, 9, 2);
  const member = { from: "Api", to: "run", kind: "contains" };
  const rows: { shape: string; options: Options; effects: (readonly string[])[]; cuts: readonly string[] }[] = [
    { shape: "an arrow assigned and never called", effects: [], cuts: ["src/a.ts:7 http effect"],
      options: { nodes: [PLACED_API, run], functionValues: { [A]: [valueSpan(7, 15, 45)] }, placedSites: [at(7, 21, "/arrow")] } },
    { shape: "a callback passed to a function nothing places", effects: [], cuts: ["src/a.ts:7 http effect"],
      options: { nodes: [PLACED_API, run], functionValues: { [A]: [valueSpan(7, 14, 40)] }, placedSites: [at(7, 20, "/callback")] } },
    { shape: "an anonymous class body", effects: [], cuts: ["src/a.ts:8 http effect"],
      options: { nodes: [PLACED_API, run], functionValues: { [A]: [valueSpan(7, 30, 2, 9)] }, placedSites: [at(8, 6, "/anonymous")] } },
    { shape: "a method reference", effects: [], cuts: ["src/a.ts:7 http effect"],
      options: { nodes: [PLACED_API, run], functionValues: { [A]: [valueSpan(7, 20, 33)] }, placedSites: [at(7, 20, "/reference")] } },
    { shape: "a body whose source the snapshot does not hold, so no function value can be told apart", effects: [], cuts: ["src/a.ts:7 http effect"],
      options: { nodes: [PLACED_API, run], sources: [], placedSites: [at(7, 21, "/plain")] } },
    { shape: "a function value the index declares and the walk expands", effects: [["dead", "/dead"]], cuts: [],
      options: { nodes: [PLACED_API, run, placedNode("dead", "function", 7, 22, 7, 50)], edges: [call("run", "dead", 8, 4)], unresolved: [globalCall("dead", 7, 28)], functionValues: { [A]: [valueSpan(7, 22, 50)] }, placedSites: [at(7, 28, "/dead")] } },
  ];
  for (const { shape, options, effects, cuts } of rows) {
    const fact = await factOf({ roots: MATH, sources: HELD_A, ...options, edges: [member, ...(options.edges ?? [])], unresolved: [globalCall("run", 7, 21), ...(options.unresolved ?? [])] }, [{ file: A, symbol: "run" }]);
    assert.deepEqual(effectPaths(fact), effects, shape);
    assert.deepEqual(effectCuts(fact).map(([, at]) => (at as readonly string[])[0]), cuts, shape);
  }
});

test("a line-only call record settles a unique site and, with more than one on its line, is kept as the index has it, never cut", async () => {
  const nodes = [
    { ...fakeNode("run", "function", A, 1), startColumn: 0, endColumn: 80 },
    { ...fakeNode("target", "function", B, 5), startColumn: 0, endColumn: 30 },
  ];
  const first: SyntaxCall = { kind: "calls", line: 1, column: 10, name: "target", callee: "target", owners: [] };
  for (const sites of [[first], [first, { ...first, column: 30 }]]) {
    const fact = await factOf({ nodes, sources: [{ path: A, content: "run" }, { path: B, content: "target" }], edges: [{ from: "run", to: "target", kind: "calls", line: 1 }], syntaxCalls: { [A]: sites } });
    assert.equal(fact.status, "complete");
    assert.deepEqual(valueOf(fact).steps.flatMap((step) => step.leaves ?? []).map((leaf) => leaf.symbol), ["target"]);
  }
});

test("trace follows a synthesized call edge its source does not write and cuts a contradicted record once, at its place", async () => {
  const nodes = [
    { ...fakeNode("run", "function", A, 1, 4), startColumn: 0, endColumn: 80 },
    { ...fakeNode("handler", "function", B, 5), startColumn: 0, endColumn: 30 },
    { ...fakeNode("beta", "function", B, 7), startColumn: 0, endColumn: 30 },
  ];
  const edges = [{ from: "run", to: "handler", kind: "calls" as const, line: 2, column: 2, synthesizedBy: "mybatis-java-xml" }, { from: "run", to: "beta", kind: "calls" as const, line: 3, column: 2 }];
  const alpha: SyntaxCall = { kind: "calls", line: 3, column: 3, name: "alpha", callee: "alpha", owners: [] };
  const fact = await factOf({ nodes, sources: [{ path: A, content: "run" }, { path: B, content: "handler" }], edges, syntaxCalls: { [A]: [alpha] } });
  assert.deepEqual(valueOf(fact).steps.flatMap((step) => step.leaves ?? []).map((leaf) => leaf.symbol), ["handler"]);
  assert.deepEqual(cutsOf(fact), [["unresolved-link", ["src/a.ts:3 alpha"]], ["unresolved-link", ["src/a.ts:3 beta", "src/b.ts::beta"]]]);
  assert.deepEqual(reasonsOf(fact), [["src/a.ts:3 alpha", "callee-unknown"], ["src/a.ts:3 beta", "contradicted"]]);
});

test("a call record in a source no reader parsed is kept as the index has it, while a parsed source writing no call cuts it", async () => {
  const nodes = [
    { ...fakeNode("run", "function", A, 1), startColumn: 0, endColumn: 80 },
    { ...fakeNode("target", "function", B, 5), startColumn: 0, endColumn: 30 },
  ];
  const edges = [{ from: "run", to: "target", kind: "calls" as const, line: 1, column: 9 }];
  const sources = [{ path: A, content: "run" }, { path: B, content: "target" }];
  const leavesOf = (fact: Awaited<ReturnType<typeof factOf>>) => valueOf(fact).steps.flatMap((step) => step.leaves ?? []).map((leaf) => leaf.symbol);

  const unread = await factOf({ nodes, sources, edges });
  assert.equal(unread.status, "complete");
  assert.deepEqual(leavesOf(unread), ["target"]);

  const writesNone = await factOf({ nodes, sources, edges, syntaxCalls: { [A]: [] } });
  assert.equal(writesNone.status, "partial");
  assert.deepEqual(leavesOf(writesNone), []);
});

test("a workspace live trace forwards the root stale notice once and never substitutes a library notice", async () => {
  const fact = await factOf({ nodes: [SVC, RUN], edges: CONTAINS });
  const rootNotice = { stateId: "root-state", changed: [A] };
  const libraryNotice = { stateId: "library-state", changed: ["Library.java"] };
  const workspace = { withRead: async () => ({ ok: true, value: { value: fact, workspaceLive: [
    { kind: "stale", repo: "library", snapshot: { repo: "library", kind: "live", head: SHA, stateId: "library-state" }, notice: libraryNotice },
    { kind: "stale", repo: "shop", snapshot: { repo: "shop", kind: "live", head: SHA, stateId: "root-state" }, notice: rootNotice },
    { kind: "stale", repo: "shop", snapshot: { repo: "shop", kind: "live", head: SHA, stateId: "root-state" }, notice: rootNotice },
  ] } }) } as unknown as NonNullable<TraceQueriesDeps["workspace"]>;
  const notices: unknown[] = [];
  const { queries } = setup({ nodes: [], workspace });
  const result = await queries.walk({ repo: "/work/shop", repoId: "shop", live: true, workspace: {}, targets: [{ file: A, symbol: "run" }], onStale: notice => notices.push(notice) });
  assert.ok(result.ok);
  assert.deepEqual(notices, [rootNotice]);
});

test("a dispatch veto projects its fixed reason onto the existing cut as its sub-reason", async () => {
  const nodes = [SVC, RUN, fakeNode("Port", "interface", B, 1, 3), fakeNode("Port.send", "method", B, 2, 2, "send")];
  const edges: FakeEdge[] = [...CONTAINS, { from: "Port", to: "Port.send", kind: "contains" }, call("run", "Port.send", 8, 4)];
  for (const reason of ["aspect may replace the body", "generated implementation", "dispatch not proven"] as const) {
    const fact = await factOf({ nodes, edges, sources: [{ path: B, content: "" }], callables: { [B]: [{ name: "send", start: 2, nameLine: 2, body: false, overridable: true }] }, dispatch: { send: { kind: "unknown", reason } } });
    assert.equal(fact.status, "partial");
    assert.ok(fact.status === "partial" && fact.cuts.some((cut) => cut.kind === "unresolved-link" && cut.reason === "dispatch" && cut.subReason === reason));
  }
});

test("an unresolved Java this call uses the receiver proof before the own-member name shortcut", async () => {
  const file = "src/Svc.java";
  const save = fakeNode("save", "method", file, 25, 28);
  const fact = await factOf({
    nodes: [{ ...SVC, file }, { ...RUN, file }, save],
    edges: [...CONTAINS, { from: "Svc", to: "save", kind: "contains" }],
    unresolved: [{ from: "run", name: "this.save", kind: "calls", file, line: 9, column: 4 }],
    receivers: { save: { kind: "unproven" } },
  }, [{ file, symbol: "run" }]);
  assert.equal(fact.status, "partial");
  assert.deepEqual(valueOf(fact).steps.map((step) => [step.symbol, step.leaves ?? []]), [["run", []]]);
  assert.ok(cutsOf(fact).some(([kind]) => kind === "unresolved-link"));
});


test("effect deduplication preserves distinct call columns", async () => {
  const fact = await factOf({
    ...EFFECTS_BODY,
    placedSites: [at(8, 4), at(8, 4), at(8, 20)],
  });
  assert.deepEqual(valueOf(fact).steps[0]!.effects?.map((effect) => effect.column), [5, 21]);
});
