import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cellSummary, percentile, sampleOf, slope } from "./latency-stats.ts";

describe("percentile", () => {
  it("is the nearest rank: the smallest value at or above the share asked, both sides of a rank boundary", () => {
    const values = [40, 10, 30, 20];
    assert.equal(percentile(values, 50), 20);
    assert.equal(percentile(values, 51), 30);
    assert.equal(percentile(values, 75), 30);
    assert.equal(percentile(values, 76), 40);
    assert.equal(percentile(values, 100), 40);
  });

  it("is null for no value, so an empty cell never reads as zero milliseconds", () => {
    assert.equal(percentile([], 50), null);
  });
});

describe("slope", () => {
  it("is the least-squares growth per step, not the difference of the ends over the steps", () => {
    assert.equal(slope([100, 112, 118, 130]), 9.6);
  });

  it("is null below two values", () => {
    assert.equal(slope([5]), null);
  });
});

describe("sampleOf", () => {
  it("counts a tallied stage line by its calls and an ordinary one as one call, summing durations per stage", () => {
    const sample = sampleOf(500, [
      { event: "stage", stage: "graph-outgoing-edges", calls: 120, duration_ms: 40 },
      { event: "stage", stage: "unresolved-references", duration_ms: 3 },
      { event: "stage", stage: "unresolved-references", duration_ms: 4 },
      { event: "query", method: "impact.callers", duration_ms: 480, outcome: "ok", status: "complete", rss_bytes: 7 },
    ]);
    assert.deepEqual(sample.stages, { "graph-outgoing-edges": { calls: 120, ms: 40 }, "unresolved-references": { calls: 2, ms: 7 } });
    assert.equal(sample.queryMs, 480);
    assert.equal(sample.rssBytes, 7);
  });

  it("charges the live lifecycle, the export, the store opens and the commit resolution to the floor, but not the copy of edited files", () => {
    const sample = sampleOf(0, [
      { event: "stage", stage: "live-list", duration_ms: 30 },
      { event: "stage", stage: "live-materialize", duration_ms: 500 },
      { event: "stage", stage: "store-open", duration_ms: 10 },
      { event: "stage", stage: "export", duration_ms: 50 },
      { event: "stage", stage: "resolve-commit", duration_ms: 6 },
      { event: "stage", stage: "relations", duration_ms: 900 },
    ]);
    assert.equal(sample.floorMs, 96);
  });

  it("reports a call whose query line never arrived, instead of a fast call", () => {
    assert.equal(sampleOf(10, [{ event: "stage", stage: "export", duration_ms: 5 }]).outcome, "no-query-line");
  });

  it("adds the SQL counters, the cache decisions and the derived-fact counts of every line of the call", () => {
    const sample = sampleOf(0, [
      { event: "sql", prepare: 3, all: 4, get: 1, iterate: 0, run: 0, rows: 50 },
      { event: "sql", prepare: 1, all: 1, get: 0, iterate: 0, run: 0, rows: 2 },
      { event: "cache", outcome: "hit" },
      { event: "cache", outcome: "evicted" },
      { event: "cache", outcome: "evicted" },
      { event: "derived-facts", hits: 5, misses: 1, disk_hits: 2, evicted: 3 },
      { event: "derived-facts", hits: 1, misses: 0, disk_hits: 0, evicted: 0 },
      { event: "index", outcome: "synced", build_ms: 900 },
    ]);
    assert.deepEqual(sample.sql, { prepare: 4, all: 5, get: 1, iterate: 0, run: 0, rows: 52 });
    assert.deepEqual(sample.cache, { hit: 1, miss: 0, admitted: 0, evicted: 2 });
    assert.deepEqual(sample.derived, { hits: 6, misses: 1, diskHits: 2, evicted: 3 });
    assert.deepEqual(sample.indexMs, { synced: 900 });
  });
});

describe("cellSummary", () => {
  it("takes a stage's median over the samples that ran it, sorts stages longest first, and counts outcomes", () => {
    const samples = [
      sampleOf(100, [{ event: "stage", stage: "relations", duration_ms: 10 }, { event: "query", duration_ms: 90, outcome: "ok", status: "complete" }]),
      sampleOf(300, [{ event: "stage", stage: "relations", duration_ms: 30 }, { event: "stage", stage: "export", duration_ms: 50 }, { event: "query", duration_ms: 290, outcome: "ok", status: "partial" }]),
      sampleOf(200, [{ event: "stage", stage: "relations", duration_ms: 20 }, { event: "query", duration_ms: 190, outcome: "ok", status: "complete" }]),
    ];
    const cell = cellSummary("g/r", "unchanged", "callers", samples);
    assert.deepEqual(cell.wall, { p50: 200, p75: 300, p95: 300 });
    assert.deepEqual(cell.stages, [{ stage: "export", ms: 50, calls: 1, present: 1 }, { stage: "relations", ms: 20, calls: 1, present: 3 }]);
    assert.deepEqual(cell.outcomes, { "ok/complete": 2, "ok/partial": 1 });
  });
});
