import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { SnapshotCacheEvent } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { Result } from "../core/domain/shared/result.ts";
import { INDEX_STORE_DIRECTORY, type CodeGraph } from "../core/ports/code-graph.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
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

/**
 * A port whose named methods each write one stage line: the readers a request runs over the whole snapshot, so a host
 * can tell which of them its time went to. Lines carry no request id; under concurrent requests they interleave.
 */
export function measuredStages<T extends object>(port: T, stages: { readonly [K in keyof T]?: string }, deps: MeasurementDeps): T {
  const measuredPort: T = Object.create(port);
  for (const [method, stage] of Object.entries(stages) as [keyof T & string, string][]) {
    const call = port[method];
    if (typeof call !== "function") continue;
    Object.defineProperty(measuredPort, method, { value: (...args: unknown[]) => measuredStage(stage, () => call.apply(port, args), deps) });
  }
  return measuredPort;
}

/** One stage line per call, synchronous or not: `ok`, `threw`, or the kind of the fault a result answered. */
function measuredStage<T>(stage: string, call: () => T, deps: MeasurementDeps): T {
  const started = performance.now();
  const done = (outcome: string) => reportBestEffort({ event: "stage", stage, outcome, start_ms: Math.round(started), duration_ms: elapsed(started) }, deps);
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
    reportBestEffort(queryRecord({ method, durationMs: elapsed(started), outcome: outcomeOf(answer), answer, cpu: process.cpuUsage(cpuAtStart) }), deps);
    return answer;
  } catch (error) {
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
