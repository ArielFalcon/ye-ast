import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGraph, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { IndexCache, IndexDiscard, IndexRetentionPolicy } from "../../ports/index-cache.port.ts";
import { createIndexCache } from "./cached-index.adapter.ts";
import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";

const SUMMARY: IndexSummary = { filesIndexed: 3, filesSkipped: 1, filesErrored: 0, filesNotIndexed: ["src/out/A.java"], versions: { codegraph: "x", schema: 0, extraction: 0 } };
const STORE_FILE = "store.db";
const NOW = Date.UTC(2026, 10, 6);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION: IndexRetentionPolicy = { unusedForMs: 14 * DAY_MS, maxBytes: 1024 * 1024 };

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

interface CacheOverrides {
  codegraph?: string;
  stagingRules?: string;
  directory?: string;
  retention?: IndexRetentionPolicy;
  discards?: IndexDiscard[];
  isAlive?: (pid: number) => boolean;
}

function cacheOf(graph: CodeGraph, overrides: CacheOverrides = {}): IndexCache {
  return createIndexCache({
    directory: overrides.directory ?? directory,
    graph,
    digest,
    codegraph: overrides.codegraph ?? "1.6.2",
    ...(overrides.stagingRules && { stagingRules: overrides.stagingRules }),
    ...(overrides.retention && { retention: overrides.retention }),
    ...(overrides.discards && { onDiscard: (discard: IndexDiscard) => void overrides.discards!.push(discard) }),
    ...(overrides.isAlive && { isAlive: overrides.isAlive }),
    now: () => NOW,
  });
}

const request = (content: string) => ({ content, snapshot: join(workspace, "snapshot"), signal: undefined });
const entries = (): string[] => readdirSync(join(directory, "indexes")).filter((name) => !name.startsWith(".lease-")).sort();

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
  assert.deepEqual(readdirSync(join(directory, "indexes")), []);
});

test("a cache directory that cannot be created is a cache-unavailable fault", async () => {
  const { graph, log } = fakeGraph();
  writeFileSync(join(workspace, "file"), "");

  const answer = await cacheOf(graph, { directory: join(workspace, "file", "ye-ast") }).obtain(request("content-1"));

  assert.ok(!answer.ok && answer.fault.kind === "cache-unavailable");
  assert.equal(log.built, 0);
});

const entryNames = (): string[] => entries().filter((name) => !name.startsWith("."));

function ageEntry(key: string, daysAgo: number): void {
  const at = new Date(NOW - daysAgo * DAY_MS);
  utimesSync(join(directory, "indexes", key, "summary.json"), at, at);
}

async function keyOfContent(cache: IndexCache, content: string): Promise<string> {
  const before = new Set(existsSync(join(directory, "indexes")) ? entryNames() : []);
  const obtained = await cache.obtain(request(content));
  assert.ok(obtained.ok);
  obtained.value.store.close();
  return entryNames().find((name) => !before.has(name))!;
}

test("an index unused past the retention bound is discarded when another is obtained, and a fresh one stays", async () => {
  const { graph } = fakeGraph();
  const discards: IndexDiscard[] = [];
  const cache = cacheOf(graph, { retention: RETENTION, discards });
  const stale = await keyOfContent(cache, "content-stale");
  const fresh = await keyOfContent(cache, "content-fresh");
  ageEntry(stale, 15);
  ageEntry(fresh, 1);

  await keyOfContent(cache, "content-new");

  assert.ok(!entryNames().includes(stale));
  assert.ok(entryNames().includes(fresh));
  assert.equal(entryNames().length, 2);
  assert.equal(discards.length, 1);
});

test("a reuse refreshes the last use, so a long-lived but reused index is kept", async () => {
  const { graph } = fakeGraph();
  const cache = cacheOf(graph, { retention: RETENTION });
  const reused = await keyOfContent(cache, "content-reused");
  ageEntry(reused, 30);

  const again = await cache.obtain(request("content-reused"));
  assert.ok(again.ok);
  again.value.store.close();
  await keyOfContent(cache, "content-other");

  assert.ok(entryNames().includes(reused));
});

test("an index over the byte cap is discarded least recently used first and the one being obtained stays", async () => {
  const { graph } = fakeGraph();
  const cache = cacheOf(graph, { retention: { unusedForMs: 14 * DAY_MS, maxBytes: 1 } });
  const oldest = await keyOfContent(cache, "content-1");
  ageEntry(oldest, 3);

  const newest = await keyOfContent(cache, "content-2");

  assert.deepEqual(entryNames(), [newest]);
});

test("an index held by an open reader is not discarded until the reader closes", async () => {
  const { graph } = fakeGraph();
  const cache = cacheOf(graph, { retention: RETENTION });
  const held = await cache.obtain(request("content-held"));
  assert.ok(held.ok);
  const [key] = entryNames();
  ageEntry(key!, 30);

  await keyOfContent(cache, "content-other");
  assert.ok(entryNames().includes(key!));

  held.value.store.close();
  await keyOfContent(cache, "content-third");
  assert.ok(!entryNames().includes(key!));
});

test("an index leased by another live process is kept, and a lease of a dead process protects nothing", async () => {
  const { graph } = fakeGraph();
  const alive = new Set([4242]);
  const cache = cacheOf(graph, { retention: RETENTION, isAlive: (pid) => alive.has(pid) });
  const leased = await keyOfContent(cache, "content-leased");
  const abandoned = await keyOfContent(cache, "content-abandoned");
  writeFileSync(join(directory, "indexes", `.lease-${leased}-other`), "4242");
  writeFileSync(join(directory, "indexes", `.lease-${abandoned}-other`), "999999");
  ageEntry(leased, 30);
  ageEntry(abandoned, 30);

  await keyOfContent(cache, "content-new");

  assert.ok(entryNames().includes(leased));
  assert.ok(!entryNames().includes(abandoned));
});

test("an index published by another cache while this one sweeps is kept for as long as its reader is open", async () => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const publisher = cacheOf(fakeGraph(async () => open).graph);
  const sweeper = cacheOf(fakeGraph().graph, { retention: { unusedForMs: 14 * DAY_MS, maxBytes: 1 } });
  const building = publisher.obtain(request("content-building"));
  const other = await keyOfContent(sweeper, "content-other");
  release();
  const published = await building;
  assert.ok(published.ok);
  const key = entryNames().find((name) => name !== other)!;
  ageEntry(key, 3);
  ageEntry(other, 2);

  await keyOfContent(sweeper, "content-newest");

  assert.ok(entryNames().includes(key));
  assert.ok(!entryNames().includes(other));
  published.value.store.close();
});

test("a discard reports the bytes it freed and the bytes the cache keeps", async () => {
  const { graph } = fakeGraph();
  const discards: IndexDiscard[] = [];
  const cache = cacheOf(graph, { retention: RETENTION, discards });
  const stale = await keyOfContent(cache, "content-stale");
  ageEntry(stale, 15);

  const kept = await keyOfContent(cache, "content-new");

  const size = (key: string): number => readdirSync(join(directory, "indexes", key), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).reduce((sum, entry) => sum + statSync(join(entry.parentPath, entry.name)).size, 0);
  assert.deepEqual(discards, [{ entryBytes: discards[0]!.entryBytes, retainedBytes: size(kept) }]);
  assert.ok(discards[0]!.entryBytes > 0);
});

test("a build prepares its snapshot first, a reuse prepares nothing, and a failed preparation builds nothing", async () => {
  const { graph, log } = fakeGraph();
  const cache = cacheOf(graph);
  let prepared = 0;
  const prepare = async () => (prepared++, { ok: true as const, value: undefined });

  assert.ok((await cache.obtain({ ...request("content-1"), prepare })).ok);
  assert.ok((await cache.obtain({ ...request("content-1"), prepare })).ok);
  const failed = await cache.obtain({ ...request("content-2"), prepare: async () => ({ ok: false as const, fault: { kind: "index-failed" as const, detail: "export-write-failed" } }) });

  assert.equal(prepared, 1);
  assert.equal(log.built, 1);
  assert.deepEqual(failed, { ok: false, fault: { kind: "index-failed", detail: "export-write-failed" } });
});

test("a discard whose index another process leases and republishes meanwhile leaves no renamed-away copy behind", async () => {
  const { graph } = fakeGraph();
  let armed = false;
  let clockReads = 0;
  let key = "";
  const entry = (): string => join(directory, "indexes", key);
  const cache = createIndexCache({
    directory, graph, digest, codegraph: "1.6.2", retention: { unusedForMs: 1, maxBytes: Number.MAX_SAFE_INTEGER },
    now: () => {
      if (armed && ++clockReads === 2) writeFileSync(join(directory, "indexes", `.lease-${key}-${process.pid}-race`), String(process.pid));
      return armed ? NOW + DAY_MS : NOW;
    },
    isAlive: () => {
      if (armed && clockReads >= 2 && !existsSync(entry())) {
        armed = false;
        mkdirSync(entry());
        writeFileSync(join(entry(), "summary.json"), "{}");
      }
      return true;
    },
  });
  const first = await cache.obtain(request("content-raced"));
  assert.ok(first.ok);
  first.value.store.close();
  key = entryNames()[0]!;
  armed = true;

  assert.ok((await cache.obtain(request("content-other"))).ok);

  assert.equal(armed, false);
  assert.deepEqual(readdirSync(join(directory, "indexes")).filter((name) => name.startsWith(".build-")), []);
  assert.ok(existsSync(entry()));
});
