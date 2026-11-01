import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGraph, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { IndexCache } from "../../ports/index-cache.port.ts";
import { createIndexCache } from "./cached-index.adapter.ts";
import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";

const SUMMARY: IndexSummary = { filesIndexed: 3, filesSkipped: 1, filesErrored: 0, filesNotIndexed: ["src/out/A.java"], versions: { codegraph: "x", schema: 0, extraction: 0 } };
const STORE_FILE = "store.db";

let workspace: string;
let directory: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  directory = join(workspace, "cache", "ye-ast");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const digest = { of: (text: string): string => createHash("sha256").update(text).digest("hex") };

function fakeGraph(gate?: () => Promise<void>) {
  const log = { built: 0, closed: 0 };
  const reader = { versions: SUMMARY.versions, close: () => void log.closed++ } as unknown as CodeGraphReader;
  const graph: CodeGraph = {
    buildMirror: async () => ({ ok: false, fault: { kind: "index-failed", detail: "not used" } }),
    syncMirror: async () => ({ ok: false, fault: { kind: "index-failed", detail: "not used" } }),
    index: async (_snapshot, store) => {
      log.built++;
      await gate?.();
      mkdirSync(join(store, INDEX_STORE_DIRECTORY), { recursive: true });
      writeFileSync(join(store, INDEX_STORE_DIRECTORY, STORE_FILE), "complete");
      return { ok: true, value: SUMMARY };
    },
    open: (store) => {
      try {
        return readFileSync(join(store, INDEX_STORE_DIRECTORY, STORE_FILE), "utf8") === "complete" ? { ok: true, value: reader } : { ok: false, fault: { kind: "unsupported-store", detail: "x" } };
      } catch {
        return { ok: false, fault: { kind: "store-unreadable", detail: "x" } };
      }
    },
  };
  return { graph, log };
}

function cacheOf(graph: CodeGraph, overrides: { codegraph?: string; stagingRules?: string; directory?: string } = {}): IndexCache {
  return createIndexCache({ directory: overrides.directory ?? directory, graph, digest, codegraph: overrides.codegraph ?? "1.6.2", ...(overrides.stagingRules && { stagingRules: overrides.stagingRules }) });
}

const request = (content: string) => ({ content, snapshot: join(workspace, "snapshot"), signal: undefined });
const entries = (): string[] => readdirSync(join(directory, "indexes")).sort();

test("a second call with equal staged content reuses the kept index and builds nothing", async () => {
  const { graph, log } = fakeGraph();
  const cache = cacheOf(graph);

  const cold = await cache.obtain(request("content-1"));
  const warm = await cache.obtain(request("content-1"));

  assert.ok(cold.ok && warm.ok);
  assert.equal(log.built, 1);
  assert.deepEqual(warm.value.summary, cold.value.summary);
  assert.deepEqual(warm.value.summary.filesNotIndexed, ["src/out/A.java"]);
});

test("a change in the staged content builds anew and keeps both indexes", async () => {
  const { graph, log } = fakeGraph();
  const cache = cacheOf(graph);

  await cache.obtain(request("content-1"));
  await cache.obtain(request("content-2"));

  assert.equal(log.built, 2);
  assert.equal(entries().length, 2);
});

test("a change in the codegraph version builds anew", async () => {
  const { graph, log } = fakeGraph();

  await cacheOf(graph, { codegraph: "1.6.2" }).obtain(request("content-1"));
  await cacheOf(graph, { codegraph: "1.7.0" }).obtain(request("content-1"));

  assert.equal(log.built, 2);
});

test("a change in the staging rules version builds anew", async () => {
  const { graph, log } = fakeGraph();

  await cacheOf(graph, { stagingRules: "1" }).obtain(request("content-1"));
  await cacheOf(graph, { stagingRules: "2" }).obtain(request("content-1"));

  assert.equal(log.built, 2);
});

test("two builds of one key publish one index and leave no build directory behind", async () => {
  let entered = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  const { graph, log } = fakeGraph(async () => {
    if (++entered === 2) release();
    await both;
  });
  const cache = cacheOf(graph);

  const [first, second] = await Promise.all([cache.obtain(request("content-1")), cache.obtain(request("content-1"))]);

  assert.ok(first.ok && second.ok);
  assert.equal(log.built, 2);
  assert.equal(entries().length, 1);
});

test("an index that cannot be opened is rebuilt in its place and used from then on", async () => {
  const { graph, log } = fakeGraph();
  const cache = cacheOf(graph);
  await cache.obtain(request("content-1"));
  const [key] = entries();
  writeFileSync(join(directory, "indexes", key!, INDEX_STORE_DIRECTORY, STORE_FILE), "torn");

  const rebuilt = await cache.obtain(request("content-1"));
  const reused = await cache.obtain(request("content-1"));

  assert.ok(rebuilt.ok && reused.ok);
  assert.equal(log.built, 2);
  assert.deepEqual(entries(), [key]);
  assert.equal(readFileSync(join(directory, "indexes", key!, INDEX_STORE_DIRECTORY, STORE_FILE), "utf8"), "complete");
});

test("a kept index without its summary is unusable and rebuilt", async () => {
  const { graph, log } = fakeGraph();
  const cache = cacheOf(graph);
  await cache.obtain(request("content-1"));
  const [key] = entries();
  rmSync(join(directory, "indexes", key!, "summary.json"));

  const rebuilt = await cache.obtain(request("content-1"));

  assert.ok(rebuilt.ok);
  assert.equal(log.built, 2);
});

test("the cache directory is created for its owner alone", { skip: process.platform === "win32" }, async () => {
  const { graph } = fakeGraph();

  await cacheOf(graph).obtain(request("content-1"));

  for (const created of [join(workspace, "cache"), directory, join(directory, "indexes"), join(directory, "indexes", entries()[0]!)]) {
    assert.equal(statSync(created).mode & 0o777, 0o700, created);
  }
});

test("a cache directory others can reach is never used", { skip: process.platform === "win32" }, async () => {
  const { graph, log } = fakeGraph();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o777);

  const answer = await cacheOf(graph).obtain(request("content-1"));

  assert.ok(!answer.ok && answer.fault.kind === "cache-unavailable");
  assert.equal(log.built, 0);
});

test("a cache root that is a symbolic link is never used", { skip: process.platform === "win32" }, async () => {
  const { graph, log } = fakeGraph();
  const elsewhere = join(workspace, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  mkdirSync(join(workspace, "cache"), { mode: 0o700 });
  symlinkSync(elsewhere, directory);

  const answer = await cacheOf(graph).obtain(request("content-1"));

  assert.ok(!answer.ok && answer.fault.kind === "cache-unavailable");
  assert.equal(log.built, 0);
});

test("a build that fails leaves no entry and returns its fault", async () => {
  const { graph } = fakeGraph();
  const failing: CodeGraph = { ...graph, index: async () => ({ ok: false, fault: { kind: "index-failed", detail: "x" } }) };

  const answer = await cacheOf(failing).obtain(request("content-1"));

  assert.ok(!answer.ok && answer.fault.kind === "index-failed");
  assert.deepEqual(entries(), []);
});

test("a cache directory that cannot be created is a cache-unavailable fault", async () => {
  const { graph, log } = fakeGraph();
  writeFileSync(join(workspace, "file"), "");

  const answer = await cacheOf(graph, { directory: join(workspace, "file", "ye-ast") }).obtain(request("content-1"));

  assert.ok(!answer.ok && answer.fault.kind === "cache-unavailable");
  assert.equal(log.built, 0);
});
