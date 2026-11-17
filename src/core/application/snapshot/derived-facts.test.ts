import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DerivedFactDisk, DerivedFactStore } from "../../ports/derived-fact-store.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import { createDerivedFacts } from "./derived-facts.ts";
import { createSnapshotDataCache } from "./snapshot-data-cache.ts";

const digest: Digest = { of: (text) => `digest(${text})` };
const FILE = { path: "src/a.ts", content: "export const a = 1;\n" };
const BUDGET = 1 << 20;

function counting<T>(value: T): { derive: () => T; derived: () => number } {
  let count = 0;
  return { derive: () => (count++, value), derived: () => count };
}

test("a fact kept for a file answers the value a derivation answered, without deriving again", () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  const { derive, derived } = counting({ starts: [3, 1], absent: undefined });

  const first = facts.ofFile("slot", FILE, derive);
  const second = facts.ofFile("slot", { ...FILE }, derive);

  assert.equal(derived(), 1);
  assert.deepEqual(first, { starts: [3, 1] });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("another content, path, slot or trust derives again", () => {
  const cache = createSnapshotDataCache(BUDGET);
  const facts = createDerivedFacts(cache, digest, "untrusted");
  facts.ofFile("slot", FILE, () => 1);

  for (const [view, slot, file] of [
    [facts, "slot", { ...FILE, content: "export const a = 2;\n" }],
    [facts, "slot", { ...FILE, path: "src/b.ts" }],
    [facts, "other", FILE],
    [createDerivedFacts(cache, digest, "trusted"), "slot", FILE],
  ] as const) {
    const { derive, derived } = counting(2);
    assert.equal(view.ofFile(slot, file, derive), 2);
    assert.equal(derived(), 1, JSON.stringify([slot, file]));
  }
});

test("a derivation that fails keeps nothing", async () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  assert.throws(() => facts.ofFile("slot", FILE, () => { throw new Error("cut"); }));
  await assert.rejects(facts.ofInputs("slot", { at: 1 }, async () => { throw new Error("cut"); }));

  const file = counting(1);
  facts.ofFile("slot", FILE, file.derive);
  const inputs = counting(1);
  await facts.ofInputs("slot", { at: 1 }, async () => inputs.derive());

  assert.equal(file.derived(), 1);
  assert.equal(inputs.derived(), 1);
});

test("a fact kept for inputs answers the inputs it was kept for only", async () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  const { derive, derived } = counting({ file: "src/b.ts" });

  await facts.ofInputs("slot", { from: "src", specifier: "./b" }, async () => derive());
  assert.deepEqual(await facts.ofInputs("slot", { specifier: "./b", from: "src" }, async () => derive()), { file: "src/b.ts" });
  assert.equal(derived(), 1);
  await facts.ofInputs("slot", { from: "src", specifier: "./c" }, async () => derive());
  assert.equal(derived(), 2);
});

test("facts share the snapshot data budget: the least recently used is evicted, and a zero budget keeps none", () => {
  const sized = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  sized.ofFile("slot", FILE, () => [1]);
  const charge = sized.drain().admittedBytes;
  const facts = createDerivedFacts(createSnapshotDataCache(charge), digest, "untrusted");
  const other = { ...FILE, path: "src/b.ts" };

  facts.ofFile("slot", FILE, () => [1]);
  facts.ofFile("slot", other, () => [1]);
  const { derive, derived } = counting([1]);
  facts.ofFile("slot", FILE, derive);

  assert.equal(derived(), 1);
  assert.deepEqual(facts.drain(), { hits: 0, misses: 3, diskHits: 0, admitted: 3, admittedBytes: 3 * charge, evicted: 2, skipped: 0, factBytes: charge, retainedBytes: charge });
  const disabled = createDerivedFacts(createSnapshotDataCache(0), digest, "untrusted");
  const twice = counting([1]);
  disabled.ofFile("slot", FILE, twice.derive);
  disabled.ofFile("slot", FILE, twice.derive);
  assert.equal(twice.derived(), 2);
});

test("drain answers what a view did since the previous drain", () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  facts.ofFile("slot", FILE, () => 1);
  const first = facts.drain();
  facts.ofFile("slot", FILE, () => 1);
  facts.ofFile("slot", FILE, () => 1);

  assert.deepEqual([first.hits, first.misses, first.admitted], [0, 1, 1]);
  assert.deepEqual(facts.drain(), { hits: 2, misses: 0, diskHits: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: first.factBytes, retainedBytes: first.retainedBytes });
});

function memoryStore(): DerivedFactStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return { entries, read: (key) => entries.get(key), write: (key, json) => void entries.set(key, json) };
}

function viewOver(disk: DerivedFactDisk, trust: "trusted" | "untrusted" = "untrusted") {
  return createDerivedFacts(createSnapshotDataCache(BUDGET), digest, trust, disk);
}

test("a new view over the same store answers a stored fact without deriving, whatever the trust that stored it", async () => {
  const disk = { store: memoryStore(), versions: { slot: "1", aggregate: "1" } };
  const value = { starts: [3, 1], absent: undefined };
  viewOver(disk, "untrusted").ofFile("slot", FILE, () => value);
  await viewOver(disk, "untrusted").ofInputs("aggregate", { at: 1 }, async () => value);

  const file = counting(value);
  const inputs = counting(value);
  const trusted = viewOver(disk, "trusted");
  const first = trusted.ofFile("slot", { ...FILE }, file.derive);
  const second = await trusted.ofInputs("aggregate", { at: 1 }, async () => inputs.derive());

  assert.deepEqual([file.derived(), inputs.derived()], [0, 0]);
  assert.equal(JSON.stringify(first), JSON.stringify(value));
  assert.equal(JSON.stringify(second), JSON.stringify(value));
  const tally = trusted.drain();
  assert.deepEqual([tally.hits, tally.diskHits], [2, 2]);
});

test("a stored fact answers the content and the version it was stored for only", () => {
  const store = memoryStore();
  viewOver({ store, versions: { slot: "1" } }).ofFile("slot", FILE, () => 1);

  for (const [versions, file] of [
    [{ slot: "2" }, FILE],
    [{ slot: "1" }, { ...FILE, content: "export const a = 2;\n" }],
    [{ slot: "1" }, { ...FILE, path: "src/b.ts" }],
  ] as const) {
    const { derive, derived } = counting(2);
    assert.equal(viewOver({ store, versions }).ofFile("slot", file, derive), 2);
    assert.equal(derived(), 1, JSON.stringify([versions, file]));
  }
});

test("a slot with no version, a derivation that fails and a value with no JSON are never stored", async () => {
  const disk = { store: memoryStore(), versions: { slot: "1" } };
  const facts = viewOver(disk);

  facts.ofFile("unversioned", FILE, () => 1);
  assert.throws(() => facts.ofFile("slot", FILE, () => { throw new Error("cut"); }));
  await assert.rejects(facts.ofInputs("slot", { at: 1 }, async () => { throw new Error("cut"); }));
  facts.ofFile("slot", FILE, () => undefined);

  assert.deepEqual([...disk.store.entries], []);
});

test("a stored fact is counted as a hit of the disk tier and is then held in memory", () => {
  const disk = { store: memoryStore(), versions: { slot: "1" } };
  viewOver(disk).ofFile("slot", FILE, () => [1]);
  const facts = viewOver(disk);

  facts.ofFile("slot", FILE, () => [2]);
  facts.ofFile("slot", FILE, () => [3]);

  const tally = facts.drain();
  assert.deepEqual([tally.hits, tally.misses, tally.diskHits, tally.admitted], [2, 0, 1, 1]);
});

test("a derivation is kept until an answer it recorded differs, and then replaced by the new one", async () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  let world = { declaring: '["a/A.java"]', file: "h1" };
  const answerNow = (question: string): string => (question === "declaring|A" ? world.declaring : world.file);
  let derivations = 0;
  const derive = async (record: (question: string, answer: string) => void) => {
    derivations++;
    record("declaring|A", answerNow("declaring|A"));
    record("file|a/A.java", answerNow("file|a/A.java"));
    return { derived: derivations };
  };

  assert.deepEqual(await facts.ofReads("slot", { path: "b" }, answerNow, derive), { derived: 1 });
  assert.deepEqual(await facts.ofReads("slot", { path: "b" }, answerNow, derive), { derived: 1 });
  world = { ...world, file: "h2" };
  assert.deepEqual(await facts.ofReads("slot", { path: "b" }, answerNow, derive), { derived: 2 });
  assert.deepEqual(await facts.ofReads("slot", { path: "b" }, answerNow, derive), { derived: 2 });
  assert.equal(derivations, 2);
  assert.deepEqual({ hits: facts.drain().hits }, { hits: 2 });
});

test("a question that answered nothing is recorded, so an answer that appears is a difference", async () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  let declared: string[] = [];
  const answerNow = () => JSON.stringify(declared);
  const counted = counting("v");

  const read = () => facts.ofReads("slot", { path: "b" }, answerNow, async (record) => (record("declaring|Missing", answerNow()), counted.derive()));
  await read();
  await read();
  assert.equal(counted.derived(), 1);
  declared = ["c/Missing.java"];
  await read();
  assert.equal(counted.derived(), 2);
});

test("an answer longer than the inline bound is compared whole, and another subject keeps its own entry", async () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  const long = (tail: string) => `${"x".repeat(80)}${tail}`;
  let tail = "a";
  const counted = counting("v");
  const read = (subject: object) => facts.ofReads("slot", subject, () => long(tail), async (record) => (record("q", long(tail)), counted.derive()));

  await read({ path: "one" });
  await read({ path: "one" });
  assert.equal(counted.derived(), 1);
  tail = "b";
  await read({ path: "one" });
  assert.equal(counted.derived(), 2);
  await read({ path: "two" });
  assert.equal(counted.derived(), 3);
});

test("a derivation that throws keeps nothing for ofReads", async () => {
  const facts = createDerivedFacts(createSnapshotDataCache(BUDGET), digest, "untrusted");
  await assert.rejects(facts.ofReads("slot", { path: "a" }, () => "1", async (record) => { record("q", "1"); throw new Error("cut"); }));
  const counted = counting("v");
  await facts.ofReads("slot", { path: "a" }, () => "1", async () => counted.derive());
  assert.equal(counted.derived(), 1);
});

function readsOver(disk: DerivedFactDisk, world: { answers: Record<string, string> }, slot = "slot", subject: object = { path: "a" }) {
  const facts = viewOver(disk);
  let derived = 0;
  const answerNow = (question: string): string => world.answers[question] ?? "[]";
  const read = () => facts.ofReads(slot, subject, answerNow, async (record) => {
    derived++;
    record("declaring|A", answerNow("declaring|A"));
    return { derived };
  });
  return { facts, read, derived: () => derived };
}

test("a derivation stored on disk answers a new view while its recorded answers hold, and is replaced by the one derived when an answer differs", async () => {
  const disk = { store: memoryStore(), versions: { slot: "1" } };
  const world = { answers: { "declaring|A": '["a/A.java"]' } };
  const first = readsOver(disk, world);
  assert.deepEqual(await first.read(), { derived: 1 });
  assert.equal(disk.store.entries.size, 1);

  const warm = readsOver(disk, world);
  assert.deepEqual(await warm.read(), { derived: 1 });
  assert.equal(warm.derived(), 0);
  const tally = warm.facts.drain();
  assert.deepEqual([tally.hits, tally.misses, tally.diskHits], [1, 0, 1]);

  const moved = { answers: { "declaring|A": '["a/A.java","b/A.java"]' } };
  const changed = readsOver(disk, moved);
  assert.deepEqual(await changed.read(), { derived: 1 });
  assert.equal(changed.derived(), 1);
  assert.equal(disk.store.entries.size, 1);
  const after = readsOver(disk, moved);
  await after.read();
  assert.equal(after.derived(), 0);
});

test("a derivation stored on disk answers its reader version and its subject only", async () => {
  const store = memoryStore();
  const world = { answers: { "declaring|A": "[]" } };
  await readsOver({ store, versions: { slot: "1" } }, world).read();
  for (const [versions, subject] of [[{ slot: "2" }, { path: "a" }], [{ slot: "1" }, { path: "b" }]] as const) {
    const other = readsOver({ store, versions }, world, "slot", subject);
    await other.read();
    assert.equal(other.derived(), 1, JSON.stringify([versions, subject]));
  }
});

test("a derivation of a slot with no version, and one that throws, are never stored", async () => {
  const disk = { store: memoryStore(), versions: { slot: "1" } };
  await readsOver(disk, { answers: {} }, "unversioned").read();
  await assert.rejects(viewOver(disk).ofReads("slot", { path: "a" }, () => "[]", async (record) => { record("q", "[]"); throw new Error("cut"); }));
  assert.deepEqual([...disk.store.entries], []);
});
