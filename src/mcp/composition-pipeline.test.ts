import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { sourceFixture } from "./composition-fixtures.testing.ts";
import { normalizeSource } from "./composition-normalize.ts";
import { mergeEvidence, materializeEvidence, validateCompositionReferences } from "./compose-evidence.ts";
import type { EvidenceSet } from "./composition-contract.ts";

const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
const sources = [
  sourceFixture("entrypoints"), sourceFixture("impact-local"), sourceFixture("callers-local"),
  sourceFixture("importers"), sourceFixture("outline"), sourceFixture("workspace"), sourceFixture("decisions"),
  sourceFixture("impact-workspace"), sourceFixture("callers-workspace"),
];

function compose(sets: readonly EvidenceSet[]) {
  const first = sets[0];
  assert.ok(first);
  const result = materializeEvidence(sets.slice(1).reduce(mergeEvidence, first), digest);
  assert.deepEqual(validateCompositionReferences(result.graph), { ok: true, value: undefined });
  return result;
}

test("normalizer and materializer agree on every public family and workspace branch", () => {
  for (const source of sources) {
    const result = compose([normalizeSource(source, digest)]);
    assert.equal(result.graph.sources[0]?.family, source.family);
    const decisions = result.graph.parts.filter((part) => part.kind === "decision");
    for (const decision of decisions) assert.ok(decision.decisionId);
  }
  const result = compose(sources.map((source) => normalizeSource(source, digest)));
  assert.equal(result.graph.sources.length, 9);
  assert.ok(result.graph.relations.length > 0);
  assert.ok(result.graph.connections.length > 0);
});

test("all seven normalized families have identical composition in all 5040 input permutations", () => {
  const sets = sources.slice(0, 7).map((source) => normalizeSource(source, digest));
  const expected = canonicalJson(compose(sets));
  let checked = 0;
  function visit(prefix: readonly EvidenceSet[], remaining: readonly EvidenceSet[]): void {
    if (remaining.length === 0) {
      assert.equal(canonicalJson(compose(prefix)), expected);
      checked++;
      return;
    }
    remaining.forEach((set, index) => visit([...prefix, set], remaining.filter((_, other) => other !== index)));
  }
  visit([], sets);
  assert.equal(checked, 5040);
  assert.equal(canonicalJson(compose([...sets, ...sets])), expected, "duplicate sources add no semantic information");
});
