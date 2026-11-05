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
  assert.match(text, /"resultIdentity":"identity"/);
  assert.match(text, /"revision":"sha"/);
});

test("renders unavailable evidence without inventing an empty page", () => {
  const records = { source, availability: "unavailable", reason: "unresolved", evidence: [{ source: "actual" }] } as unknown as EvidenceSelectionResult;
  const text = renderEvidenceSelection({ select: { kind: "entrypoint-evidence", findingIndex: 0 }, records, recovery: { version: 1, status: "unavailable", reason: "deadline" } });
  assert.match(text, /"source":"actual"/);
  assert.match(text, /unresolved/);
  assert.doesNotMatch(text, /Page:/);
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
  assert.match(text, /"changed":\["src\/\*\*"\]/);
});

test("full selection guides the complete structured page without serializing its records twice", () => {
  const records = { source, availability: "available", kind: "cut-places", context: { owner: { kind: "fact" }, snapshot: source.snapshot, analysis: { status: "partial" }, cutIndex: 2, kind: "depth", anchor: "anchor" }, items: [{ atIndex: 2, place: "unique-place" }] } as EvidenceSelectionResult;
  const recovery = { version: 1 as const, status: "available" as const, resultIdentity: "identity", query: { name: "ye_ast_callers" as const, arguments: { revision: "sha" } } };
  const text = renderEvidenceSelection({ mode: "full", select: { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 2 }, records, page: { limit: 1, offset: 1, returned: 1, total: 2, nextCursor: "next" }, recovery });
  assert.match(text, /structuredContent.*source/);
  assert.match(text, /structuredContent.*context.*items.*page/);
  assert.match(text, /"limit":3/);
  assert.match(text, /"nextCursor":"next"/);
  assert.match(text, /"resultIdentity":"identity"/);
  assert.doesNotMatch(text, /unique-place/);
});

test("full guide does not serialize source reads twice and distinguishes unavailable pages", () => {
  const records = { source: { ...source, reads: [{ marker: "unique-source-read" }] }, availability: "unavailable", reason: "unresolved", evidence: [{ path: "a", line: 1 }] } as unknown as EvidenceSelectionResult;
  const text = renderEvidenceSelection({ mode: "full", select: { kind: "entrypoint-evidence", findingIndex: 0 }, records, recovery: { version: 1, status: "unavailable", reason: "unresolved-context" } });
  assert.doesNotMatch(text, /unique-source-read/);
  assert.doesNotMatch(text, /context, items and page/);
  assert.match(text, /structuredContent\.evidence/);
  assert.match(text, /"limit":3/);
  assert.match(text, /unresolved/);
});
