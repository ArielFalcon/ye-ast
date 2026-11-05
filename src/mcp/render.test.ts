import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEntrypointMap, renderImpact, renderWorkspaceImpact } from "./render.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";

const base = { schema: "0.12.0", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
const cut = { kind: "depth", at: ["anchor", "place"], limit: 2 };
const impact = { seeds: [], symbols: [], cost: { expansionsUsed: 0 }, entrypoints: [{ kind: "job", name: "job", handler: { path: "src/h.ts", symbol: "run", line: 7 }, depth: 1, confidence: 1, seeds: [] }], modules: { origins: [], modules: [{ file: "src/m.ts", snapshot: "base", depth: 0, origins: [] }], cost: { expansionsUsed: 0 } } };

test("finding positions distinguish repeated object references in grouped text", () => {
  const finding = { ...base, status: "complete", value: { kind: "ui-route", name: "a very long route name", path: "/route", component: "unknown", guards: [] } };
  const fact = { ...base, status: "complete", value: { entrypoints: { ...base, status: "partial", cuts: [cut], value: [finding, finding] } } } as unknown as Fact<EntrypointMap>;
  for (const mode of ["summary", "details"] as const) {
    const text = renderEntrypointMap(fact, mode);
    assert.match(text, /findingIndex 0/); assert.match(text, /findingIndex 1/);
    assert.ok(text.includes('"owner":{"kind":"entrypoints"},"cutIndex":0'));
  }
});

test("local and workspace rows expose exact owners and public cut positions", () => {
  const local = { ...base, status: "partial", cuts: [cut], value: impact } as unknown as Fact<ImpactValue>;
  const text = renderImpact(local);
  assert.ok(text.includes('"owner":{"kind":"local"},"handler":{"path":"src/h.ts","symbol":"run","line":7}'));
  assert.ok(text.includes('"owner":{"kind":"local"},"module":{"file":"src/m.ts","snapshot":"base"}'));
  assert.ok(text.includes('"owner":{"kind":"fact"},"cutIndex":0'));
  const section = { ...base, status: "partial", cuts: [cut], value: { impact, reads: [{ kind: "trigger", fact: { ...base, status: "partial", cuts: [cut] } }], callSites: [], unmatched: [], external: [] } };
  const link = { id: "actual-id", from: { repo: "other", file: "f", line: 1, symbol: "s" }, to: { repo: "shop", kind: "job", name: "job", handler: impact.entrypoints[0]!.handler }, basis: "exact", confidence: 1 };
  const workspace = { ...base, status: "partial", cuts: [cut], value: { workspace: { repos: ["shop"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: "shop" }, sections: { shop: section }, links: [{ link, direction: "upstream", reach: [] }] } } as unknown as Fact<WorkspaceImpactValue>;
  const ws = renderWorkspaceImpact(workspace);
  assert.ok(ws.includes('"owner":{"kind":"section","repo":"shop"},"handler"'));
  assert.ok(ws.includes('"owner":{"kind":"section","repo":"shop"},"module"'));
  assert.ok(ws.includes('"owner":{"kind":"section","repo":"shop"},"cutIndex":0'));
  assert.ok(ws.includes('"owner":{"kind":"read","repo":"shop","index":0},"cutIndex":0'));
  assert.ok(ws.includes('[linkId "actual-id"]'));
});
