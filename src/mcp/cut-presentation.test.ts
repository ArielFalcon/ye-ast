import { test } from "node:test";
import assert from "node:assert/strict";
import { renderImpact, renderImporters } from "./render.ts";
import { SCHEMA, type Fact, type Cut } from "../core/domain/shared/fact.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";

const base = { schema: SCHEMA, snapshot: { repo: "repo", kind: "sha" as const, sha: "abc" }, producer: { name: "test", version: "1" }, inputs: { trust: "untrusted" as const, scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "c", declaredConfig: {}, engines: {} }, evidence: [] };
const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };
const longAnchor = (index: number) => `src/features/very-long-repository-relative-path/consumer-${index}.ts::Consumer.load`;
const makeCut = (index: number): Cut => ({ kind: "unresolved-link", at: [longAnchor(index), `src/reference.ts:${index + 1} reason-${index}`], limit: index, reason: "callee-unknown", reach: { kind: "anything" } });

test("detailed cut rows bind original indices, anchors, limits and reasons with their recorded places", () => {
  const first = makeCut(0);
  const cuts: [Cut, ...Cut[]] = [first, makeCut(1), { ...first, at: [first.at[0]!, "src/other.ts:8 different-reason"], limit: 17 }, ...Array.from({ length: 9 }, (_, i) => makeCut(i + 2)), { kind: "depth", at: ["base:same.ts::f"], limit: 2, reason: "depth", reach: { kind: "anything" } }, { kind: "hub", at: ["head:same.ts::f"], limit: 300, reason: "hub", reach: { kind: "anything" } }];
  const fact: Fact<ImpactValue> = { ...base, status: "partial", cuts, value };
  const before = structuredClone(fact);
  const text = renderImpact(fact, "details");
  const coordinates = [...text.matchAll(/cutIndex (\d+) \(anchor (".*")\)/g)].map(([, index, anchor]) => ({ cutIndex: Number(index), anchor: JSON.parse(anchor!) }));
  assert.deepEqual(coordinates, cuts.map((cut, cutIndex) => ({ cutIndex, anchor: cut.at[0] })));
  for (const cut of cuts) {
    assert.ok(text.includes(`limit ${cut.limit}`));
    for (const place of cut.at) assert.ok(text.includes(place));
  }
  assert.deepEqual(fact, before);
});

test("unavailable recovery retains indexed cut context without promising a selectable lookup", () => {
  const cuts: [Cut, ...Cut[]] = [makeCut(0), ...Array.from({ length: 11 }, (_, i) => makeCut(i + 1))];
  const fact: Fact<ImpactValue> = { ...base, status: "partial", cuts, value };
  const text = renderImpact(fact, "details", { tool: "impact", recovery: { version: 1, status: "unavailable", reason: "redacted-context" } });
  assert.match(text, /Recorded cut context: \{"kind":"cut-places","owner":\{"kind":"fact"\}\}/);
  assert.doesNotMatch(text, /Cut lookup:/);
  assert.ok(text.includes(longAnchor(0)));
  assert.equal([...text.matchAll(/^\s+cutIndex \d+/gm)].length, 12);
});


test("tiny cut categories retain their limit, place and executable selector", () => {
  const fact: Fact<ImpactValue> = { ...base, status: "partial", cuts: [{ kind: "depth", at: ["x"], limit: 1, reason: "depth", reach: { kind: "anything" } }], value };
  const text = renderImpact(fact, "details");
  assert.match(text, /depth \(limit 1\)\n {4}x/);
  assert.doesNotMatch(text, /includes every place/);
  assert.match(text, /lookup example: \{"kind":"cut-places","owner":\{"kind":"fact"\},"cutIndex":0\}/);
  assert.doesNotMatch(text, /Cut lookup:/);
});

test("a place's path ends at its line, so a path or a reason holding spaces keeps them in every view of its cut", () => {
  const cuts: [Cut, ...Cut[]] = [
    { kind: "unresolved-link", at: ["src/svc.ts::Service.read", "src/my app/a.ts:12 this.svc.read", "src/my app/a.ts:30 this.svc.read"], reason: "hidden-caller", reach: { kind: "anything" } },
    { kind: "unresolved-link", at: ["src/my app/b.ts", "src/my app/b.ts:4 import outside module traversal (offset 9)"], reason: "callee-unknown", reach: { kind: "anything" } },
  ];
  const importers: Fact<ImportersValue> = { ...base, status: "partial", cuts, value: { files: [] } };

  assert.match(renderImporters(importers, "summary"), /unresolved-link hidden-caller/);
  const details = renderImporters(importers, "details");
  for (const place of cuts.flatMap((cut) => cut.at)) assert.ok(details.includes(place), place);
  assert.match(renderImpact({ ...base, status: "partial", cuts, value }, "details"), /^ {4}src\/my app\/b\.ts:4 import outside module traversal \(offset 9\)$/m);
});
