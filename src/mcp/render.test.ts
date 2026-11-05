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

test("unknown findings share a file and reason without losing indices and ranges", () => {
  const findings = Array.from({ length: 20 }, (_, i) => ({ status: "unknown" as const, reason: "unresolved", evidence: [{ path: "src/really-long-repeated-path.ts", line: i + 1, endLine: i + 2 }] }));
  const fact = { ...base, status: "complete", value: { entrypoints: { ...base, status: "complete", value: findings } } } as unknown as Fact<EntrypointMap>;
  for (const mode of ["summary", "details"] as const) {
    const text = renderEntrypointMap(fact, mode);
    assert.equal(text.split("src/really-long-repeated-path.ts").length - 1, 1);
    for (let i = 0; i < 20; i++) assert.match(text, new RegExp(`findingIndex ${i}[^\\n]*${i + 1}-${i + 2}(?:\\D|$)`));
    assert.match(text, /unresolved/);
  }
});

test("workspace references outward names only when qualified records match exactly", async () => {
  const { renderWorkspace } = await import("./render.ts");
  const names = Array.from({ length: 8 }, (_, i) => ({ kind: "http-host", name: `service-${i}.example`, evidence: [{ path: "src/long-service-file.ts", line: i + 1 }] }));
  const unserved = names.map(name => ({ ...name, evidence: name.evidence.map(evidence => ({ ...evidence, repo: "a" })) }));
  const snapshot = { ...base.snapshot, repo: "a" };
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot }], candidates: [], sections: { a: { ...base, snapshot, status: "complete", value: { names, unresolved: [] } } }, unserved };
  const render = (v: typeof value) => renderWorkspace({ ...base, status: "complete", value: v } as never, "details");
  assert.match(render(value), /all recorded outward names are unserved/);
  assert.doesNotMatch(render({ ...value, unserved: unserved.slice(1) }), /all recorded outward names are unserved/);
  assert.doesNotMatch(render({ ...value, unserved: [{ ...unserved[0]!, evidence: [{ ...unserved[0]!.evidence[0]!, line: 100 }] }, ...unserved.slice(1)] }), /all recorded outward names are unserved/);
});

test("decision evidence and free text sharing keeps each option and policy association", async () => {
  const { renderDecisions } = await import("./render.ts");
  const evidence = [{ repo: "shop", path: "src/a-long-repeated-supporting-evidence-location.ts", line: 7 }];
  const decisions = [
    { id: "gateway:one", kind: "gateway", subject: "one", evidence, options: [{ value: "first", basis: "exact-name", evidence: [], recommended: true }], allowsFreeText: true, required: true },
    { id: "repository:two", kind: "repository", subject: "two", evidence, options: [{ value: "second", evidence: [], recommended: false }], allowsFreeText: false, required: false },
    { id: "repository:three", kind: "repository", subject: "three", evidence, options: [], allowsFreeText: true, required: false },
  ];
  const text = renderDecisions({ ...base, status: "complete", value: { repositories: [], source: "request", decisions } } as never, "details");
  assert.equal(text.split(evidence[0]!.path).length - 1, 1);
  assert.match(text, /one[\s\S]*first \(exact-name, recommended\)[\s\S]*two[\s\S]*second[\s\S]*three/);
  assert.match(text, /one[\s\S]*free text/);
  assert.match(text, /three[\s\S]*free text/);
});

test("repeated free-text policy applies only to decisions that allow it", async () => {
  const { renderDecisions } = await import("./render.ts");
  const decisions = Array.from({ length: 8 }, (_, i) => ({ id: `gateway:${i}`, kind: "gateway", subject: `subject-${i}`, evidence: [], options: [], allowsFreeText: i !== 3, required: i === 0 }));
  const text = renderDecisions({ ...base, status: "complete", value: { repositories: [], source: "request", decisions } } as never, "details");
  assert.equal((text.match(/an answer no fact states is accepted/g) ?? []).length, 1);
  assert.equal((text.match(/^      free text allowed$/gm) ?? []).length, 7);
  assert.doesNotMatch(text, /subject-3\n\s+free text allowed/);
});

test("workspace exact matching preserves multiple owners in the shared listing", async () => {
  const { renderWorkspace } = await import("./render.ts");
  const snapshot = (repo: string) => ({ ...base.snapshot, repo });
  const name = (repo: string) => ({ name: `service-${repo}`, kind: "http-host" as const, evidence: [{ path: "src/shared.ts", line: 1 }] });
  const value = { workspace: { repos: ["a", "b"], source: "request" }, repositorySnapshots: ["a", "b"].map(repo => ({ repo, snapshot: snapshot(repo) })), sections: Object.fromEntries(["a", "b"].map(repo => [repo, { ...base, snapshot: snapshot(repo), status: "complete", value: { names: [name(repo)], unresolved: [] } }])), candidates: [], unserved: ["a", "b"].map(repo => ({ ...name(repo), evidence: [{ ...name(repo).evidence[0]!, repo }] })) };
  const text = renderWorkspace({ ...base, status: "complete", value } as never, "details");
  assert.match(text, /all recorded outward names are unserved/);
  assert.match(text, /\n  a:[\s\S]*service-a[\s\S]*\n  b:[\s\S]*service-b/);
});

test("workspace does not infer the owner of evidence-free names", async () => {
  const { renderWorkspace } = await import("./render.ts");
  const snapshot = (repo: string) => ({ ...base.snapshot, repo });
  const name = { name: "same-service-with-an-extremely-long-name-to-demonstrate-unqualified-ownership.example", kind: "http-host" as const, evidence: [] };
  const value = { workspace: { repos: ["a", "b"], source: "request" }, repositorySnapshots: ["a", "b"].map(repo => ({ repo, snapshot: snapshot(repo) })), sections: Object.fromEntries(["a", "b"].map(repo => [repo, { ...base, snapshot: snapshot(repo), status: "complete", value: { names: [name], unresolved: [] } }])), candidates: [], unserved: [name, name] };
  const text = renderWorkspace({ ...base, status: "complete", value } as never, "details");
  assert.doesNotMatch(text, /all recorded outward names are unserved/);
});

test("entrypoint guidance does not advertise selection when recovery is unavailable", () => {
  const fact = { ...base, status: "complete", value: { entrypoints: { ...base, status: "complete", value: [] } } } as unknown as Fact<EntrypointMap>;
  const text = renderEntrypointMap(fact, "full", { tool: "entrypoints", recovery: { version: 1, status: "unavailable", reason: "deadline" } });
  assert.match(text, /deadline/);
  assert.doesNotMatch(text, /Selection lookup:/);
  assert.match(text, /findingIndex/);
});
