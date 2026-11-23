import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { createSnapshotDataCache, DECODED_HEAP_PER_SERIALIZED_BYTE, HELD_READS, type SnapshotCacheEvent } from "./snapshot-data-cache.ts";
import type { SourceFile } from "../../ports/source-file.port.ts";
import type { SnapshotData } from "./read-snapshot.ts";

const empty: SnapshotData = { sources: [] };
const charged = (serializedBytes: number) => Math.ceil(serializedBytes * DECODED_HEAP_PER_SERIALIZED_BYTE);
const bytes = (key: string, data: SnapshotData) => charged(Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(data)));

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

test("a stored value is isolated from the caller's later mutations, and a returned one cannot be mutated", () => {
  const data = { sources: [{ path: "a", content: "original" }], findings: [] };
  const cache = createSnapshotDataCache(1000);
  cache.put("a", data);
  data.sources[0]!.content = "changed";
  data.sources.push({ path: "b", content: "new" });
  const first = cache.get("a")!;
  assert.throws(() => ((first.sources[0] as { content: string }).content = "changed again"), TypeError);
  assert.throws(() => (first.sources as SourceFile[]).push({ path: "c", content: "" }), TypeError);
  assert.deepEqual(cache.get("a"), { sources: [{ path: "a", content: "original" }], findings: [] });
});

test("a hit answers the frozen value the cache admitted, decoding nothing", (t) => {
  const cache = createSnapshotDataCache(1000);
  cache.put("a", { sources: [{ path: "a", content: "x" }] });
  const admitted = cache.putFact("f", JSON.stringify({ starts: [1, 2] }));
  const parse = t.mock.method(JSON, "parse");

  const entries = [cache.get("a"), cache.get("a")];
  const facts = [cache.getFact("f"), cache.getFact("f")];

  assert.equal(parse.mock.callCount(), 0);
  assert.equal(entries[0], entries[1]);
  assert.equal(facts[0], facts[1]);
  assert.equal(facts[0], admitted.value);
  assert.throws(() => (facts[0] as { starts: number[] }).starts.push(3), TypeError);
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
    { outcome: "oversize-skipped", entryBytes: charged(Buffer.byteLength("huge") + one * 3), retainedBytes: one * 2 },
  ]);
});

test("an entry whose source bytes alone exceed the budget is skipped without being serialized, and a borderline one is decided by its exact size", () => {
  const events: SnapshotCacheEvent[] = [];
  const content = "🌍".repeat(10);
  const huge = { sources: [{ path: "p", content }] };
  const lowerBound = charged(Buffer.byteLength("huge") + Buffer.byteLength(content));
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
  const fact = charged(Buffer.byteLength("f") + Buffer.byteLength("[1]"));
  const cache = createSnapshotDataCache(2 * bytes("a", empty) + fact - 1, (event) => events.push(event));
  cache.put("a", empty);
  cache.put("b", empty);
  events.length = 0;

  assert.deepEqual(cache.putFact("f", "[1]"), { admitted: true, entryBytes: fact, evicted: 1, value: [1] });
  assert.deepEqual(cache.getFact("f"), [1]);
  assert.equal(cache.getFact("g"), undefined);
  assert.deepEqual(cache.usage(), { factBytes: fact, retainedBytes: fact + bytes("b", empty), floorBytes: 2 * bytes("a", empty) + fact - 1 });
  assert.deepEqual(events.map(({ outcome }) => outcome), ["evicted"]);
  assert.equal(cache.get("a"), undefined);
});

test("a floor budget keeps what the current read and the two before it used past the floor, and evicts older entries first", () => {
  const cache = createSnapshotDataCache("working-set");
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
  assert.ok(cache.usage().retainedBytes > cache.usage().floorBytes);
  assert.deepEqual(read(latest), [false, false, false]);
  assert.deepEqual(read(latest), [true, true, true]);
  assert.deepEqual(read(["n1"]), [false]);
  assert.deepEqual(read(latest), [true, true, true]);
  assert.deepEqual(read(["o1"]), [false]);
});

test("a floor budget holds what every read of an open query used, however many reads the query makes, and the first read after it counts again", () => {
  const cache = createSnapshotDataCache("working-set");
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
  const cache = createSnapshotDataCache("working-set");
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
  const cache = createSnapshotDataCache("working-set");
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

test("the working-set floor keeps what every read of a repository's recent contents used, however many reads ask them", () => {
  const cache = createSnapshotDataCache("working-set");
  const family = (key: string): boolean => {
    cache.beginRead({ repository: "/repo", snapshot: "live", key: "content-1" });
    const hit = cache.get(key) !== undefined;
    if (!hit) cache.put(key, empty);
    return hit;
  };
  const families = ["callers", "trace", "impact", "outline", "importers", "entrypoints", "workspace"];

  assert.deepEqual(families.map(family), families.map(() => false));
  assert.deepEqual(families.map(family), families.map(() => true));
  const used = families.reduce((sum, key) => sum + bytes(key, empty), 0);
  assert.deepEqual(cache.usage(), { factBytes: 0, retainedBytes: used, floorBytes: used });
});

test("a content that left its repository's recent contents is evicted first, and the floor is the most those contents used", () => {
  const cache = createSnapshotDataCache("working-set");
  const read = (content: string, keys: readonly string[]): boolean[] => {
    cache.beginRead({ repository: "/repo", snapshot: "live", key: content });
    return keys.map((key) => {
      const hit = cache.get(key) !== undefined;
      if (!hit) cache.put(key, empty);
      return hit;
    });
  };
  const one = bytes("s1", empty);
  read("c1", ["s1", "a1", "b1"]);
  for (const at of [2, 3, 4, 5]) read(`c${at}`, ["s1", `o${at}`]);

  assert.equal(cache.usage().floorBytes, one * 5, "at c3: s1, c1's a1 and b1, o2 and o3");
  assert.deepEqual(read("c6", ["s1", "o5", "a1", "b1"]), [true, true, false, false]);
  assert.ok(cache.usage().retainedBytes <= cache.usage().floorBytes + 2 * one);
});

test("edits that move the live tree keep the base revision a change query reads, and the floor counts both", () => {
  const cache = createSnapshotDataCache("working-set");
  const read = (snapshot: "live" | "revision", content: string, key: string): boolean => {
    cache.beginRead({ repository: "/repo", snapshot, key: content });
    const hit = cache.get(key) !== undefined;
    if (!hit) cache.put(key, empty);
    return hit;
  };
  read("revision", "base", "b0");
  for (let edit = 1; edit <= 6; edit++) read("live", `l${edit}`, `e${edit}`);

  assert.deepEqual([read("revision", "base", "b0"), read("live", "l6", "e6"), read("live", "l1", "e1")], [true, true, false]);
  assert.equal(cache.usage().floorBytes, bytes("b0", empty) * 4);
});

test("a host that reads many repositories holds the largest repository's working set as its floor, not their sum", () => {
  const cache = createSnapshotDataCache("working-set");
  const read = (repository: string, keys: readonly string[]) => {
    cache.beginRead({ repository, snapshot: "live", key: "head" });
    for (const key of keys) if (cache.get(key) === undefined) cache.put(key, empty);
  };
  read("/large", ["l1", "l2", "l3"]);
  for (const repository of ["/a", "/b", "/c", "/d", "/e"]) read(repository, [repository]);

  assert.equal(cache.usage().floorBytes, bytes("l1", empty) * 3);
  assert.ok(cache.usage().retainedBytes < bytes("l1", empty) * 8);
});

/** One read of a repository's single revision content, as the query that reads it makes it. */
function queryAt(cache: ReturnType<typeof createSnapshotDataCache>, ask: () => void): void {
  const end = cache.beginQuery();
  cache.beginRead({ repository: "/repo", snapshot: "revision", key: "sha" });
  ask();
  end();
}

const answer = { sources: [], output: "a".repeat(1000) };
const answerKey = (request: number) => `answer-${String(request).padStart(3, "0")}`;

test("distinct requests at one content keep at most the floor plus the answers of the reads it holds, and the floor does not grow with them", () => {
  const cache = createSnapshotDataCache("working-set");
  queryAt(cache, () => cache.put("sources", { sources: [{ path: "a", content: "s".repeat(4000) }] }));
  const floor = cache.usage().floorBytes;

  for (let request = 1; request <= 200; request++) {
    queryAt(cache, () => {
      cache.get("sources");
      cache.put(answerKey(request), answer, "request");
    });
    assert.ok(cache.usage().retainedBytes <= floor + (1 + HELD_READS) * bytes(answerKey(request), answer), `after request ${request}`);
  }

  assert.equal(cache.usage().floorBytes, floor);
  assert.equal(cache.get(answerKey(1)), undefined);
  assert.notEqual(cache.get(answerKey(200)), undefined);
  assert.notEqual(cache.get("sources"), undefined);
});

test("a repeated request hits after other distinct requests that fit beside the floor, and the least recently used answer is the one evicted", () => {
  const cache = createSnapshotDataCache("working-set");
  const room = 2 * bytes(answerKey(1), answer) + bytes(answerKey(1), answer) / 2;
  queryAt(cache, () => {
    cache.put("sources", { sources: [{ path: "a", content: "s".repeat(4000) }] });
    cache.put("released", { sources: [{ path: "r", content: "r".repeat(Math.ceil(room / DECODED_HEAP_PER_SERIALIZED_BYTE)) }] });
    cache.put("released", empty);
  });
  const ask = (request: number): boolean => {
    let hit = false;
    queryAt(cache, () => {
      cache.get("sources");
      hit = cache.get(answerKey(request)) !== undefined;
      if (!hit) cache.put(answerKey(request), answer, "request");
    });
    return hit;
  };

  assert.deepEqual([1, 2, 1].map(ask), [false, false, true]);
  assert.deepEqual([3, 1, 4].map(ask), [false, true, false]);
  assert.deepEqual([1, 4, 2, 3].map(ask), [true, true, false, false]);
});

test("inside an open query a held stale entry does not stop the eviction of an older entry no read holds", () => {
  const cache = createSnapshotDataCache("working-set");
  const large = { sources: [{ path: "p", content: "x".repeat(400) }] };
  cache.beginRead({ repository: "/other", snapshot: "live", key: "head" });
  cache.put("big", large);
  cache.put("big", empty);
  cache.put("old", empty);
  for (let read = 0; read < 3; read++) cache.beginRead({ repository: "/other", snapshot: "live", key: "head" });
  const end = cache.beginQuery();
  cache.beginRead({ repository: "/repo", snapshot: "revision", key: "c1" });
  cache.put("held", empty);
  for (const content of ["c2", "c3", "c4"]) cache.beginRead({ repository: "/repo", snapshot: "revision", key: content });
  cache.put("new", large);
  end();

  assert.deepEqual([cache.get("old") === undefined, cache.get("held") !== undefined, cache.get("new") !== undefined], [true, true, true]);
});

test("above the floor the least recently used entry goes first, whether its key names the content or a request", () => {
  const cache = createSnapshotDataCache("working-set");
  queryAt(cache, () => cache.put("old", { sources: [], output: "a".repeat(3000) }));
  queryAt(cache, () => cache.put(answerKey(1), answer, "request"));
  queryAt(cache, () => undefined);
  queryAt(cache, () => undefined);
  queryAt(cache, () => cache.put(answerKey(2), answer, "request"));

  assert.deepEqual([cache.get("old") === undefined, cache.get(answerKey(1)) !== undefined, cache.get(answerKey(2)) !== undefined], [true, true, true]);
});

test("an answer survives the reads right after it that admit more of the content, and the content no read used since goes before it", () => {
  const cache = createSnapshotDataCache("working-set");
  const facts = (read: number) => ({ sources: [], output: `${read}`.repeat(2000) });
  queryAt(cache, () => {
    cache.put("sources", { sources: [{ path: "a", content: "s".repeat(4000) }] });
    cache.put("callers-facts", facts(1));
    cache.put(answerKey(1), answer, "request");
  });
  for (const read of [2, 3, 4]) {
    queryAt(cache, () => {
      cache.get("sources");
      cache.put(`facts-${read}`, facts(read));
    });
  }

  assert.deepEqual([cache.get(answerKey(1)) !== undefined, cache.get("callers-facts") === undefined], [true, true]);
});

test("a resident tree is charged once, to the latest content that used it, and its release runs once, when the content that last used it left and an admission evicts it", () => {
  const cache = createSnapshotDataCache("working-set");
  const released: string[] = [];
  const read = (content: string, keys: readonly string[]): boolean[] => {
    cache.beginRead({ repository: "/repo", snapshot: "live", key: content });
    return keys.map((key) => cache.reside(key, 100, () => void released.push(key)));
  };
  read("c1", ["unchanged", "edited"]);
  read("c2", ["unchanged", "edited-again"]);
  read("c3", ["unchanged", "edited-again"]);
  read("c4", ["unchanged", "edited-again"]);

  assert.equal(cache.usage().floorBytes, 300, "at c2: unchanged and edited-again for c2, edited for c1");
  assert.deepEqual(released, []);
  assert.deepEqual(read("c5", ["unchanged", "edited-again", "edited-once-more"]), [true, true, true]);
  assert.deepEqual(released, ["edited"]);
  read("c6", ["unchanged", "edited-once-more"]);
  assert.deepEqual(released, ["edited"]);
});

test("an explicit cap counts resident trees, evicting the least recently used to admit one, and refuses one larger than itself; zero keeps none", () => {
  const cache = createSnapshotDataCache(150);
  const released: string[] = [];
  const reside = (key: string, bytes: number) => cache.reside(key, bytes, () => void released.push(key));

  assert.deepEqual([reside("a", 100), reside("b", 100), reside("c", 151)], [true, true, false]);
  assert.deepEqual([released, cache.usage().retainedBytes], [["a"], 100]);
  assert.equal(createSnapshotDataCache(0).reside("a", 1, () => assert.fail("never admitted")), false);
});
