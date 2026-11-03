import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA, type Fact } from "../core/domain/shared/fact.ts";
import type { CodeGraph } from "../core/ports/code-graph.port.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import { measuredEntrypoints, measuredGraph, measuredImpact, measuredOutline } from "./measurement.ts";

const SECRET = "s3cr3t";
const SHA = "a".repeat(40);

const redaction: Redaction = {
  redact: (text) => text.replaceAll(SECRET, REDACTED),
  redactValue: (value) => JSON.parse(JSON.stringify(value).replaceAll(SECRET, REDACTED)),
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: String,
  containsSecret: (text) => text.includes(SECRET),
};

function fact(status: "complete" | "partial" | "unknown", overrides: Record<string, unknown> = {}): Fact<unknown> {
  return {
    schema: SCHEMA,
    snapshot: { repo: "shop", kind: "sha", sha: SHA },
    producer: { name: "ye-ast", version: "0" },
    inputs: {
      trust: "untrusted",
      scope: "",
      declaredScope: { languages: [], frameworks: [], include: [], exclude: [] },
      content: "",
      config: "",
      declaredConfig: {},
      engines: {},
    },
    evidence: [],
    status,
    ...(status === "unknown" ? { reason: "index-unavailable" } : { value: {} }),
    ...(status === "partial" ? { cuts: [{ kind: "hub", at: ["src/A.java"], limit: 2 }, { kind: "depth", at: ["src/B.java"], limit: 1 }] } : {}),
    ...overrides,
  } as Fact<unknown>;
}

function entrypointsOf(answer: Fact<unknown>): EntrypointQueries {
  return { map: async () => ({ ok: true, value: answer }) as never };
}

function impactOf(answer: Fact<unknown> | { kind: string }): ImpactQueries {
  const call = async () => ("kind" in answer ? ({ ok: false, fault: { kind: answer.kind, detail: "" } } as never) : ({ ok: true, value: answer } as never));
  return { ofChange: call, callers: call, importers: call };
}

function collecting(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => void lines.push(line) };
}

const recordOf = (line: string | undefined): Record<string, unknown> => JSON.parse(line ?? "null").ye_ast as Record<string, unknown>;

test("a query line carries the method, its duration, its outcome and the fact it answered", async () => {
  const { lines, sink } = collecting();
  await measuredEntrypoints(entrypointsOf(fact("complete")), { sink, redaction }).map({ repo: "/work/shop", repoId: "shop", revision: "HEAD" });

  const record = recordOf(lines[0]);
  assert.equal(record.event, "query");
  assert.equal(record.method, "map");
  assert.equal(record.outcome, "ok");
  assert.equal(record.status, "complete");
  assert.equal(record.schema, SCHEMA);
  assert.equal(record.trust, "untrusted");
  assert.equal(record.cut_kinds, undefined);
  assert.deepEqual(record.snapshot, { kind: "sha", value: SHA });
  assert.equal(typeof record.duration_ms, "number");
  assert.equal(typeof record.bytes, "number");
});

test("a fault is its kind, with no status and no snapshot to report", async () => {
  const { lines, sink } = collecting();
  await measuredImpact(impactOf({ kind: "no-merge-base" }), { sink, redaction }).ofChange({ repo: "/work/shop", repoId: "shop", base: "main", head: "HEAD" });

  const record = recordOf(lines[0]);
  assert.equal(record.outcome, "no-merge-base");
  assert.equal(record.status, undefined);
  assert.equal(record.snapshot, undefined);
});

test("a partial fact reports the number of cuts and an unknown one reports none", async () => {
  const partial = collecting();
  await measuredImpact(impactOf(fact("partial")), { sink: partial.sink, redaction }).callers({ repo: "/work/shop", repoId: "shop", revision: "HEAD", targets: [] });
  assert.deepEqual(recordOf(partial.lines[0]).cut_kinds, ["depth", "hub"]);

  const unknown = collecting();
  await measuredImpact(impactOf(fact("unknown")), { sink: unknown.sink, redaction }).importers({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: [] });
  const record = recordOf(unknown.lines[0]);
  assert.equal(record.status, "unknown");
  assert.equal(record.reason, "index-unavailable");
  assert.equal(record.cut_kinds, undefined);
});

test("the line never names the repository, and a secret in it is redacted", async () => {
  const { lines, sink } = collecting();
  await measuredEntrypoints(entrypointsOf(fact("complete", { snapshot: { repo: "shop", kind: "sha", sha: SECRET } })), { sink, redaction }).map({
    repo: "/work/shop",
    repoId: "shop",
    revision: "HEAD",
  });

  assert.equal(lines[0]?.includes("shop"), false);
  assert.equal(lines[0]?.includes(SECRET), false);
  assert.equal(lines[0]?.includes(REDACTED), true);
});

test("an index build emits its own line, with its duration and the bytes it left", async () => {
  const { lines, sink } = collecting();
  const directory = await mkdtemp(join(tmpdir(), "ye-ast-measure-"));
  try {
    await writeFile(join(directory, "index.db"), "x".repeat(10));
    const graph: CodeGraph = {
      index: async () => ({ ok: true, value: { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "1.6.2", schema: 11, extraction: 27 } } }),
      open: () => ({ ok: false, fault: { kind: "unsupported-store", detail: "" } }),
      buildMirror: async () => {
        throw new Error("not under test");
      },
      syncMirror: async () => {
        throw new Error("not under test");
      },
    };
    await measuredGraph(graph, { sink, redaction }).index("snapshot", directory);

    const record = recordOf(lines[0]);
    assert.equal(record.event, "index");
    assert.equal(record.outcome, "built");
    assert.equal(record.store_bytes, 10);
    assert.equal(typeof record.build_ms, "number");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an index that throws is reported as a throw and still answers the throw", async () => {
  const { lines, sink } = collecting();
  const graph: CodeGraph = {
    index: async () => {
      throw new Error("boom");
    },
    open: () => ({ ok: false, fault: { kind: "unsupported-store", detail: "" } }),
    buildMirror: async () => {
      throw new Error("not under test");
    },
    syncMirror: async () => {
      throw new Error("not under test");
    },
  };
  await assert.rejects(measuredGraph(graph, { sink, redaction }).index("snapshot", "/nonexistent"));
  assert.equal(recordOf(lines[0]).outcome, "threw");
});

test("a measurement channel that throws never fails the query it describes", async () => {
  const sink = () => {
    throw new Error("stderr is closed");
  };
  const answer = await measuredEntrypoints(entrypointsOf(fact("complete")), { sink, redaction }).map({ repo: "/work/shop", repoId: "shop", revision: "HEAD" });
  assert.equal(answer.ok, true);
});

test("an index build that answers a fault reports that fault, never built", async () => {
  const { lines, sink } = collecting();
  const graph: CodeGraph = {
    index: async () => ({ ok: false, fault: { kind: "store-unreadable", detail: "the store vanished" } }),
    open: () => ({ ok: false, fault: { kind: "unsupported-store", detail: "" } }),
    buildMirror: async () => ({ ok: false, fault: { kind: "index-failed", detail: "" } }),
    syncMirror: async () => ({ ok: false, fault: { kind: "index-failed", detail: "" } }),
  };

  const answer = await measuredGraph(graph, { sink, redaction }).index("snapshot", "/nonexistent-store");

  assert.equal(answer.ok, false);
  assert.equal(recordOf(lines[0]).outcome, "store-unreadable");
});

test("a mirror build emits the index line a live session would otherwise hide", async () => {
  const { lines, sink } = collecting();
  const summary = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "1.6.2", schema: 11, extraction: 27 } };
  const graph: CodeGraph = {
    index: async () => ({ ok: false, fault: { kind: "index-failed", detail: "" } }),
    open: () => ({ ok: false, fault: { kind: "unsupported-store", detail: "" } }),
    buildMirror: async () => ({ ok: true, value: summary }),
    syncMirror: async () => ({ ok: true, value: { ...summary, filesFailed: [] } }),
  };

  await measuredGraph(graph, { sink, redaction }).buildMirror("/mirror");

  assert.equal(recordOf(lines[0]).event, "index");
  assert.equal(recordOf(lines[0]).outcome, "built");
});

test("an outline query emits its own query line", async () => {
  const { lines, sink } = collecting();
  const queries = { outline: async () => ({ ok: true, value: fact("complete") }) as never };

  await measuredOutline(queries, { sink, redaction }).outline({ repo: "/work/shop", repoId: "shop", files: [] } as never);

  assert.equal(recordOf(lines[0]).method, "outline");
});
