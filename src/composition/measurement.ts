import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CodeGraph } from "../core/ports/code-graph.port.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
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
export function measuredGraph(graph: CodeGraph, deps: MeasurementDeps): CodeGraph {
  return {
    index: async (snapshot, store, signal) => {
      const started = performance.now();
      try {
        const result = await graph.index(snapshot, store, signal);
        const buildMs = elapsed(started);
        const storeBytes = result.ok ? await bytesOf(store) : 0;
        report({ event: "index", outcome: "built", build_ms: buildMs, store_bytes: storeBytes }, deps);
        return result;
      } catch (error) {
        report({ event: "index", outcome: "threw", build_ms: elapsed(started) }, deps);
        throw error;
      }
    },
    open: (store) => graph.open(store),
    buildMirror: (mirror, signal) => graph.buildMirror(mirror, signal),
    syncMirror: (mirror, paths, signal) => graph.syncMirror(mirror, paths, signal),
  };
}

interface Measured {
  method: string;
  durationMs: number;
  outcome: string;
  answer: unknown;
}

async function measured<T>(method: string, call: () => Promise<T>, deps: MeasurementDeps): Promise<T> {
  const started = performance.now();
  try {
    const answer = await call();
    report(queryRecord({ method, durationMs: elapsed(started), outcome: outcomeOf(answer), answer }), deps);
    return answer;
  } catch (error) {
    report({ event: "query", method, duration_ms: elapsed(started), outcome: "threw" }, deps);
    throw error;
  }
}

function queryRecord({ method, durationMs, outcome, answer }: Measured): Record<string, unknown> {
  const record: Record<string, unknown> = { event: "query", method, duration_ms: durationMs, outcome, bytes: bytesOfAnswer(answer) };
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
function report(record: Record<string, unknown>, deps: MeasurementDeps): void {
  try {
    deps.sink(deps.redaction.redact(JSON.stringify({ ye_ast: record })));
  } catch {
    // The answer is the product; the line is a courtesy.
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
