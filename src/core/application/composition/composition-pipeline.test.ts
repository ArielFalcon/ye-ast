import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "./compose-evidence-test-sets.testing.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { sourceFixture } from "./composition-fixtures.testing.ts";
import { normalizeSource } from "./composition-normalize.ts";
import { mergeEvidence, materializeEvidence, validateCompositionReferences } from "./compose-evidence.ts";
import type { EvidenceSet } from "../../ports/evidence-composition.port.ts";

const sources = [
  sourceFixture("entrypoints"), sourceFixture("impact-local"), sourceFixture("callers-local"),
  sourceFixture("importers"), sourceFixture("outline"), sourceFixture("workspace"), sourceFixture("decisions"),
  sourceFixture("impact-workspace"), sourceFixture("callers-workspace"), sourceFixture("trace"),
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
  assert.equal(result.graph.sources.length, 10);
  assert.ok(result.graph.relations.length > 0);
  assert.ok(result.graph.connections.length > 0);
});

test("all seven normalized families have identical composition in every rotation of their input order and its reverse", () => {
  const sets = sources.slice(0, 7).map((source) => normalizeSource(source, digest));
  const expected = canonicalJson(compose(sets));
  const rotations = sets.map((_, start) => [...sets.slice(start), ...sets.slice(0, start)]);
  for (const order of [...rotations, ...rotations.map((rotation) => [...rotation].reverse())]) assert.equal(canonicalJson(compose(order)), expected);
  assert.equal(canonicalJson(compose([...sets, ...sets])), expected, "duplicate sources add no semantic information");
});
