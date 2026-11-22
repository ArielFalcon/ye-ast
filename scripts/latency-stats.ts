/**
 * The pure part of the latency bench: what one call's measurement lines say, the percentiles of a cell, the RSS slope
 * of a session of edits, and the Markdown table of a report.
 */
import type { MeasurementRecord } from "./latency-session.ts";

export interface SqlCounts {
  prepare: number;
  all: number;
  get: number;
  iterate: number;
  run: number;
  rows: number;
}

export interface CallSample {
  wallMs: number;
  /** The engine's own duration, summed over the query lines of the call. */
  queryMs: number;
  outcome: string;
  status: string | null;
  rssBytes: number | null;
  /** Each stage's summed duration and number of calls. */
  stages: Record<string, { calls: number; ms: number }>;
  /** The stages that prove freshness and open the snapshot, whatever the question: see `isFloorStage`. */
  floorMs: number;
  /** Build or sync time of the index lines (`built`, `synced`). */
  indexMs: Record<string, number>;
  sql: SqlCounts | null;
  cache: { hit: number; miss: number; admitted: number; evicted: number };
  derived: { hits: number; misses: number; diskHits: number; evicted: number };
  indexDiscards: number;
}

/**
 * The fixed cost of a call: the live lifecycle around the answer, the commit listing, the store opens and the commit
 * resolution. `live-materialize` copies edited files and belongs to the refresh, not to the floor.
 */
export function isFloorStage(stage: string): boolean {
  return (stage.startsWith("live-") && stage !== "live-materialize") || stage === "store-open" || stage === "export" || stage === "resolve-commit";
}

const number = (value: unknown): number => (typeof value === "number" ? value : 0);

export function sampleOf(wallMs: number, records: readonly MeasurementRecord[]): CallSample {
  const sample: CallSample = {
    wallMs,
    queryMs: 0,
    outcome: "no-query-line",
    status: null,
    rssBytes: null,
    stages: {},
    floorMs: 0,
    indexMs: {},
    sql: null,
    cache: { hit: 0, miss: 0, admitted: 0, evicted: 0 },
    derived: { hits: 0, misses: 0, diskHits: 0, evicted: 0 },
    indexDiscards: 0,
  };
  for (const record of records) {
    if (record.event === "query") {
      sample.queryMs += number(record.duration_ms);
      sample.outcome = typeof record.outcome === "string" ? record.outcome : "unknown";
      sample.status = typeof record.status === "string" ? record.status : null;
      sample.rssBytes = typeof record.rss_bytes === "number" ? record.rss_bytes : sample.rssBytes;
    } else if (record.event === "stage" && typeof record.stage === "string") {
      const held = sample.stages[record.stage] ?? { calls: 0, ms: 0 };
      sample.stages[record.stage] = { calls: held.calls + (typeof record.calls === "number" ? record.calls : 1), ms: held.ms + number(record.duration_ms) };
      if (isFloorStage(record.stage)) sample.floorMs += number(record.duration_ms);
    } else if (record.event === "index" && typeof record.outcome === "string") {
      sample.indexMs[record.outcome] = (sample.indexMs[record.outcome] ?? 0) + number(record.build_ms);
    } else if (record.event === "sql") {
      const held = sample.sql ?? { prepare: 0, all: 0, get: 0, iterate: 0, run: 0, rows: 0 };
      sample.sql = { prepare: held.prepare + number(record.prepare), all: held.all + number(record.all), get: held.get + number(record.get), iterate: held.iterate + number(record.iterate), run: held.run + number(record.run), rows: held.rows + number(record.rows) };
    } else if (record.event === "cache" && typeof record.outcome === "string" && record.outcome in sample.cache) {
      sample.cache[record.outcome as keyof CallSample["cache"]] += 1;
    } else if (record.event === "derived-facts") {
      sample.derived = { hits: sample.derived.hits + number(record.hits), misses: sample.derived.misses + number(record.misses), diskHits: sample.derived.diskHits + number(record.disk_hits), evicted: sample.derived.evicted + number(record.evicted) };
    } else if (record.event === "index-cache") {
      sample.indexDiscards += 1;
    }
  }
  return sample;
}

/** The nearest-rank percentile `p` (0 < p <= 100) of `values`; `null` for no value. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** The least-squares slope of `values` over their index, in units per step; `null` below two values. */
export function slope(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let variance = 0;
  values.forEach((value, index) => {
    covariance += (index - meanX) * (value - meanY);
    variance += (index - meanX) ** 2;
  });
  return covariance / variance;
}

export interface CellSummary {
  repo: string;
  scenario: string;
  family: string;
  n: number;
  wall: { p50: number | null; p75: number | null; p95: number | null };
  floorP50: number | null;
  syncP50: number | null;
  sqlP50: SqlCounts | null;
  cacheP50: CallSample["cache"];
  derivedP50: CallSample["derived"];
  rssLastBytes: number | null;
  outcomes: Record<string, number>;
  /** Each stage's median duration and calls over the samples that ran it, longest first. */
  stages: { stage: string; ms: number; calls: number; present: number }[];
}

const median = (values: readonly number[]): number => percentile(values, 50) ?? 0;

export function cellSummary(repo: string, scenario: string, family: string, samples: readonly CallSample[]): CellSummary {
  const outcomes: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.status === null ? sample.outcome : `${sample.outcome}/${sample.status}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const stageNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.stages)))];
  const stages = stageNames
    .map((stage) => {
      const runs = samples.flatMap((sample) => (sample.stages[stage] === undefined ? [] : [sample.stages[stage]!]));
      return { stage, ms: median(runs.map((run) => run.ms)), calls: median(runs.map((run) => run.calls)), present: runs.length };
    })
    .sort((a, b) => b.ms - a.ms || (a.stage < b.stage ? -1 : 1));
  const synced = samples.flatMap((sample) => (sample.indexMs.synced === undefined ? [] : [sample.indexMs.synced]));
  const withSql = samples.flatMap((sample) => (sample.sql === null ? [] : [sample.sql]));
  const field = <T, K extends keyof T>(rows: readonly T[], key: K) => median(rows.map((row) => row[key] as number));
  return {
    repo,
    scenario,
    family,
    n: samples.length,
    wall: { p50: percentile(samples.map((sample) => sample.wallMs), 50), p75: percentile(samples.map((sample) => sample.wallMs), 75), p95: percentile(samples.map((sample) => sample.wallMs), 95) },
    floorP50: samples.length === 0 ? null : median(samples.map((sample) => sample.floorMs)),
    syncP50: percentile(synced, 50),
    sqlP50: withSql.length === 0 ? null : { prepare: field(withSql, "prepare"), all: field(withSql, "all"), get: field(withSql, "get"), iterate: field(withSql, "iterate"), run: field(withSql, "run"), rows: field(withSql, "rows") },
    cacheP50: { hit: field(samples.map((s) => s.cache), "hit"), miss: field(samples.map((s) => s.cache), "miss"), admitted: field(samples.map((s) => s.cache), "admitted"), evicted: field(samples.map((s) => s.cache), "evicted") },
    derivedP50: { hits: field(samples.map((s) => s.derived), "hits"), misses: field(samples.map((s) => s.derived), "misses"), diskHits: field(samples.map((s) => s.derived), "diskHits"), evicted: field(samples.map((s) => s.derived), "evicted") },
    rssLastBytes: samples.at(-1)?.rssBytes ?? null,
    outcomes,
    stages,
  };
}

const ms = (value: number | null): string => (value === null ? "–" : String(Math.round(value)));
const mb = (value: number | null): string => (value === null ? "–" : String(Math.round(value / 1048576)));

/** One Markdown row per cell; the full stage lists stay in the JSON report. */
export function cellTable(cells: readonly CellSummary[]): string {
  const header = "| repo | scenario | family | n | p50 ms | p75 ms | p95 ms | floor p50 | sync p50 | SQL prepare / all / rows p50 | cache hit / miss / evicted p50 | derived hits / misses / evicted p50 | RSS MB | top stages (p50 ms) |";
  const rule = `|${" --- |".repeat(14)}`;
  const rows = cells.map((cell) => {
    const sql = cell.sqlP50 === null ? "–" : `${cell.sqlP50.prepare} / ${cell.sqlP50.all} / ${cell.sqlP50.rows}`;
    const top = cell.stages.slice(0, 4).map((stage) => `${stage.stage} ${Math.round(stage.ms)}${stage.calls > 1 ? `×${stage.calls}` : ""}`).join(", ");
    return `| ${cell.repo} | ${cell.scenario} | ${cell.family} | ${cell.n} | ${ms(cell.wall.p50)} | ${ms(cell.wall.p75)} | ${ms(cell.wall.p95)} | ${ms(cell.floorP50)} | ${ms(cell.syncP50)} | ${sql} | ${cell.cacheP50.hit} / ${cell.cacheP50.miss} / ${cell.cacheP50.evicted} | ${cell.derivedP50.hits} / ${cell.derivedP50.misses} / ${cell.derivedP50.evicted} | ${mb(cell.rssLastBytes)} | ${top} |`;
  });
  return [header, rule, ...rows].join("\n");
}
