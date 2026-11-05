import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEvidenceSelection } from "./render-evidence.ts";
import type { EvidenceSelectionResult } from "./select-evidence.ts";

const source = {
  schema: "1", snapshot: { repo: "repo", kind: "sha", sha: "abc" },
  producer: {}, inputs: {}, analysis: { status: "partial" }, reads: [],
  limits: [{ owner: { kind: "fact" }, kind: "depth", cuts: 1, places: 2, limit: 3 }],
} as unknown as EvidenceSelectionResult["source"];

test("renders the supplied page without slicing it again and preserves provenance and recovery", () => {
  const records = { source, availability: "available", kind: "cut-places", context: { owner: { kind: "fact" }, snapshot: source.snapshot, analysis: { status: "partial" }, cutIndex: 2, kind: "depth", anchor: "anchor" }, items: [{ atIndex: 2, place: "second" }] } as EvidenceSelectionResult;
  const text = renderEvidenceSelection({ select: { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 2 }, records, page: { limit: 1, offset: 1, returned: 1, total: 2 }, recovery: { version: 1, status: "available", resultIdentity: "identity", query: { name: "ye_ast_callers", arguments: { revision: "sha" } } } });
  assert.match(text, /"place":"second"/);
  assert.match(text, /"anchor":"anchor"/);
  assert.match(text, /"status":"partial"/);
  assert.match(text, /"limit":3/);
  assert.match(text, /structuredContent\.recovery/);
  assert.doesNotMatch(text, /"resultIdentity":/);
  assert.doesNotMatch(text, /"revision":"sha"/);
});

test("renders unavailable evidence without inventing an empty page", () => {
  const records = { source, availability: "unavailable", reason: "unresolved", evidence: [{ source: "actual" }] } as unknown as EvidenceSelectionResult;
  const text = renderEvidenceSelection({ select: { kind: "entrypoint-evidence", findingIndex: 0 }, records, recovery: { version: 1, status: "unavailable", reason: "deadline" } });
  assert.match(text, /"source":"actual"/);
  assert.match(text, /unresolved/);
  assert.doesNotMatch(text, /Page:/);
  assert.match(text, /Recovery unavailable \(deadline\)/);
});

test("preserves a complete UI finding with unknown component and the selected evidence index", () => {
  const records = { source, availability: "available", kind: "entrypoint-evidence", context: { findingIndex: 3, section: { status: "complete" }, finding: { status: "complete", identity: { kind: "ui-route", name: "route", path: "/x", outlet: "main", component: "unknown" } } }, items: [{ evidenceIndex: 4, evidence: { path: "src/ui.ts", line: 12 } }] } as EvidenceSelectionResult;
  const text = renderEvidenceSelection({ select: { kind: "entrypoint-evidence", findingIndex: 3 }, records, page: { limit: 1, offset: 4, returned: 1, total: 5 }, recovery: { version: 1, status: "unavailable", reason: "unresolved-context" } });
  assert.match(text, /"component":"unknown"/);
  assert.match(text, /"outlet":"main"/);
  assert.match(text, /"evidenceIndex":4/);
  assert.match(text, /"status":"complete"/);
});

test("a verified empty base-module page retains its owner, snapshot, and zero total", () => {
  const records = { source, availability: "available", kind: "module-origins", context: { owner: { kind: "section", repo: "other" }, snapshot: { repo: "other", kind: "sha", sha: "base-sha" }, module: { file: "src/base.ts", snapshot: "base", depth: 0 }, originCount: 0 }, items: [] } as EvidenceSelectionResult;
  const text = renderEvidenceSelection({ select: { kind: "module-origins", owner: { kind: "section", repo: "other" }, module: { file: "src/base.ts", snapshot: "base" } }, records, page: { limit: 5, offset: 0, returned: 0, total: 0 }, recovery: { version: 1, status: "available", resultIdentity: "identity", query: { name: "ye_ast_impact", arguments: { repo: "other", base: "base-sha", head: "head-sha", changed: ["src/**"] } } } });
  assert.match(text, /"owner":\{"kind":"section","repo":"other"\}/);
  assert.match(text, /"sha":"base-sha"/);
  assert.match(text, /"total":0/);
  assert.match(text, /Records: \[\]/);
  assert.match(text, /structuredContent\.recovery/);
  assert.doesNotMatch(text, /"changed":/);
});

test("full selection guides the complete structured page without serializing its records twice", () => {
  const records = { source, availability: "available", kind: "cut-places", context: { owner: { kind: "fact" }, snapshot: source.snapshot, analysis: { status: "partial" }, cutIndex: 2, kind: "depth", anchor: "anchor" }, items: [{ atIndex: 2, place: "unique-place" }] } as EvidenceSelectionResult;
  const recovery = { version: 1 as const, status: "available" as const, resultIdentity: "identity", query: { name: "ye_ast_callers" as const, arguments: { revision: "sha" } } };
  const text = renderEvidenceSelection({ mode: "full", select: { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 2 }, records, page: { limit: 1, offset: 1, returned: 1, total: 2, nextCursor: "next" }, recovery });
  assert.match(text, /structuredContent.*source/);
  assert.match(text, /structuredContent.*context.*items.*page/);
  assert.match(text, /"limit":3/);
  assert.match(text, /"nextCursor":"next"/);
  assert.match(text, /structuredContent\.recovery/);
  assert.doesNotMatch(text, /"resultIdentity":/);
  assert.doesNotMatch(text, /unique-place/);
});

test("full guide does not serialize source reads twice and distinguishes unavailable pages", () => {
  const records = { source: { ...source, reads: [{ owner: { kind: "fact" }, snapshot: source.snapshot, producer: { name: "unique-source-read", version: "1" }, inputs: {}, analysis: { status: "complete" } }] }, availability: "unavailable", reason: "unresolved", evidence: [{ path: "a", line: 1 }] } as unknown as EvidenceSelectionResult;
  const text = renderEvidenceSelection({ mode: "full", select: { kind: "entrypoint-evidence", findingIndex: 0 }, records, recovery: { version: 1, status: "unavailable", reason: "unresolved-context" } });
  assert.doesNotMatch(text, /unique-source-read/);
  assert.doesNotMatch(text, /context, items and page/);
  assert.match(text, /structuredContent\.evidence/);
  assert.match(text, /"limit":3/);
  assert.match(text, /unresolved/);
});

test("selected text keeps unknown read coverage but leaves producer catalogs in structured source", () => {
  const contextualSource = { ...source, producer: { name: "unique-heavy-engine-catalog", version: "1" }, analysis: { status: "complete" }, reads: [{ owner: { kind: "section", repo: "other" }, snapshot: source.snapshot, inputs: {}, analysis: { status: "unknown", reason: "index-unavailable" } }] } as unknown as EvidenceSelectionResult["source"];
  const records = { source: contextualSource, availability: "unavailable", reason: "unresolved", evidence: [] } as unknown as EvidenceSelectionResult;
  const before = JSON.stringify(records.source);
  for (const mode of ["summary", "details", "full"] as const) {
    const text = renderEvidenceSelection({ mode, select: { kind: "entrypoint-evidence", findingIndex: 0 }, records, recovery: { version: 1, status: "unavailable", reason: "deadline" } });
    assert.doesNotMatch(text, /unique-heavy-engine-catalog/);
    assert.match(text, /index-unavailable/);
    assert.match(text, /"repo":"other"/);
    assert.match(text, /structuredContent.source/);
  }
  assert.equal(JSON.stringify(records.source), before);
});


test("selected read context inherits exactly and preserves ordered owner-specific overrides", () => {
  const declaredScope = { languages: ["typescript"], frameworks: [], include: ["src/**"], exclude: [] };
  const inputs = { trust: "trusted" as const, scope: "s", declaredScope, content: "c", config: "c", declaredConfig: { walk: { depth: 1 } }, engines: {} };
  const inherited = { owner: { kind: "entrypoints" as const }, schema: source.schema, producer: source.producer, snapshot: source.snapshot, inputs, analysis: { status: "complete" as const } };
  const foreign = { ...inherited, owner: { kind: "section" as const, repo: "other" }, snapshot: { kind: "sha" as const, repo: "other", sha: "foreign-base" }, inputs: { ...inputs, trust: "untrusted" as const, declaredScope: { ...declaredScope, include: ["other/**"] }, declaredConfig: { walk: { depth: 3 } } }, analysis: { status: "unknown" as const, reason: "index-unavailable" as const } };
  const contextualSource = { ...source, inputs, analysis: { status: "complete" as const }, reads: [inherited, foreign, inherited], limits: [{ owner: foreign.owner, kind: "depth" as const, cuts: 2, places: 3, limit: 1 }] };
  const records = { source: contextualSource, availability: "unavailable" as const, reason: "unresolved" as const, evidence: [] };
  const before = structuredClone(records);
  for (const mode of ["summary", "details", "full"] as const) {
    const text = renderEvidenceSelection({ mode, select: { kind: "entrypoint-evidence", findingIndex: 0 }, records, recovery: { version: 1, status: "unavailable", reason: "unresolved-context" } });
    const lines = text.split("\n");
    const reads = lines.filter(line => line.startsWith("  Read: ")).map(line => JSON.parse(line.slice("  Read: ".length)));
    assert.match(text, /Reads inherit source snapshot\/trust\/scope\/config unless explicitly overridden/);
    assert.deepEqual(reads, [
      { owner: { kind: "entrypoints" }, analysis: { status: "complete" } },
      { owner: { kind: "section", repo: "other" }, analysis: { status: "unknown", reason: "index-unavailable" }, snapshot: { kind: "sha", repo: "other", sha: "foreign-base" }, trust: "untrusted", declaredScope: { languages: ["typescript"], frameworks: [], include: ["other/**"], exclude: [] }, declaredConfig: { walk: { depth: 3 } } },
      { owner: { kind: "entrypoints" }, analysis: { status: "complete" } },
    ]);
    const limits = lines.find(line => line.startsWith("Source limits: "))!;
    assert.deepEqual(JSON.parse(limits.slice("Source limits: ".length)), [{ owner: { kind: "section", repo: "other" }, kind: "depth", cuts: 2, places: 3, limit: 1 }]);
  }
  assert.deepEqual(records, before);
});
