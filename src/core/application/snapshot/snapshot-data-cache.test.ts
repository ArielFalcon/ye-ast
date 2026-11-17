import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
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
    { outcome: "oversize-skipped", entryBytes: Buffer.byteLength("huge") + one * 3, retainedBytes: one * 2 },
  ]);
});

test("an entry whose source bytes alone exceed the budget is skipped without being serialized, and a borderline one is decided by its exact size", () => {
  const events: SnapshotCacheEvent[] = [];
  const content = "🌍".repeat(10);
  const huge = { sources: [{ path: "p", content }] };
  const lowerBound = Buffer.byteLength("huge") + Buffer.byteLength(content);
  const cache = createSnapshotDataCache(lowerBound - 1, (event) => events.push(event));
  const stringify = mock.method(JSON, "stringify");
  try {
    cache.put("huge", huge);
    assert.equal(stringify.mock.callCount(), 0);
  } finally {
    stringify.mock.restore();
  }
  assert.deepEqual(events, [{ outcome: "oversize-skipped", entryBytes: lowerBound, retainedBytes: 0 }]);

  const borderline = createSnapshotDataCache(lowerBound, (event) => events.push(event));
  borderline.put("huge", huge);
  assert.equal(borderline.get("huge"), undefined);
  assert.deepEqual(events[1], { outcome: "oversize-skipped", entryBytes: bytes("huge", huge), retainedBytes: 0 });
});

test("a derived fact is charged on the shared budget, evicts the least recently used snapshot entry, and writes no line", () => {
  const events: SnapshotCacheEvent[] = [];
  const cache = createSnapshotDataCache(2 * bytes("a", empty) + 3, (event) => events.push(event));
  cache.put("a", empty);
  cache.put("b", empty);
  events.length = 0;

  assert.deepEqual(cache.putFact("f", "[1]"), { admitted: true, entryBytes: 4, evicted: 1 });
  assert.deepEqual(cache.getFact("f"), [1]);
  assert.equal(cache.getFact("g"), undefined);
  assert.deepEqual(cache.usage(), { factBytes: 4, retainedBytes: 4 + bytes("b", empty) });
  assert.deepEqual(events.map(({ outcome }) => outcome), ["evicted"]);
  assert.equal(cache.get("a"), undefined);
});

test("a floor budget keeps what the current read and the two before it used past the floor, and evicts older entries first", () => {
  const floor = bytes("a", empty) * 2;
  const cache = createSnapshotDataCache(floor, undefined, { floor: true });
  const read = (keys: string[]): boolean[] => {
    cache.beginRead();
    return keys.map((key) => {
      const hit = cache.get(key) !== undefined;
      if (!hit) cache.put(key, empty);
      return hit;
    });
  };
  const older = ["o1", "o2", "o3", "o4"];
  const latest = ["l1", "l2", "l3"];
  assert.deepEqual(read(older), [false, false, false, false]);
  assert.deepEqual(read(older), [true, true, true, true]);
  assert.ok(cache.usage().retainedBytes > floor);
  assert.deepEqual(read(latest), [false, false, false]);
  assert.deepEqual(read(latest), [true, true, true]);
  assert.deepEqual(read(["n1"]), [false]);
  assert.deepEqual(read(latest), [true, true, true]);
  assert.deepEqual(read(["o1"]), [false]);
});

test("a floor budget holds what every read of an open query used, however many reads the query makes, and the first read after it counts again", () => {
  const floor = bytes("a", empty) * 2;
  const cache = createSnapshotDataCache(floor, undefined, { floor: true });
  const members = ["m1", "m2", "m3", "m4", "m5"];
  const end = cache.beginQuery();
  for (const key of members) {
    cache.beginRead();
    cache.put(key, empty);
  }
  assert.deepEqual(members.map((key) => cache.get(key) !== undefined), [true, true, true, true, true]);
  end();
  end();
  for (const key of ["n1", "n2", "n3"]) {
    cache.beginRead();
    cache.put(key, empty);
  }
  assert.deepEqual(members.map((key) => cache.get(key) !== undefined), [false, false, false, false, false]);
});

test("reads stay one read each while no query is open, and an overlapping query keeps the reads of both until the last ends", () => {
  const floor = bytes("a", empty) * 2;
  const cache = createSnapshotDataCache(floor, undefined, { floor: true });
  const read = (key: string) => {
    cache.beginRead();
    cache.put(key, empty);
  };
  const first = cache.beginQuery();
  read("a1");
  const second = cache.beginQuery();
  first();
  first();
  for (const key of ["a2", "a3", "a4"]) read(key);
  assert.deepEqual(["a1", "a2", "a3", "a4"].map((key) => cache.get(key) !== undefined), [true, true, true, true]);
  second();
  const third = cache.beginQuery();
  for (const key of ["b1", "b2", "b3"]) read(key);
  third();
  for (const key of ["c1", "c2"]) read(key);
  assert.deepEqual(["a1", "a2", "a3", "a4"].map((key) => cache.get(key) !== undefined), [false, false, false, false]);
  assert.deepEqual(["b1", "b2", "b3"].map((key) => cache.get(key) !== undefined), [true, true, true]);
});

test("queries that keep overlapping hold only what the open queries used, never everything since the overlap began", () => {
  const floor = bytes("k1", empty) * 2;
  const cache = createSnapshotDataCache(floor, undefined, { floor: true });
  let open = cache.beginQuery();
  for (let at = 1; at <= 12; at++) {
    const next = cache.beginQuery();
    cache.beginRead();
    cache.put(`k${at}`, empty);
    open();
    open = next;
  }
  assert.deepEqual(["k1", "k2", "k3", "k4"].map((key) => cache.get(key) !== undefined), [false, false, false, false]);
  assert.ok(cache.get("k12") !== undefined);
  open();
});

test("a cap budget never holds more than its bytes, whatever the reads used", () => {
  const cap = bytes("a", empty) * 2;
  const cache = createSnapshotDataCache(cap);
  for (let read = 0; read < 3; read++) {
    cache.beginRead();
    for (const key of ["a", "b", "c", "d"]) cache.put(key, empty);
  }
  assert.ok(cache.usage().retainedBytes <= cap);
});
