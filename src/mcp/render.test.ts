import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContractConsequences, renderEntrypointMap, renderImpact, renderTrace, renderWorkspaceImpact, ROOT_PATH_TEXT } from "./render.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { ConsequencesValue } from "../core/domain/contracts/consequence-fact.ts";

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
  const section = { ...base, status: "partial", cuts: [cut], value: { impact, reads: [{ kind: "trigger", fact: { ...base, status: "partial", cuts: [cut] } }], callSites: [], unmatched: [], external: [], unresolved: [] } };
  const link = { id: "actual-id", from: { repo: "other", file: "f", line: 1, symbol: "s" }, to: { repo: "shop", kind: "job", name: "job", handler: impact.entrypoints[0]!.handler }, basis: "exact", confidence: 1 };
  const workspace = { ...base, status: "partial", cuts: [cut], value: { workspace: { repos: ["shop"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: "shop" }, sections: { shop: section }, links: [{ link, direction: "upstream", reach: [] }] } } as unknown as Fact<WorkspaceImpactValue>;
  const ws = renderWorkspaceImpact(workspace);
  assert.ok(ws.includes('"owner":{"kind":"section","repo":"shop"},"handler"'));
  assert.ok(ws.includes('"owner":{"kind":"section","repo":"shop"},"module"'));
  assert.ok(ws.includes('"owner":{"kind":"section","repo":"shop"},"cutIndex":0'));
  assert.ok(ws.includes('"owner":{"kind":"read","repo":"shop","index":0},"cutIndex":0'));
  assert.ok(ws.includes('[linkId "actual-id"]'));
});

test("shared cut coordinates retain each repository and indexed-read owner", () => {
  const cuts = Array.from({ length: 12 }, (_, index) => ({ kind: "depth", at: [`anchor-${index}`, `place-${index}`], limit: 2 }));
  const read = { kind: "trigger", fact: { ...base, status: "partial", cuts } };
  const section = { ...base, status: "partial", cuts, value: { reads: [read, read], callSites: [], unmatched: [], external: [], unresolved: [] } };
  const fact = { ...base, status: "partial", cuts, value: { workspace: { repos: ['a"b'], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: 'a"b' }, sections: { ['a"b']: section }, links: [] } } as unknown as Fact<WorkspaceImpactValue>;
  const text = renderWorkspaceImpact(fact, "details", { tool: "impact" });
  const templates = [...text.matchAll(/Cut lookup:.*select example: (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]!));
  assert.deepEqual(templates.map(template => template.owner), [
    { kind: "fact" },
    { kind: "section", repo: 'a"b' },
    { kind: "read", repo: 'a"b', index: 0 },
    { kind: "read", repo: 'a"b', index: 1 },
  ]);
  const groups = text.split(/Cut lookup:.*select example: \{[^\n]+\}/).slice(1);
  for (const group of groups) {
    const indices = [...group.matchAll(/^\s+cutIndex (\d+)/gm)].map(match => Number(match[1]));
    assert.deepEqual(indices, cuts.map((_, index) => index));
  }
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
  const value = { workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [{ repo: "a", snapshot }], candidates: [], links: [], unlinked: [], sections: { a: { ...base, snapshot, status: "complete", value: { names, unresolved: [] } } }, unserved };
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
  const value = { workspace: { repos: ["a", "b"], source: "request" }, repositorySnapshots: ["a", "b"].map(repo => ({ repo, snapshot: snapshot(repo) })), sections: Object.fromEntries(["a", "b"].map(repo => [repo, { ...base, snapshot: snapshot(repo), status: "complete", value: { names: [name(repo)], unresolved: [] } }])), candidates: [], links: [], unlinked: [], unserved: ["a", "b"].map(repo => ({ ...name(repo), evidence: [{ ...name(repo).evidence[0]!, repo }] })) };
  const text = renderWorkspace({ ...base, status: "complete", value } as never, "details");
  assert.match(text, /all recorded outward names are unserved/);
  assert.match(text, /\n  a:[\s\S]*service-a[\s\S]*\n  b:[\s\S]*service-b/);
});

test("workspace does not infer the owner of evidence-free names", async () => {
  const { renderWorkspace } = await import("./render.ts");
  const snapshot = (repo: string) => ({ ...base.snapshot, repo });
  const name = { name: "same-service-with-an-extremely-long-name-to-demonstrate-unqualified-ownership.example", kind: "http-host" as const, evidence: [] };
  const value = { workspace: { repos: ["a", "b"], source: "request" }, repositorySnapshots: ["a", "b"].map(repo => ({ repo, snapshot: snapshot(repo) })), sections: Object.fromEntries(["a", "b"].map(repo => [repo, { ...base, snapshot: snapshot(repo), status: "complete", value: { names: [name], unresolved: [] } }])), candidates: [], links: [], unlinked: [], unserved: [name, name] };
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

test("importer omitted paths share one recovery instruction across target files", async () => {
  const { renderImporters } = await import("./render.ts");
  const paths = Array.from({length: 30}, (_, i) => `src/long/dependency/path/${i}.ts`);
  const fact = { ...base, status: "complete", value: { files: ["a.ts", "b.ts"].map(file => ({file, importers: paths, users: [], unresolvedNamers: []})) } };
  const text = renderImporters(fact as never);
  assert.equal(text.split("File paths omitted;").length - 1, 1);
  assert.ok(text.includes("a.ts") && text.includes("b.ts"));
  assert.equal(text.split("related files (30 distinct)").length - 1, 2);
});

test("handler and module examples obey the same registered-tool capability policy as cuts", () => {
  const fact = { ...base, status: "complete", value: { ...impact, entrypoints: impact.entrypoints.map(row => ({ ...row, handler: { ...row.handler, endLine: 12 } })) } } as unknown as Fact<ImpactValue>;
  for (const mode of ["summary", "details"] as const) {
    const unsupported = renderImpact(fact, mode, { tool: "entrypoints" });
    assert.doesNotMatch(unsupported, /"kind":"handler-origins"|"kind":"module-origins"/);
    assert.match(unsupported, /-> src\/h\.ts:7-12 run \(depth/);
    assert.match(unsupported, /base src\/m.ts/);
    const callers = renderImpact(fact, mode, { tool: "callers" });
    assert.match(callers, /"kind":"handler-origins"/);
    assert.doesNotMatch(callers, /"kind":"module-origins"/);
    const supported = renderImpact(fact, mode, { tool: "impact" });
    assert.match(supported, /"kind":"handler-origins"/);
    assert.match(supported, /"kind":"module-origins"/);
  }
});

test("a dependence placed in a component's template names the template beside its lines", () => {
  const symbol = { file: "src/report.page.ts", symbol: "ReportPage", kind: "class", line: 3, endLine: 9, depth: 1, confidence: 1, fanIn: 0, via: { file: "src/archive.api.ts", symbol: "archive", resource: "src/report.page.html", lines: [2], basis: "call" } };
  const fact = { ...base, status: "complete", cuts: [], value: { ...impact, symbols: [symbol] } } as unknown as Fact<ImpactValue>;
  assert.ok(renderImpact(fact, "details").includes("via src/archive.api.ts:archive at src/report.page.html 2"), renderImpact(fact, "details"));
});

function traceFact(cuts: readonly unknown[] = []): Fact<TraceValue> {
  const value: TraceValue = {
    roots: [{ target: "src/order.ts:1-30", steps: [0] }],
    steps: [
      { id: 0, depth: 0, file: "src/order.ts", symbol: "Order", kind: "class", line: 1, endLine: 30 },
      { id: 1, parent: 0, depth: 1, file: "src/order.ts", symbol: "total", kind: "method", line: 12, endLine: 20, at: { line: 5 }, via: "own-member", leaves: [{ symbol: "round", file: "src/math.ts", start: 1, end: 3 }, { symbol: "log", file: "src/log.ts", start: 2, end: 4, deferred: true }], external: [{ kind: "import", module: "lodash", names: ["sum", "map"] }] },
      { id: 2, parent: 1, depth: 2, file: "src/tax.ts", symbol: "tax", kind: "function", line: 4, endLine: 9, at: { line: 14 }, deferred: true, alternatives: [{ symbol: "tax", file: "src/flat-tax.ts", start: 3, end: 6 }] },
      { id: 3, parent: 0, depth: 1, file: "src/order.ts", symbol: "total", kind: "method", line: 12, endLine: 20, at: { line: 7 }, seen: 1 },
    ],
    readingPlan: { ranges: [{ file: "src/order.ts", start: 1, end: 30, steps: [0, 1, 3] }, { file: "src/tax.ts", start: 4, end: 9, steps: [2] }, { file: "src/order.ts", start: 40, end: 40, steps: [1] }], lines: 37 },
    cost: { expanded: 3 },
  };
  return { ...base, status: cuts.length === 0 ? "complete" : "partial", cuts, value } as unknown as Fact<TraceValue>;
}

test("a trace summary shows a selected class root as a class and the reading plan as one line per file, in first appearance, with its lines and the total", () => {
  const text = renderTrace(traceFact());
  assert.ok(text.includes("  src/order.ts:1-30 matches 1: #0 Order [class] src/order.ts:1-30"), text);
  assert.ok(text.includes("reading plan (3 ranges, 37 lines):\n  src/order.ts: 1-30, 40 (31 lines)\n  src/tax.ts: 4-9 (6 lines)"), text);
  assert.ok(text.includes("branches are not evaluated"), text);
});

test("a trace in details keeps one reading range per line in plan order and one unresolved call per line, without the omission line", () => {
  const text = renderTrace(traceFact([{ kind: "unresolved-link", at: ["src/order.ts:15 this.handler.handle", "src/a.ts:handle"] }]), "details");
  assert.ok(text.includes("reading plan (3 ranges, 37 lines):\n  src/order.ts:1-30\n  src/tax.ts:4-9\n  src/order.ts:40\n"), text);
  assert.ok(text.includes("  unresolved-link (1 call):\n    src/order.ts:15 this.handler.handle (src/a.ts:handle)"), text);
  assert.ok(!text.includes("places omitted"), text);
});

test("a trace tree line carries the call line, a foreign span, the seen and deferred notes, leaves, external calls and dispatch alternatives", () => {
  const text = renderTrace(traceFact(), "details");
  assert.ok(text.includes("      #2 14 tax (src/tax.ts:4-9) deferred\n        dispatch alternatives (1): src/flat-tax.ts:3-6"), text);
  assert.ok(text.includes("    #1 5 total own-member\n      leaves: round, log (deferred)\n      external: lodash: sum, map"), text);
  assert.ok(text.includes("      #2 14 tax (src/tax.ts:4-9) deferred"), text);
  assert.ok(text.includes("    #3 7 total seen #1"), text);
});

function effectsFact(): Fact<TraceValue> {
  const fact = traceFact();
  const steps = fact.status === "unknown" ? [] : fact.value.steps.map((step) =>
    step.id === 1 ? { ...step, effects: [{ kind: "http" as const, line: 15, target: { method: "POST" as const, path: "/orders/checkout", base: "https://api" } }] }
      : step.id === 2 ? { ...step, effects: [{ kind: "message" as const, line: 7, target: { protocol: "nats" as const, destination: "orders.created", role: "publish" as const } }] }
        : step);
  return { ...fact, value: { ...(fact as { value: TraceValue }).value, steps } } as Fact<TraceValue>;
}

test("a trace summary lists every effect first, in pre-order, each with its target and its place", () => {
  const text = renderTrace(effectsFact());
  assert.ok(text.includes("effects (2): http POST /orders/checkout base https://api at src/order.ts:15, message nats orders.created at src/tax.ts:7\nbranches are not evaluated"), text);
});

test("a trace summary with no effect says so, never leaving the line out", () => {
  assert.ok(renderTrace(traceFact()).includes("\neffects (0)\n"), renderTrace(traceFact()));
});

test("a trace tree line carries the effects of its body with their lines", () => {
  const text = renderTrace(effectsFact(), "details");
  assert.ok(text.includes("      external: lodash: sum, map\n      effects: http POST /orders/checkout base https://api at 15\n"), text);
});

test("an unresolved trace call names its place and spelling with its candidates, counted in summary when shorter", () => {
  const candidates = ["src/a.ts:handle", "src/b.ts:handle", "src/c.ts:handle"];
  const fact = traceFact([{ kind: "unresolved-link", at: ["src/order.ts:15 this.handler.handle", ...candidates] }]);
  assert.ok(renderTrace(fact, "details").includes(`src/order.ts:15 this.handler.handle (${candidates.join(", ")})`), renderTrace(fact, "details"));
  assert.ok(renderTrace(fact).includes("    handle ×1 in 1 file → 3 candidates"), renderTrace(fact));
});

test("a trace summary groups unresolved calls by trailing name and sorted candidate set, most calls first, then by name", () => {
  const fact = traceFact([
    { kind: "unresolved-link", at: ["src/a.ts:9 other.get", "C"] },
    { kind: "unresolved-link", at: ["src/a.ts:11 this.run"] },
    { kind: "unresolved-link", at: ["src/a.ts:3 this.store.get", "B", "A"] },
    { kind: "unresolved-link", at: ["src/b.ts:7 cache.get", "A", "B"] },
  ]);
  const text = renderTrace(fact);
  assert.ok(text.includes("  unresolved-link (4 calls):\n    get ×2 in 2 files → could be: A, B\n    get ×1 in 1 file → could be: C\n    run ×1 in 1 file\n"), text);
});

test("a trace summary lists candidates by their containment path when shorter than their count, and counts them when longer or when two share a path", () => {
  const text = renderTrace(traceFact([
    { kind: "unresolved-link", at: ["src/a.ts:3 x.get", "src/store.ts::Store.get"] },
    { kind: "unresolved-link", at: ["src/a.ts:5 y.put", "src/cache.ts::LocalCache.put", "src/store.ts::Store.put"] },
    { kind: "unresolved-link", at: ["src/a.ts:7 z.run", "src/a.ts::A.run", "src/b.ts::A.run"] },
  ]));
  assert.ok(text.includes("    get ×1 in 1 file → could be: Store.get\n"), text);
  assert.ok(text.includes("    put ×1 in 1 file → 2 candidates\n"), text);
  assert.ok(text.includes("    run ×1 in 1 file → 2 candidates\n"), text);
});

test("a trace summary that groups unresolved calls ends the cut block by naming the modes that list each place", () => {
  const text = renderTrace(traceFact([{ kind: "unresolved-link", at: ["src/order.ts:15 this.handler.handle"] }]));
  assert.ok(text.endsWith('\n    Call places omitted; mode "details" lists them, mode "full" gives the structured fact.'), text);
});

test("an unresolved trace call keeps its whole place when the path and the spelling hold spaces", () => {
  const fact = traceFact([{ kind: "unresolved-link", at: ["src/my dir/a.ts:15 (async (x) => x)().run", "src/b.ts:run"] }]);
  assert.ok(renderTrace(fact, "details").includes("    src/my dir/a.ts:15 (async (x) => x)().run (src/b.ts:run)"), renderTrace(fact, "details"));
  assert.ok(renderTrace(fact).includes("    run ×1 in 1 file → 1 candidate"), renderTrace(fact));
});

const HYPOTHESIS = { method: "GET", path: "/owners/{id}", target: "response", property: "name", change: "nullable" };
const handler = { repo: "api", path: "src/OwnerController.java", symbol: "OwnerController.show", line: 30 };
const useAt = (n: number, verdict: object) => ({ status: "complete", value: { repo: "web", link: { id: `l${n}`, basis: "exact", call: { file: "src/client.ts", line: 3, symbol: "load" }, handler }, verdict, operation: {}, path: "name", changed: "name", chain: [] }, evidence: [{ repo: "web", path: `src/use-${n}.ts`, line: n }] });

/** Every hypothesis unknown but one, a change with no derived hypothesis for it, and a derivation cut: nothing here may read as safe. */
function consequences(findings: object[]): Fact<ConsequencesValue> {
  const derivation = { ...base, status: "partial", cuts: [{ kind: "deadline", at: ["src/Gone.java"] }], value: { differences: [
    { rule: "operation-added", level: "compatible", target: "operation", operation: "GET /new", delta: "added", places: { head: { repo: "api", path: "openapi.yaml", line: 30 } } },
    { rule: "response-property-became-nullable", level: "breaking", target: "response", operation: "GET /pets", property: "name", delta: "introduced-null", places: { base: { repo: "api", path: "openapi.yaml", line: 12 }, head: { repo: "api", path: "openapi.yaml", line: 12 } } },
    { rule: "response-property-constraint-narrowed", level: "compatible", target: "response", operation: "GET /pets", property: "name", delta: "constraint-narrowed", subject: "maxLength", base: 9, head: 3, places: { base: { repo: "api", path: "openapi.yaml", line: 12 }, head: { repo: "api", path: "openapi.yaml", line: 14 } } },
  ], frontiers: [
    { status: "unknown", reason: "unresolved", kind: "unserved-operation", operation: "GET /pets", evidence: [{ repo: "api", path: "openapi.yaml", line: 12 }] },
    { status: "unknown", reason: "source-unreadable", kind: "unreadable-contract", side: "base", evidence: [{ repo: "api", path: "openapi.yaml", line: 1 }] },
    { status: "unknown", reason: "unresolved", kind: "unsupported-delta", target: "request", operation: "POST /pets", property: "", evidence: [{ repo: "api", path: "openapi.yaml", line: 20 }] },
  ] } };
  const value = {
    repositorySnapshots: [{ repo: "api", snapshot: base.snapshot }, { repo: "web", snapshot: { ...base.snapshot, repo: "web" } }],
    answers: [
      { hypothesis: HYPOTHESIS, oldContract: "present-and-non-null", status: "complete", findings },
      { hypothesis: { ...HYPOTHESIS, path: "/vets" }, oldContract: "present-and-non-null", status: "unknown", reason: "no-project", detail: "no repository serves GET /vets" },
    ],
    change: { base: "main", head: "feature", snapshots: { base: "b".repeat(40), head: "c".repeat(40) }, derivation },
  };
  return { ...base, status: "partial", cuts: [{ kind: "section", at: ["change.derivation"] }], value } as unknown as Fact<ConsequencesValue>;
}

test("a contract consequences summary counts each answer's verdicts and keeps its unknown reasons, derivation cuts and frontier counts, while details lists every finding with its place", () => {
  const verdicts = [{ kind: "incompatible", witness: "null", at: 1, failing: {}, capability: "member" }, { kind: "admits", guards: [] }, { kind: "review", reason: "consumed" }];
  const findings = [
    ...Array.from({ length: 12 }, (_, index) => useAt(index + 1, verdicts[index % 3]!)),
    { status: "unknown", reason: "source-unreadable", evidence: [{ repo: "web", path: "src/broken.ts", line: 99 }] },
  ];
  const fact = consequences(findings);
  const summary = renderContractConsequences(fact, "summary");
  const details = renderContractConsequences(fact, "details");

  for (const text of [summary, details]) {
    assert.match(text, /unknown \(no-project\): no repository serves GET \/vets/);
    assert.match(text, /status: partial \(cuts: 1 deadline\)/);
    assert.match(text, /unserved-operation \(unresolved\)/);
    assert.match(text, /unreadable-contract \(source-unreadable\)/);
    assert.match(text, /status: partial \(cuts: 1 section: change.derivation\)/);
  }
  assert.match(summary, /13 findings: 4 admits, 4 incompatible, 4 review, 1 unknown \(source-unreadable\)/);
  assert.doesNotMatch(summary, /src\/use-1\.ts/);
  assert.match(summary, /differences \(3\): 2 compatible, 1 breaking/);
  assert.doesNotMatch(summary, /response-property-became-nullable/);
  assert.ok(details.includes("    - breaking response-property-became-nullable GET /pets name at api:openapi.yaml:12"));
  assert.ok(details.includes("    - compatible response-property-constraint-narrowed GET /pets name (maxLength: 9 -> 3) at api:openapi.yaml:14"));
  assert.ok(details.includes("    - compatible operation-added GET /new at api:openapi.yaml:30"));
  assert.match(summary, /frontiers \(3\): 1 unreadable-contract \(source-unreadable\), 1 unserved-operation \(unresolved\), 1 unsupported-delta \(unresolved\)/);
  assert.ok(details.includes("    - unsupported-delta (unresolved) POST /pets request at api:openapi.yaml:20"));
  for (let n = 1; n <= 12; n++) assert.ok(details.includes(`at web:src/use-${n}.ts:${n};`), `finding ${n}`);
  assert.ok(details.includes("at web:src/broken.ts:99"));
  assert.ok(details.includes("api:openapi.yaml:12"));
  assert.ok(Buffer.byteLength(summary) <= Buffer.byteLength(details));
});

test("a contract consequences finding on the body root names the whole body instead of an empty path", () => {
  const root = useAt(1, { kind: "review", reason: "consumed" });
  const producer = { ...root, value: { ...root.value, operation: undefined, path: "", verdict: { kind: "admits" } } };
  delete (producer.value as { operation?: unknown }).operation;
  const details = renderContractConsequences(consequences([{ ...root, value: { ...root.value, path: "", changed: "" } }, producer]), "details");

  assert.ok(details.includes(`reads ${ROOT_PATH_TEXT}, changed ${ROOT_PATH_TEXT};`), details);
  assert.ok(details.includes(`writes ${ROOT_PATH_TEXT};`), details);
});

test("a contract consequences answer with no findings says so and an unknown fact keeps only its header", () => {
  const empty = consequences([]);
  assert.match(renderContractConsequences(empty, "summary"), /no findings/);
  const unknown = { ...base, status: "unknown", reason: "index-unavailable", evidence: [] } as unknown as Fact<ConsequencesValue>;
  const text = renderContractConsequences(unknown, "details");
  assert.match(text, /status: unknown \(index-unavailable\)/);
  assert.doesNotMatch(text, /answers \(/);
});

test("a contract consequences change whose derivation could not be computed keeps its reason and the answers beside it", () => {
  const fact = consequences([]);
  const change = (fact as unknown as { value: { change: { derivation: unknown } } }).value.change;
  change.derivation = { ...base, status: "unknown", reason: "revision-unavailable", evidence: [] };
  const text = renderContractConsequences(fact, "summary");
  assert.match(text, /derivation:\n  status: unknown \(revision-unavailable\)/);
  assert.match(text, /unknown \(no-project\): no repository serves GET \/vets/);
});

test("data effects render access and operation with optional proven targets in summaries and step details", () => {
  const fact = traceFact();
  assert.notEqual(fact.status, "unknown");
  if (fact.status === "unknown") return;
  fact.value.steps[0]!.effects = [
    { kind: "data", line: 4, operation: "findById", access: "read", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 5, operation: "update", access: "write" },
  ];
  for (const mode of ["summary", "details"] as const) {
    const text = renderTrace(fact, mode);
    assert.ok(text.includes("data read findById entity shop.Order"));
    assert.ok(text.includes("data write update"));
    assert.ok(!text.includes("undefined"));
  }
});
