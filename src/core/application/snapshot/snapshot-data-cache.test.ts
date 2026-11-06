import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSnapshotDataCache, type SnapshotCacheEvent } from "./snapshot-data-cache.ts";
import type { SnapshotData } from "./read-snapshot.ts";

const empty: SnapshotData = { sources: [] };
const bytes = (key: string, data: SnapshotData) => Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(data));

test("charges UTF-8 key and payload bytes at the exact budget boundary", () => {
  const data = { sources: [{ path: "é", content: "🌍" }] };
  const size = bytes("é", data);
  const fits = createSnapshotDataCache(size);
  fits.put("é", data);
  assert.deepEqual(fits.get("é"), data);
  const short = createSnapshotDataCache(size - 1);
  short.put("é", data);
  assert.equal(short.get("é"), undefined);
});

test("a hit promotes an entry before LRU eviction", () => {
  const cache = createSnapshotDataCache(bytes("a", empty) * 2);
  cache.put("a", empty);
  cache.put("b", empty);
  cache.get("a");
  cache.put("c", empty);
  assert.deepEqual(cache.get("a"), empty);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(cache.get("c"), empty);
});

test("replacement releases the previous entry's charge", () => {
  const large = { sources: [{ path: "a", content: "x".repeat(50) }] };
  const cache = createSnapshotDataCache(bytes("a", large) + bytes("b", empty));
  cache.put("a", large);
  cache.put("a", empty);
  cache.put("b", large);
  assert.deepEqual(cache.get("a"), empty);
  assert.deepEqual(cache.get("b"), large);
});

test("an oversized replacement removes the stale entry without evicting others", () => {
  const cache = createSnapshotDataCache(bytes("a", empty) * 2);
  cache.put("a", empty);
  cache.put("b", empty);
  cache.put("a", { sources: [{ path: "large", content: "x".repeat(100) }] });
  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(cache.get("b"), empty);
});

test("invalid or zero budgets disable retention", () => {
  for (const budget of [0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const cache = createSnapshotDataCache(budget);
    cache.put("a", empty);
    assert.equal(cache.get("a"), undefined);
  }
});

test("stored and returned values are isolated from caller mutations", () => {
  const data = { sources: [{ path: "a", content: "original" }], findings: [] };
  const cache = createSnapshotDataCache(1000);
  cache.put("a", data);
  data.sources[0]!.content = "changed";
  data.sources.push({ path: "b", content: "new" });
  const first = cache.get("a")!;
  (first.sources[0] as { content: string }).content = "changed again";
  assert.deepEqual(cache.get("a"), { sources: [{ path: "a", content: "original" }], findings: [] });
});

test("an observer sees each lookup and each admission, eviction and skip with the bytes the cache holds", () => {
  const events: SnapshotCacheEvent[] = [];
  const one = bytes("a", empty);
  const cache = createSnapshotDataCache(one * 2, (event) => events.push(event));
  cache.get("a");
  cache.put("a", empty);
  cache.get("a");
  cache.put("b", empty);
  cache.put("c", empty);
  cache.put("huge", { sources: [{ path: "p", content: "x".repeat(one * 3) }] });

  assert.deepEqual(events, [
    { outcome: "miss", retainedBytes: 0 },
    { outcome: "admitted", entryBytes: one, retainedBytes: one },
    { outcome: "hit", entryBytes: one, retainedBytes: one },
    { outcome: "admitted", entryBytes: one, retainedBytes: one * 2 },
    { outcome: "evicted", entryBytes: one, retainedBytes: one },
    { outcome: "admitted", entryBytes: one, retainedBytes: one * 2 },
    { outcome: "oversize-skipped", entryBytes: bytes("huge", { sources: [{ path: "p", content: "x".repeat(one * 3) }] }), retainedBytes: one * 2 },
  ]);
});
