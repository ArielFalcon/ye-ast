import { strict as assert } from "node:assert";
import { test } from "node:test";
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
  assert.deepEqual(facts.drain(), { hits: 0, misses: 3, admitted: 3, admittedBytes: 3 * charge, evicted: 2, skipped: 0, factBytes: charge, retainedBytes: charge });
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
  assert.deepEqual(facts.drain(), { hits: 2, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: first.factBytes, retainedBytes: first.retainedBytes });
});
