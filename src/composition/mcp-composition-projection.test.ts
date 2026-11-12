import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { entrypointsValue, factOf, inputsOf, sourceFixture } from "../core/application/composition/composition-fixtures.testing.ts";
import { normalizeSource } from "../core/application/composition/composition-normalize.ts";
import { materializeEvidence, mergeEvidence } from "../core/application/composition/compose-evidence.ts";
import { renderComposition } from "../mcp/render-composition.ts";
import type { CompositionResult } from "../mcp/composition-contract.ts";

const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
function focused(selected: boolean): CompositionResult {
  const value = { focus: [{ file: "src/Api.ts", selector: "get", path: "get", ancestors: [], declaration: { kind: "method" as const, name: "get", line: 10, endLine: 20 }, omitted: 0 }], unheld: [] };
  const source = sourceFixture("outline", { fact: factOf(value, { inputs: inputsOf({ declaredConfig: selected ? { focus: ["src/Api.ts:get"] } : {} }) }) });
  const { graph, issues } = materializeEvidence(normalizeSource(source, digest), digest);
  return {
    graph: { ...graph, sources: graph.sources.map((s) => ({ ...s, requestIndex: 0 })) },
    coverage: { reads: { complete: graph.reads.length, partial: 0, unknown: 0 }, unknowns: [], limits: [], issues },
    counts: { sources: 1, reads: graph.reads.length, files: graph.files.length, anchors: graph.anchors.length, entities: graph.entities.length, evidence: graph.evidence.length, parts: graph.parts.length, relations: graph.relations.length, connections: graph.connections.length, unknownFindings: 0, unknownComponents: 0 },
    verification: { status: "available", identity: `mcp-c1:${"a".repeat(64)}` }, requests: [],
  } as CompositionResult;
}

test("focused unjoined declarations retain actionable coordinates while enumeration stays counted", () => {
  const selected = renderComposition(focused(true), "summary");
  assert.match(selected, /S1[^\n]*focus src\/Api.ts:get/);
  assert.match(selected, /src\/Api.ts[\s\S]*10-20 get/);
  assert.doesNotMatch(renderComposition(focused(false), "summary"), /10-20 get/);
  const unbound = focused(true);
  unbound.graph = { ...unbound.graph, bindings: unbound.graph.bindings.map(({ anchor }) => ({ anchor, binding: { status: "unresolved", anchor, reason: "ambiguous" } })) };
  assert.match(renderComposition(unbound, "summary"), /10-20 get \(unbound: ambiguous\) method \[outline S1\]/);
});


test("focused declarations retain proven uses and unproved uses on their coordinate row", () => {
  const result = focused(true);
  result.graph = { ...result.graph, parts: result.graph.parts.map((part) => part.kind === "outline-declaration" ? { ...part, uses: [{ module: "rxjs", relations: ["references"], at: [] }], unproved: true } : part) };
  for (const mode of ["summary", "details"] as const) {
    const text = renderComposition(result, mode);
    const row = text.split("\n").filter((line) => line.includes("10-20 get"));
    assert.equal(row.length, 1);
    assert.match(row[0]!, /rxjs.*unproven/);
  }
  result.graph = { ...result.graph, bindings: result.graph.bindings.map(({ anchor }) => ({ anchor, binding: { status: "unresolved", anchor, reason: "ambiguous" } })) };
  assert.match(renderComposition(result, "summary"), /10-20 get[^\n]*rxjs[^\n]*unproven/);
});


test("shared support preserves nontransitive compatibility and causal connections", () => {
  const base = focused(true);
  const place = { path: "src/common.ts", line: 7 };
  const engines = [{ ts: "1" }, {}, { ts: "2" }];
  const sets = engines.map((engine, index) => {
    const findings = [{ status: "unknown" as const, reason: (["unresolved", "out-of-scope", "source-unreadable"] as const)[index]!, evidence: [place] }];
    const value = { ...entrypointsValue(), entrypoints: factOf(findings, { inputs: inputsOf({ engines: engine }) }) };
    return normalizeSource(sourceFixture("entrypoints", { value, arguments: { repo: "shop", revision: "a".repeat(40), scope: { include: [`src/${index}`] } } }), digest);
  });
  const { graph: raw, issues } = materializeEvidence(sets.slice(1).reduce(mergeEvidence, sets[0]!), digest);
  const relation = raw.relations.find((item) => item.value.kind === "shares-evidence")!;
  const shared = raw.connections.filter((item) => item.rule === "shared-support" && item.relations.includes(relation.id));
  assert.equal(shared.length, 2);
  const versions = new Map(raw.reads.map((read) => [read.id, read.inputs.engines.ts]));
  assert.deepEqual(shared.map((item) => item.supports.map((support) => versions.get(support.read)).filter(Boolean).join(",")).toSorted(), ["1", "2"]);
  const causal = { ...shared[0]!, id: "c1:causal" as const, rule: "change-dependent" as const };
  const graph = { ...raw, sources: raw.sources.map((source, requestIndex) => ({ ...source, requestIndex })), connections: [...shared, causal] };
  const result: CompositionResult = { ...base, graph, coverage: { ...base.coverage, issues } };
  const summary = renderComposition(result, "summary");
  assert.match(summary, /Shared support.*compatibility per connection, not transitive.*details.*one-based graph\.connections/);
  assert.equal(summary.match(/Shared support:/g)?.length, 1);
  assert.match(summary, /^L\d+ → C1,C2$/m);
  assert.match(summary, /C3 = change-dependent/);
  const details = renderComposition(result, "details");
  assert.match(details, /C1 = shared-support/);
  assert.match(details, /C2 = shared-support/);
});
