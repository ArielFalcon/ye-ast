import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotRef } from "../../domain/shared/fact.ts";
import type { CodeGraphReader, GraphNodeId } from "../../ports/code-graph.port.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";
import type { LibraryReading } from "../../ports/library-signatures.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import type { TypeBindingsAnswer } from "../../ports/type-bindings.port.ts";
import type { WorkspaceFault } from "../../ports/workspace-repos.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import { createBaseReadings } from "./base-reading.ts";
import type { EdgeTargets } from "../navigation/edge-targets.ts";
import { NOTHING_DECLARED } from "../navigation/edge-targets.ts";
import type { SourceReading } from "../../domain/change/source-tokens.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";

const SHA: SnapshotRef = { repo: "shop", kind: "sha", sha: "a".repeat(40) };
const LIVE: SnapshotRef = { repo: "shop", kind: "live", head: "h", stateId: "s" };
const OUTPUTS = [{ kind: "node-modules" as const, at: "", path: "/host/node_modules" }];
const SOURCES = [{ kind: "java-sources" as const, at: "target/generated-sources/openapi", path: "/host/generated" }];

function typedOf(snapshot: SnapshotRef, answer: TypeBindingsAnswer, inputs: "read" | "fault" = "read") {
  const checkerInputs: RevisionSources = {
    resolve: async () => ({ ok: true, value: SHA.kind === "sha" ? SHA.sha : "" }),
    filesAt: async () => (inputs === "read" ? { ok: true, value: { files: [], cuts: [] } } : { ok: false, fault: { kind: "unreadable" } as unknown as WorkspaceFault }),
  };
  const readings = createBaseReadings({ relations: {} as RelationExtractor, typeBindings: { of: async () => answer }, checkerInputs });
  const source = { tree: { export: { files: [], skipped: [] }, sources: [] }, prepared: undefined, store: {} as CodeGraphReader, snapshot, request: { repo: "/work/shop", buildOutputs: OUTPUTS } };
  return readings.of(source, {}).typed();
}

test("a declared generated-source directory never reaches the type bindings, and the node-modules declaration beside it does", async () => {
  const asked: (readonly { kind: string }[])[] = [];
  const checkerInputs: RevisionSources = {
    resolve: async () => ({ ok: true, value: "a".repeat(40) }),
    filesAt: async () => ({ ok: true, value: { files: [], cuts: [] } }),
  };
  const readings = createBaseReadings({
    relations: {} as RelationExtractor,
    typeBindings: { of: async (_sources, outputs) => { asked.push(outputs); return { status: "unused", outputs: [] }; } },
    checkerInputs,
  });
  const source = { tree: { export: { files: [], skipped: [] }, sources: [] }, prepared: undefined, store: {} as CodeGraphReader, snapshot: SHA, request: { repo: "/work/shop", buildOutputs: [...OUTPUTS, ...SOURCES] } };

  await readings.of(source, {}).typed();

  assert.deepEqual(asked, [OUTPUTS]);
});

test("a reading that declares only generated sources answers as one that declares none, and node-modules alone answers byte-identically", async () => {
  const asked: (readonly { kind: string }[])[] = [];
  const checkerInputs: RevisionSources = {
    resolve: async () => ({ ok: true, value: "a".repeat(40) }),
    filesAt: async () => ({ ok: true, value: { files: [], cuts: [] } }),
  };
  const answer: TypeBindingsAnswer = { status: "unused", outputs: [{ kind: "node-modules", at: "", stale: [{ path: "kit" } as never] }] };
  const readings = createBaseReadings({ relations: {} as RelationExtractor, typeBindings: { of: async (_sources, outputs) => (asked.push(outputs), answer) }, checkerInputs });
  const readOf = (buildOutputs: readonly { kind: "node-modules" | "java-sources"; at: string; path: string }[] | undefined) =>
    readings.of({ tree: { export: { files: [], skipped: [] }, sources: [] }, prepared: undefined, store: {} as CodeGraphReader, snapshot: SHA, request: { repo: "/work/shop", ...(buildOutputs === undefined ? {} : { buildOutputs }) } }, {}).typed();

  const none = await readOf(undefined);
  assert.deepEqual(none, { inputsLeftOut: [] });
  assert.deepEqual(await readOf(SOURCES), none);
  assert.deepEqual(asked, [], "a generated-sources-only declaration never reaches the checker");

  const nodeModules = await readOf(OUTPUTS);
  assert.deepEqual(await readOf([...OUTPUTS, ...SOURCES]), nodeModules);
  assert.deepEqual(asked, [OUTPUTS, OUTPUTS], "node-modules alone is asked of the checker exactly as before");
});

test("the typed reading answers evidence and builds no cut, whatever kept it from reading the declared outputs", async () => {
  const answers: [SnapshotRef, TypeBindingsAnswer, ("read" | "fault")?][] = [
    [LIVE, { status: "fault", fault: { kind: "checker-failed", detail: "x" } }],
    [SHA, { status: "fault", fault: { kind: "checker-failed", detail: "x" } }, "fault"],
    [SHA, { status: "unused", outputs: [{ kind: "node-modules", at: "", stale: [{ path: "kit" } as never] }] }],
    [SHA, { status: "fault", fault: { kind: "unreadable", outputs: [{ kind: "node-modules", at: "", paths: ["kit"] }] } }],
    [SHA, { status: "fault", fault: { kind: "checker-failed", detail: "x" } }],
    [SHA, { status: "bound", bindings: [], unowned: [], refused: ["node_modules/link"], outputs: [] }],
  ];
  for (const [snapshot, answer, inputs] of answers) {
    const reading = await typedOf(snapshot, answer, inputs);
    assert.ok(reading !== "aborted");
    assert.equal("cuts" in reading, false, JSON.stringify(reading));
  }
});

test("every reading redirects an edge by the module statements composition hands the line, without a family naming a reader", async () => {
  const store = fakeCodeGraph(
    [fakeNode("file-b", "file", "src/b.ts", 1, 3), fakeNode("run", "function", "src/a.ts", 2, 4), fakeNode("helper-a", "function", "src/a.ts", 6, 8, "helper"), fakeNode("helper-b", "function", "src/b.ts", 1, 3, "helper")],
    [{ from: "run", to: "helper-a", kind: "calls", line: 3, column: 2 }, { from: "file-b", to: "helper-b", kind: "contains" }],
  );
  const origins = () => ({ rootOrigins: async (sites: readonly unknown[]) => sites.map(() => ({ status: "complete", value: { kind: "repository", file: "src/b.ts" }, bare: true, evidence: [] })) }) as unknown as ImportOrigins;
  const modules: ModuleDependenciesReader = {
    extract: async () => ({ files: [], unread: [], dependencies: [{ file: "src/a.ts", line: 1, endLine: 1, specifier: "./b", kind: "import", typeOnly: false, target: { kind: "repository", file: "src/b.ts" }, bindings: [{ local: "helper", imported: "helper", line: 1, column: 10, typeOnly: false, exportedAs: "helper" }] }] }),
  };
  const readings = createBaseReadings({ relations: {} as RelationExtractor, importOrigins: origins, modules });
  const tree = { export: { files: [], skipped: [] }, sources: [{ path: "src/a.ts", content: "" }, { path: "src/b.ts", content: "" }] };
  const [run] = store.symbolsByIds(["run" as GraphNodeId]);
  const [edge] = store.outgoingEdges([run!.id], ["calls"]);

  const [verdict] = await readings.of({ tree, prepared: undefined, store, snapshot: SHA, request: { repo: "/work/shop" } }).edgeTargets()!.verdictsOf([{ edge: edge!, source: run!, target: store.symbolsByIds([edge!.target])[0]! }]);

  assert.deepEqual(verdict?.kind === "redirect" && verdict.to.file, "src/b.ts");
});

test("the calls through origins are derived once per index and relations' scope, and again for another index", async () => {
  const file = "src/cmp.ts";
  const graph = fakeCodeGraph([fakeNode("Owner", "class", file, 1, 20), fakeNode("caller", "method", file, 5, 9), fakeNode("list", "method", "src/svc.ts", 2, 4)], [{ from: "Owner", to: "caller", kind: "contains" }], [{ from: "caller", name: "this.svc.list", kind: "calls", file, line: 7, column: 4 }]);
  let reads = 0;
  const store: CodeGraphReader = { ...graph, unresolvedReferences: (files) => (reads++, graph.unresolvedReferences(files)) };
  const relations = { language: { reads: () => true }, extract: async () => ({ relations: [], fields: [{ owner: { path: file, symbol: "Owner", line: 1 }, field: "svc", holds: { class: { path: "src/svc.ts", symbol: "Svc", line: 1 } } }], locals: [], memberUses: [] }) } as unknown as RelationExtractor;
  const kept = new Map<string, unknown>();
  const retained = async <T>(slot: string, produce: () => Promise<T>): Promise<T> => (kept.has(slot) ? (kept.get(slot) as T) : (kept.set(slot, JSON.parse(JSON.stringify(await produce()))), kept.get(slot) as T));
  const asked: string[][] = [];
  const targets = { bindings: { boundCalls: async (calls: readonly { reference: { name: string } }[]) => (asked.push(calls.map(({ reference }) => reference.name)), calls.map(() => ({ kind: "unbound", form: "member", candidates: [], attributed: [] }))) } } as unknown as EdgeTargets;
  const readings = createBaseReadings({ relations });
  const [list] = store.symbolsInFiles(["src/svc.ts"]);
  const into = (digest: string, scope?: { exclude: string[] }) => readings.of({ tree: { export: { files: [], skipped: [] }, sources: [] }, prepared: { retained } as never, store, digest, snapshot: SHA, request: { repo: "/work/shop", ...(scope && { scope }) } }, {}).originCalls(targets)!.into([list!]);

  await into("index-1");
  await into("index-1");
  assert.equal(reads, 1);
  await into("index-2");
  await into("index-1", { exclude: ["gen/"] });
  assert.equal(reads, 3);
  assert.deepEqual(asked, [["this.svc.list"], ["this.svc.list"], ["this.svc.list"], ["this.svc.list"]]);
});

const EMPTY_TREE = { export: { files: [], skipped: [] }, sources: [] };

/** The content-keyed retention of one snapshot read, shared by two reads of the same source. */
function derivedFacts(): DerivedFacts {
  const kept = new Map<string, unknown>();
  return {
    ofFile: <T>(slot: string, file: { path: string; content: string }, derive: () => T): T => {
      const key = `${slot}:${file.path}:${file.content}`;
      if (!kept.has(key)) kept.set(key, derive());
      return kept.get(key) as T;
    },
    ofInputs: async <T>(slot: string, inputs: object, derive: () => Promise<T>): Promise<T> => {
      const key = `${slot}:${JSON.stringify(inputs)}`;
      if (!kept.has(key)) kept.set(key, await derive());
      return kept.get(key) as T;
    },
    fingerprint: () => "fingerprint",
    drain: () => ({ hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  } as DerivedFacts;
}

test("the tokens stage reads one file once per read and a second read retains it", async () => {
  let calls = 0;
  const reading: SourceReading = { status: "read", language: "typescript", tokens: [{ start: 1, end: 1, text: "const", startOffset: 0, endOffset: 0 }], imports: [], importOrder: "significant" };
  const tokens: SourceTokens = { tokensOf: async () => (calls++, reading) };
  const facts = derivedFacts();
  const readings = createBaseReadings({ relations: {} as RelationExtractor, tokens });
  const file = { path: "src/a.ts", content: "const a = 1;\n" };
  const prepared = { facts } as never;
  const source = { tree: EMPTY_TREE, prepared, store: {} as CodeGraphReader, snapshot: SHA, request: { repo: "/work/shop" } };

  const first = readings.of(source);
  assert.deepEqual(await first.tokensOf(file), reading);
  assert.deepEqual(await first.tokensOf(file), reading);
  assert.equal(calls, 1);

  const second = readings.of(source);
  assert.deepEqual(await second.tokensOf(file), reading);
  assert.deepEqual(await readings.tokensOf(file, prepared), reading);
  assert.equal(calls, 1);

  assert.deepEqual(await readings.tokensOf({ path: "src/b.ts", content: "const b = 2;\n" }, prepared), reading);
  assert.deepEqual(await readings.tokensOf(file, prepared), reading);
  assert.equal(calls, 2);
});

test("a file no pack tokenizes answers unread through both entry points", async () => {
  const tokens: SourceTokens = { tokensOf: async () => ({ status: "unread", reason: "no-language" }) };
  const readings = createBaseReadings({ relations: {} as RelationExtractor, tokens });
  const file = { path: "src/A.kt", content: "fun main() {}" };
  const prepared = { facts: derivedFacts() } as never;

  assert.deepEqual(await readings.tokensOf(file, prepared), { status: "unread", reason: "no-language" });
  assert.deepEqual(await readings.of({ tree: EMPTY_TREE, prepared, store: {} as CodeGraphReader, snapshot: SHA, request: { repo: "/work/shop" } }).tokensOf(file), { status: "unread", reason: "no-language" });
});

function rememberingFacts(): DerivedFacts {
  const kept = new Map<string, string>();
  return {
    ofFile: (_slot, _file, derive) => derive(),
    async ofInputs(slot, inputs, derive) {
      const key = JSON.stringify([slot, inputs]);
      if (!kept.has(key)) kept.set(key, JSON.stringify(await derive()));
      return JSON.parse(kept.get(key)!);
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
}

test("declarations and bindings share B1, and a changed file or index containment rebuilds only its model", async () => {
  const file = { path: "src/a.ts", content: "class A { run() {} }" };
  let reads = 0;
  const written = { name: "run", kind: "method" as const, invoked: true, span: { start: { line: 1, column: 10 }, end: { line: 1, column: 18 } }, container: { line: 1, column: 0 } };
  const memberNames = { memberNames: async () => (reads++, { ...NOTHING_DECLARED, declarations: [written], calls: [] }) };
  let derivations = 0;
  const retained = rememberingFacts();
  const facts: DerivedFacts = { ...retained, ofInputs: (slot, inputs, derive) => retained.ofInputs(slot, inputs, async () => (derivations++, derive())) };
  const graph = (contains: boolean) => fakeCodeGraph([
    fakeNode("file", "file", file.path, 1, 1),
    { ...fakeNode("A", "class", file.path, 1, 1), endColumn: 21 },
    { ...fakeNode("run", "method", file.path, 1, 1), startColumn: 10, endColumn: 18 },
  ], [{ from: "file", to: "A", kind: "contains" }, ...(contains ? [{ from: "A", to: "run", kind: "contains" }] : [])]);
  const readings = createBaseReadings({ relations: {} as RelationExtractor, memberNames, importOrigins: () => ({} as ImportOrigins) });
  const reading = (contains: boolean, content = file.content) => readings.of({ tree: { export: { files: [], skipped: [] }, sources: [{ ...file, content }] }, prepared: { facts } as never, store: graph(contains), snapshot: SHA, request: { repo: "/work/repo" } });
  const first = reading(true);
  const [[holder]] = await Promise.all([first.declarations.select(file.path, "A"), first.syntaxOf!(file.path)]);
  const target = await first.edgeTargets()!.binder!.memberOfDeclaration(holder!, "run", { file: "src/use.ts", line: 20, column: 1 });
  assert.equal(target?.path, "A.run");
  assert.equal(reads, 1);
  await reading(true).declarations.list(file.path);
  assert.equal(derivations, 1);
  assert.equal((await reading(false).declarations.select(file.path, "run"))[0]?.path, "A.run");
  assert.equal((await reading(true, "class A { run() {} }\n").declarations.select(file.path, "run"))[0]?.path, "A.run");
  assert.equal(derivations, 3);
});

test("a file's contradiction alignment is kept between readings by its content and index, and another index aligns again", async () => {
  const file = "src/b.ts";
  const graph = fakeCodeGraph([fakeNode("f", "function", "src/a.ts", 1, 3), fakeNode("g", "function", file, 1, 3)], [{ from: "g", to: "f", kind: "calls", line: 2, column: 4 }]);
  let reads = 0;
  const memberNames = { memberNames: async () => (reads++, { ...NOTHING_DECLARED, calls: [] }) };
  const facts = rememberingFacts();
  const readings = createBaseReadings({ relations: {} as RelationExtractor, memberNames });
  const targets = { importedDeclarations: async () => new Map() } as unknown as EdgeTargets;
  const [g] = graph.symbolsInFiles([file]);
  const read = (digest: string) => readings.of({ tree: { export: { files: [], skipped: [] }, sources: [{ path: file, content: "export function g(): void {\n  return;\n}\n" }] }, prepared: { facts } as never, store: graph, digest, snapshot: SHA, request: { repo: "/work/shop" } }, {}).contradictedCalls(targets)!;

  const found = await read("index-1")([g!]);
  const again = await read("index-1")([g!]);
  assert.deepEqual([...again.keys()], [...found.keys()]);
  assert.equal(reads, 1);
  await read("index-2")([g!]);
  assert.equal(reads, 2);
});

test("the Java pack receives the signatures of a declared JDK by path, and reads none when no JDK is declared", () => {
  const signatures = { basis: { version: "25", feature: 25, release: 25, basis: "declared-jdk", digest: "d" }, typeOf: () => undefined } as const;
  const received: (LibraryReading | undefined)[] = [];
  const readings = createBaseReadings({
    relations: {} as RelationExtractor,
    importOrigins: (_sources, _paths, _facts, _hold, _context, libraries) => (received.push(libraries), {} as ImportOrigins),
    libraries: { open: () => ({ kind: "used", signatures }) },
  });
  const readOf = (buildOutputs: readonly { kind: "jdk" | "node-modules"; at: string; path: string }[]) =>
    readings.of({ tree: { export: { files: [], skipped: [] }, sources: [] }, prepared: undefined, store: {} as CodeGraphReader, snapshot: SHA, request: { repo: "/work/shop", buildOutputs } }, {}).origins();

  readOf(OUTPUTS);
  readOf([{ kind: "jdk", at: "ms-orders", path: "/host/jdk" }]);

  assert.equal(received[0], undefined);
  assert.equal(received[1]?.of("ms-orders/src/Use.java"), signatures);
  assert.equal(received[1]?.of("ms-users/src/Use.java"), undefined);
});
