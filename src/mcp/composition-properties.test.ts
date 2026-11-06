import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnchorId, EvidenceSet } from "./composition-contract.ts";
import { materializeEvidence, mergeEvidence, validateCompositionReferences } from "./compose-evidence.ts";
import { digest, SetBuilder, sha, SHA_B } from "./compose-evidence-test-sets.testing.ts";

const PATH = "src/OrderController.java";
const place = { path: PATH, line: 10 };

/** Entrypoints: one route whose handler spans 10-20, citing the declaration's place. */
function entrypoints(): { set: EvidenceSet; handler: AnchorId } {
  const builder = new SetBuilder("entrypoints", { family: "entrypoints" }, sha("shop"));
  const handler = builder.anchor(builder.file(PATH), "com.shop.OrderController.create", 10, 20);
  const evidence = builder.evidence(place);
  builder.part({ kind: "entrypoint", entry: { kind: "http-route", name: "POST /orders", method: "POST", path: "/orders", handler, basePath: { status: "unknown", reason: "unresolved", evidence: [] } }, evidence: [evidence] });
  return { set: builder.build(), handler };
}

/** Outline: the declaration the handler joins, and the same place as evidence. */
function outline(): EvidenceSet {
  const builder = new SetBuilder("outline", { family: "outline" }, sha("shop"));
  builder.part({ kind: "outline-declaration", anchor: builder.anchor(builder.file(PATH), "create", 10, 20), kindName: "method" });
  builder.part({ kind: "unknown-finding", reason: "unresolved", evidence: [builder.evidence(place)] });
  return builder.build();
}

/** A second outline read of the same snapshot: the same declaration plus a nested one that makes the join ambiguous. */
function nestedOutline(): EvidenceSet {
  const builder = new SetBuilder("outline-nested", { family: "outline" }, sha("shop"), { scopeInclude: ["src/**"] });
  const file = builder.file(PATH);
  builder.part({ kind: "outline-declaration", anchor: builder.anchor(file, "create", 10, 20), kindName: "method" });
  builder.part({ kind: "outline-declaration", anchor: builder.anchor(file, "create", 11, 20), kindName: "method" });
  return builder.build();
}

/** Impact: the handler as a diff seed and a caller depending on it. */
function impact(): EvidenceSet {
  const builder = new SetBuilder("impact", { family: "impact", branch: "local" }, sha("shop"));
  const file = builder.file(PATH);
  builder.part({ kind: "seed", anchor: builder.anchor(file, "create", 10, 20), basis: "lines", comparison: { status: "available", value: { repo: "shop", mergeBase: SHA_B, head: builder.snapshot } } });
  builder.part({ kind: "symbol-reach", anchor: builder.anchor(builder.file("src/Job.java"), "run", 3, 9), kindName: "method", depth: 1, confidence: 1, fanIn: 1, via: { target: { file, symbol: "create" }, lines: [5], basis: "call" } });
  builder.evidence(place);
  return builder.build();
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

const fold = (sets: readonly EvidenceSet[]): EvidenceSet => sets.slice(1).reduce(mergeEvidence, sets[0]!);

test("the sets overlap for real: shared files, anchors, parts and evidence", () => {
  const merged = fold([entrypoints().set, outline(), nestedOutline(), impact()]);
  assert.equal(merged.files.find((file) => file.path === PATH)?.supports.length, 4, "one file, appearing in every source");
  assert.equal(merged.evidence.length, 1, "one place cited by three sources");
  assert.equal(new Set(merged.evidence[0]?.supports.map((support) => support.source)).size, 3);
  const declaration = merged.parts.find((part) => part.kind === "outline-declaration" && merged.anchors.find((anchor) => anchor.id === part.anchor)?.line === 10);
  assert.equal(declaration?.supports.length, 2, "two outline reads report the same declaration");
});

test("merge is commutative, associative and idempotent", () => {
  const sets = [entrypoints().set, outline(), nestedOutline(), impact()];
  for (const a of sets) {
    assert.deepEqual(mergeEvidence(a, a), a, "merge(A,A) = A");
    for (const b of sets) {
      assert.deepEqual(mergeEvidence(a, b), mergeEvidence(b, a), "merge(A,B) = merge(B,A)");
      assert.deepEqual(mergeEvidence(mergeEvidence(a, b), b), mergeEvidence(a, b), "a repeated query adds nothing");
      for (const c of sets) assert.deepEqual(mergeEvidence(mergeEvidence(a, b), c), mergeEvidence(a, mergeEvidence(b, c)), "both parenthesizations agree");
    }
  }
});

test("every order of union materializes the same composition", () => {
  const sets = [entrypoints().set, outline(), nestedOutline(), impact()];
  const reference = materializeEvidence(fold(sets), digest);
  assert.deepEqual(validateCompositionReferences(reference.graph), { ok: true, value: undefined });
  assert.ok(reference.graph.relations.length > 0 && reference.issues.length > 0, "the composition is not trivially empty");
  for (const order of permutations(sets)) {
    assert.deepEqual(materializeEvidence(fold(order), digest), reference);
    assert.deepEqual(materializeEvidence(fold([...order, ...order]), digest), reference, "duplicated sources change nothing");
  }
});

test("a third source that makes the join ambiguous wins in every order; no first-arrival alias survives", () => {
  const { set, handler } = entrypoints();
  const before = materializeEvidence(mergeEvidence(set, outline()), digest);
  const bound = before.graph.bindings.find((binding) => binding.anchor === handler)?.binding;
  assert.equal(bound?.status, "resolved");
  assert.equal(before.graph.connections.filter((connection) => connection.rule === "handler-declaration").length, 1);
  for (const order of permutations([set, outline(), nestedOutline()])) {
    const after = materializeEvidence(fold(order), digest);
    assert.deepEqual(after.graph.bindings.find((binding) => binding.anchor === handler)?.binding, { status: "unresolved", anchor: handler, reason: "ambiguous" });
    assert.equal(after.graph.connections.filter((connection) => connection.rule === "handler-declaration").length, 0);
    assert.ok(after.issues.some((issue) => issue.kind === "ambiguous-declaration" && issue.anchor === handler && issue.candidates.length === 2));
  }
});
