import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { SnapshotCacheEvent } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { Result } from "../core/domain/shared/result.ts";
import { INDEX_STORE_DIRECTORY, type CodeGraph } from "../core/ports/code-graph.port.ts";
import type { ContractConsequencesQueries } from "../core/ports/contract-consequences-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { TraceQueries } from "../core/ports/trace-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { IndexDiscard } from "../core/ports/index-cache.port.ts";
import type { LiveMirror } from "../core/ports/live-mirror.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";

/** Receives one measurement line, already redacted, one per call. */
export type MeasurementSink = (line: string) => void;

export interface MeasurementDeps {
  sink: MeasurementSink;
  redaction: Redaction;
  /** Where tallied stages sum their calls until the query they ran in writes its line. */
  tallies?: StageTallies;
}

/** The calls of each tallied stage since the last query line: how many, their summed time, and the first outcome not `ok`. */
export type StageTallies = Map<string, { calls: number; durationMs: number; outcome: string }>;

export function stageTallies(): StageTallies {
  return new Map();
}

/**
 * The query families of the entrypoints, measured. The core decides facts and reads no clock; the adapter that hosts
 * the call is what learns how long it took.
 */
export function measuredEntrypoints(queries: EntrypointQueries, deps: MeasurementDeps): EntrypointQueries {
  return { map: (request) => measured("map", () => queries.map(request), deps) };
}

export function measuredImpact(queries: ImpactQueries, deps: MeasurementDeps): ImpactQueries {
  return {
    ofChange: (request) => measured("impact.ofChange", () => queries.ofChange(request), deps),
    callers: (request) => measured("impact.callers", () => queries.callers(request), deps),
    importers: (request) => measured("impact.importers", () => queries.importers(request), deps),
  };
}

/** The index side of the graph, measured: a build is the one expensive event a session can hide. */
export function measuredOutline(queries: OutlineQueries, deps: MeasurementDeps): OutlineQueries {
  return { outline: (request) => measured("outline", () => queries.outline(request), deps) };
}

export function measuredTrace(queries: TraceQueries, deps: MeasurementDeps): TraceQueries {
  return { walk: (request) => measured("trace.walk", () => queries.walk(request), deps) };
}

export function measuredWorkspace(queries: WorkspaceQueries, deps: MeasurementDeps): WorkspaceQueries {
  return { outwardNames: (request) => measured("workspace.outwardNames", () => queries.outwardNames(request), deps) };
}

export function measuredContractConsequences(queries: ContractConsequencesQueries, deps: MeasurementDeps): ContractConsequencesQueries {
  return {
    ofHypotheses: (request) => measured("contractConsequences.ofHypotheses", () => queries.ofHypotheses(request), deps),
    ofChange: (request) => measured("contractConsequences.ofChange", () => queries.ofChange(request), deps),
  };
}

export function measuredDecisions(queries: DecisionQueries, deps: MeasurementDeps): DecisionQueries {
  return { decisions: (request) => measured("decisions.decisions", () => queries.decisions(request), deps) };
}

/** The index side of the graph, measured: a build is the one expensive event a session can hide. */
export function measuredGraph(graph: CodeGraph, deps: MeasurementDeps): CodeGraph {
  return {
    index: (snapshot, store, signal) => measuredBuild("built", () => graph.index(snapshot, store, signal), store, deps),
    open: (store) => {
      const opened = measuredStage("store-open", () => graph.open(store), deps);
      return opened.ok ? { ok: true, value: measuredStages(opened.value, { unresolvedReferences: "unresolved-references" }, deps) } : opened;
    },
    buildMirror: (mirror, signal) => measuredBuild("built", () => graph.buildMirror(mirror, signal), join(mirror, INDEX_STORE_DIRECTORY), deps),
    syncMirror: (mirror, paths, signal) => measuredBuild("synced", () => graph.syncMirror(mirror, paths, signal), join(mirror, INDEX_STORE_DIRECTORY), deps),
  };
}

/** The lifecycle steps of a live query: each port call `openLive` makes is a stage, so the time around the export is attributed. */
export function measuredLiveMirror(mirror: LiveMirror, deps: MeasurementDeps): LiveMirror {
  const stages = measuredStages(mirror, {
    readState: "live-read-state",
    writeState: "live-write-state",
    discard: "live-discard",
    reconcile: "live-reconcile",
    changedSince: "live-staleness-compare",
    materialize: "live-materialize",
    prune: "live-prune",
    touch: "live-touch",
    usage: "live-usage",
    discardIfIdle: "live-discard-idle",
    discardDebris: "live-discard-debris",
  }, deps);
  Object.defineProperty(stages, "lock", {
    value: async (...args: Parameters<LiveMirror["lock"]>) => {
      const lock = await measuredStage("live-lock", () => mirror.lock(...args), deps);
      return lock.ok ? { ok: true as const, value: { release: () => measuredStage("live-release", () => lock.value.release(), deps) } } : lock;
    },
  });
  return stages;
}

/** The snapshot data cache's decisions, one `cache` line each; the key never leaves the cache. */
export function measuredSnapshotCache(deps: MeasurementDeps): (event: SnapshotCacheEvent) => void {
  return ({ outcome, entryBytes, retainedBytes }) => {
    reportBestEffort({ event: "cache", outcome, ...(entryBytes === undefined ? {} : { entry_bytes: entryBytes }), retained_bytes: retainedBytes, start_ms: Math.round(performance.now()) }, deps);
  };
}

/** The discards of the kept-index cache's retention, one `index-cache` line each; the key never leaves the cache. */
export function measuredIndexDiscard(deps: MeasurementDeps): (discard: IndexDiscard) => void {
  return ({ entryBytes, retainedBytes }) => {
    reportBestEffort({ event: "index-cache", outcome: "discarded", entry_bytes: entryBytes, retained_bytes: retainedBytes, start_ms: Math.round(performance.now()) }, deps);
  };
}

/** `port` with each of `methods` called through `around`; the other methods are the port's own. */
function aroundMethods<T extends object>(port: T, methods: readonly string[], around: (method: string, call: () => unknown) => unknown): T {
  const wrapped: T = Object.create(port);
  for (const method of methods) {
    const call = port[method as keyof T];
    if (typeof call !== "function") continue;
    Object.defineProperty(wrapped, method, { value: (...args: unknown[]) => around(method, () => call.apply(port, args)) });
  }
  return wrapped;
}

/**
 * A port whose named methods each write one stage line: the readers a request runs over the whole snapshot, so a host
 * can tell which of them its time went to. Lines carry no request id; under concurrent requests they interleave.
 */
export function measuredStages<T extends object>(port: T, stages: { readonly [K in keyof T]?: string }, deps: MeasurementDeps): T {
  return aroundMethods(port, Object.keys(stages), (method, call) => measuredStage(stages[method as keyof T]!, call, deps));
}

/**
 * A port whose named methods a request calls once per file: without `tallies` each call writes its stage line; with it
 * the calls are summed, and the query they ran in writes one line per stage before its own.
 */
export function measuredTalliedStages<T extends object>(port: T, stages: { readonly [K in keyof T]?: string }, deps: MeasurementDeps): T {
  const { tallies } = deps;
  if (tallies === undefined) return measuredStages(port, stages, deps);
  return aroundMethods(port, Object.keys(stages), (method, call) =>
    timedStage(call, (outcome, started) => {
      const stage = stages[method as keyof T]!;
      const held = tallies.get(stage) ?? { calls: 0, durationMs: 0, outcome: "ok" };
      tallies.set(stage, { calls: held.calls + 1, durationMs: held.durationMs + performance.now() - started, outcome: held.outcome === "ok" ? outcome : held.outcome });
    }),
  );
}

function reportTallies(deps: MeasurementDeps): void {
  for (const [stage, { calls, durationMs, outcome }] of deps.tallies ?? []) reportBestEffort({ event: "stage", stage, outcome, calls, duration_ms: Math.round(durationMs) }, deps);
  deps.tallies?.clear();
}

/** One `derived-facts` line per call of `reader` that found or derived a fact (ADR-0035): what it kept, and what the cache holds after. */
export function measuredDerivedFacts<T extends object>(port: T, facts: DerivedFacts, reader: string, deps: MeasurementDeps): T {
  return aroundMethods(port, Object.keys(port), async (_, call) => {
    try {
      return await call();
    } finally {
      const tally = facts.drain();
      if (tally.hits + tally.misses > 0) reportBestEffort({ event: "derived-facts", reader, hits: tally.hits, misses: tally.misses, admitted: tally.admitted, admitted_bytes: tally.admittedBytes, evicted: tally.evicted, skipped: tally.skipped, fact_bytes: tally.factBytes, retained_bytes: tally.retainedBytes }, deps);
    }
  });
}

/** One stage line per call, synchronous or not: `ok`, `threw`, or the kind of the fault a result answered. */
function measuredStage<T>(stage: string, call: () => T, deps: MeasurementDeps): T {
  return timedStage(call, (outcome, started) => reportBestEffort({ event: "stage", stage, outcome, start_ms: Math.round(started), duration_ms: elapsed(started) }, deps));
}

/** Runs `call` and hands `done` its outcome once it settles, synchronous or not, with the time it started. */
function timedStage<T>(call: () => T, settled: (outcome: string, started: number) => void): T {
  const started = performance.now();
  const done = (outcome: string) => settled(outcome, started);
  let answer: T;
  try {
    answer = call();
  } catch (error) {
    done("threw");
    throw error;
  }
  if (answer instanceof Promise) {
    return answer.then((value: unknown) => { done(outcomeOf(value)); return value; }, (error: unknown) => { done("threw"); throw error; }) as T;
  }
  done(outcomeOf(answer));
  return answer;
}

/** One index line per build or sync: `built` or `synced` only when a store came out of it, the fault's own kind otherwise. */
async function measuredBuild<T, F extends { kind: string }>(succeeded: "built" | "synced", call: () => Promise<Result<T, F>>, store: string, deps: MeasurementDeps): Promise<Result<T, F>> {
  const started = performance.now();
  try {
    const result = await call();
    const buildMs = elapsed(started);
    const storeBytes = result.ok ? await bytesOf(store) : 0;
    reportBestEffort({ event: "index", outcome: result.ok ? succeeded : result.fault.kind, build_ms: buildMs, store_bytes: storeBytes }, deps);
    return result;
  } catch (error) {
    reportBestEffort({ event: "index", outcome: "threw", build_ms: elapsed(started) }, deps);
    throw error;
  }
}

interface Measured {
  method: string;
  durationMs: number;
  outcome: string;
  answer: unknown;
  cpu: NodeJS.CpuUsage;
}

async function measured<T>(method: string, call: () => Promise<T>, deps: MeasurementDeps): Promise<T> {
  const started = performance.now();
  const cpuAtStart = process.cpuUsage();
  try {
    const answer = await call();
    reportTallies(deps);
    reportBestEffort(queryRecord({ method, durationMs: elapsed(started), outcome: outcomeOf(answer), answer, cpu: process.cpuUsage(cpuAtStart) }), deps);
    return answer;
  } catch (error) {
    reportTallies(deps);
    reportBestEffort({ event: "query", method, duration_ms: elapsed(started), outcome: "threw" }, deps);
    throw error;
  }
}

function queryRecord({ method, durationMs, outcome, answer, cpu }: Measured): Record<string, unknown> {
  const memory = process.memoryUsage();
  const record: Record<string, unknown> = {
    event: "query",
    method,
    duration_ms: durationMs,
    outcome,
    bytes: bytesOfAnswer(answer),
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal,
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
  };
  const fact = factOf(answer);
  if (fact === undefined) return record;
  record.status = fact.status;
  record.schema = fact.schema;
  if (fact.trust !== undefined) record.trust = fact.trust;
  if (fact.snapshot !== undefined) record.snapshot = fact.snapshot;
  if (fact.cutKinds !== undefined) record.cut_kinds = fact.cutKinds;
  if (fact.reason !== undefined) record.reason = fact.reason;
  return record;
}

interface MeasuredFact {
  status: string;
  schema: string;
  trust?: string;
  snapshot?: { kind: string; value: string };
  /** Present only when it is non-empty: the kinds that made the fact partial. */
  cutKinds?: string[];
  /** Present only on an `unknown` fact: why the engine could not answer. */
  reason?: string;
}

/** The fact an answer carries, if it carries one; the repository id stays out, so a line never names a repository. */
function factOf(answer: unknown): MeasuredFact | undefined {
  if (typeof answer !== "object" || answer === null || !("ok" in answer) || answer.ok !== true) return undefined;
  const value = (answer as { value?: unknown }).value;
  if (typeof value !== "object" || value === null) return undefined;
  const fact = value as { status?: unknown; schema?: unknown; cuts?: unknown; reason?: unknown; snapshot?: unknown; inputs?: unknown };
  if (typeof fact.status !== "string" || typeof fact.schema !== "string") return undefined;
  const snapshot = snapshotOf(fact.snapshot);
  const trust = trustOf(fact.inputs);
  const cutKinds = cutKindsOf(fact.cuts);
  const reason = typeof fact.reason === "string" ? fact.reason : undefined;
  return {
    status: fact.status,
    schema: fact.schema,
    ...(trust === undefined ? {} : { trust }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(cutKinds === undefined ? {} : { cutKinds }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function trustOf(inputs: unknown): string | undefined {
  if (typeof inputs !== "object" || inputs === null) return undefined;
  const trust = (inputs as { trust?: unknown }).trust;
  return typeof trust === "string" ? trust : undefined;
}

/** The distinct kinds that cut the fact, sorted; `undefined` when nothing cut it, so the field means "this is why partial". */
function cutKindsOf(cuts: unknown): string[] | undefined {
  if (!Array.isArray(cuts)) return undefined;
  const kinds = cuts.flatMap((cut) => (typeof cut === "object" && cut !== null && typeof (cut as { kind?: unknown }).kind === "string" ? [(cut as { kind: string }).kind] : []));
  const distinct = [...new Set(kinds)].sort();
  return distinct.length === 0 ? undefined : distinct;
}

function snapshotOf(snapshot: unknown): { kind: string; value: string } | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const { kind, sha, stateId } = snapshot as { kind?: unknown; sha?: unknown; stateId?: unknown };
  if (typeof kind !== "string") return undefined;
  const value = typeof sha === "string" ? sha : typeof stateId === "string" ? stateId : undefined;
  return value === undefined ? undefined : { kind, value };
}

function outcomeOf(answer: unknown): string {
  if (typeof answer === "object" && answer !== null && "ok" in answer && answer.ok === false) {
    const fault = (answer as { fault?: { kind?: unknown } }).fault;
    if (typeof fault?.kind === "string") return fault.kind;
  }
  return "ok";
}

function bytesOfAnswer(answer: unknown): number {
  try {
    return JSON.stringify(answer).length;
  } catch {
    return 0;
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/** A measurement channel that breaks must never fail the query it was describing: the host may have closed stderr. */
function reportBestEffort(record: Record<string, unknown>, deps: MeasurementDeps): void {
  try {
    deps.sink(deps.redaction.redact(JSON.stringify({ ye_ast: record })));
  } catch {
    return;
  }
}

/** The size of the store a build left behind; a store that vanished before it is read counts as no bytes. */
async function bytesOf(directory: string): Promise<number> {
  try {
    let total = 0;
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
    }
    return total;
  } catch {
    return 0;
  }
}
