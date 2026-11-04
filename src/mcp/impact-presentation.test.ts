import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import { renderImpact, renderImporters, renderWorkspaceImpact } from "./render.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";

const base: FactBase = { schema: SCHEMA, snapshot: { repo: "a", kind: "sha", sha: "abc" }, producer: { name: "test", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "c", declaredConfig: {}, engines: {} }, evidence: [] };
const impact: ImpactValue = { seeds: [{ file: "first.ts", line: 2, symbol: "first", basis: "lines" }, { file: "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts", line: 8, symbol: "second", basis: "lines" }], symbols: [], entrypoints: [{ kind: "http-route", name: "GET /x", handler: { path: "route.ts", line: 9, symbol: "handler" }, depth: 1, confidence: 1, seeds: [0, 1] }], cost: { expansionsUsed: 0 } };
const fact: Fact<ImpactValue> = { ...base, status: "complete", value: impact };

test("module importer forms remain distinct without repeating related file paths", () => {
  const value: ImportersValue = { files: [{ file: "target.ts", importers: ["static.ts", "shared.ts"], reexporters: ["barrel.ts", "shared.ts"], dynamicImporters: ["dynamic.ts"], typeImporters: ["type.ts"], users: ["static.ts", "shared.ts", "barrel.ts", "dynamic.ts", "type.ts", "other.ts"], unresolvedNamers: ["dynamic.ts", "unknown.ts"] }] };
  const original = structuredClone(value);
  const text = renderImporters({ ...base, status: "complete", value }, "full");
  assert.match(text, /reexporters \(1\): barrel\.ts/);
  assert.match(text, /dynamic importers \(1\)/);
  assert.match(text, /type importers \(1\): type\.ts/);
  for (const file of ["static.ts", "shared.ts", "barrel.ts", "dynamic.ts", "type.ts", "other.ts", "unknown.ts"]) assert.equal(text.split(file).length - 1, 1, text);
  assert.deepEqual(value, original);
});

test("detailed impact shows one recorded origin association and counts the remaining associations", () => {
  const summary = renderImpact(fact).split("impacted symbols")[0]!;
  const detail = renderImpact(fact, "full").split("impacted symbols")[0]!;
  assert.doesNotMatch(summary, /one verified origin/);
  assert.match(detail, /one verified origin: first\.ts:2 first/);
  assert.match(detail, /1 other origin; full: true/);
  assert.doesNotMatch(detail, /second-origin-with-a-long-navigable-path-for-the-summary-comparison/);
});

test("workspace links locate handlers and preserve the recorded reach order", () => {
  const link = {
    id: "first", from: { repo: "a", file: "call.ts", line: 4, symbol: "call" },
    to: { repo: "b", kind: "http-route" as const, name: "GET /x", handler: { path: "route.ts", line: 9, symbol: "handler" } },
    transport: "http" as const, basis: "exact" as const, confidence: 1,
  };
  const next = { ...link, id: "next", from: { repo: "b", file: "forward.ts", line: 12, symbol: "forward" }, to: { ...link.to, repo: "c" } };
  const value: WorkspaceImpactValue = {
    workspace: { repos: [], gateways: [], unmatchedGateways: [], unserved: [], source: "request" },
    repositorySnapshots: [], trigger: { repo: "a" }, sections: {},
    links: [{ link: next, direction: "downstream", reach: ["first", "next"] }, { link, direction: "downstream", reach: ["first"] }],
  };
  const output = renderWorkspaceImpact({ ...base, status: "complete", value });
  assert.match(output, /1\. b:forward\.ts:12 forward -> c GET \/x -> route\.ts:9 handler \(exact, downstream; reach: 2, 1\)/);
  assert.match(output, /2\. a:call\.ts:4 call -> b GET \/x -> route\.ts:9 handler \(exact, downstream; reach: 2\)/);
});

test("both workspace text levels count unserved names when shorter", () => {
  const names = Array.from({ length: 20 }, (_, i) => `unserved-service-${i}`);
  const value: WorkspaceImpactValue = { workspace: { repos: [], gateways: [], unmatchedGateways: [], unserved: names, source: "request" }, repositorySnapshots: [], trigger: { repo: "a" }, sections: {}, links: [] };
  const workspaceFact: Fact<WorkspaceImpactValue> = { ...base, status: "complete", value };
  const summary = renderWorkspaceImpact(workspaceFact);
  const full = renderWorkspaceImpact(workspaceFact, "full");
  assert.match(summary, /20.*full: true/);
  assert.doesNotMatch(summary, /unserved-service-0/);
  assert.doesNotMatch(full, /unserved-service-0/);
  assert.match(full, /20.*full: true/);
});

test("detail shares consecutive identical dependencies without losing symbol locations or order", () => {
  const via = { file: "src/domain/shared/long-dependency-path.ts", symbol: "Dependency.resolve", lines: [17, 29], basis: "reference" as const };
  const symbols = [3, 5, 9].map((line) => ({ file: "consumer.ts", line, symbol: `use${line}`, kind: "function", depth: 1, confidence: 1, fanIn: 0, via }));
  const value = { ...impact, entrypoints: [], symbols };
  const detail = renderImpact({ ...fact, value }, "full");
  assert.equal(detail.split(via.file).length - 1, 1);
  assert.match(detail, /via src\/domain\/shared\/long-dependency-path\.ts:Dependency\.resolve at 17, 29 \(reference\)/);
  assert.match(detail, /3 use3[\s\S]*5 use5[\s\S]*9 use9/);
  assert.equal(renderImpact({ ...fact, value }, "full"), detail);
});

test("workspace cut anchors and distinct limits stay with their owning repository", () => {
  const symbols = Array.from({ length: 8 }, (_, i) => ({ file: "same-relative-path.ts", line: i + 1, symbol: `use${i}`, kind: "function", depth: 0, confidence: 1, fanIn: 0 }));
  const section = (depth: number): Fact<RepoImpact> => ({
    ...base, status: "partial",
    cuts: [{ kind: "depth", at: ["same-relative-path.ts::use0"], limit: depth + 1 }, ...symbols.slice(1).map((symbol) => ({ kind: "depth" as const, at: [`${symbol.file}::${symbol.symbol}`], limit: depth + 1 }))],
    value: { reads: [], callSites: [], unmatched: [], external: [], impact: { ...impact, seeds: [], entrypoints: [], symbols: symbols.map((symbol) => ({ ...symbol, depth })) } },
  });
  const value: WorkspaceImpactValue = {
    workspace: { repos: ["a", "b"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" },
    repositorySnapshots: [], trigger: { repo: "a" }, sections: { a: section(0), b: section(4) }, links: [],
  };
  const workspaceFact: Fact<WorkspaceImpactValue> = { ...base, status: "partial", cuts: [{ kind: "section", at: ["a", "b"] }], value };
  for (const detail of ["summary", "full"] as const) {
    const output = renderWorkspaceImpact(workspaceFact, detail);
    const a = output.split("cuts for repository a:")[1]?.split("cuts for repository b:")[0] ?? "";
    const b = output.split("cuts for repository b:")[1] ?? "";
    if (detail === "full") {
      assert.match(a, /depth \(8\): same-relative-path\.ts::use0[^\n]*limit 1/);
      assert.match(b, /depth \(8\): same-relative-path\.ts::use0[^\n]*limit 5/);
    } else {
      assert.match(a, /depth \(8\); limit 1/);
      assert.match(b, /depth \(8\); limit 5/);
      assert.doesNotMatch(a + b, /::use0/);
    }
  }
});

test("short origin paths do not trigger exhaustive association expansion", () => {
  const value: ImpactValue = { ...impact, seeds: [{ file: "a", symbol: "a", line: 1, basis: "lines" }, { file: "b", symbol: "b", line: 2, basis: "lines" }] };
  const detail = renderImpact({ ...fact, value }, "full").split("impacted symbols")[0]!;
  assert.match(detail, /one verified origin: a:1 a/);
  assert.match(detail, /1 other origin/);
  assert.doesNotMatch(detail, /verified origin: b:2 b/);
});

test("sharing via context does not merge distinct dependency locations or reasons", () => {
  const via = { file: "dependency.ts", symbol: "dependency", lines: [11], basis: "reference" as const };
  const symbols = [
    { file: "consumer.ts", line: 3, symbol: "first", kind: "function", depth: 1, confidence: 1, fanIn: 0, via },
    { file: "consumer.ts", line: 5, symbol: "second", kind: "function", depth: 1, confidence: 1, fanIn: 0, via: { ...via, lines: [21], basis: "call" as const } },
    { file: "consumer.ts", line: 7, symbol: "third", kind: "function", depth: 1, confidence: 1, fanIn: 0, via },
  ];
  const output = renderImpact({ ...fact, value: { ...impact, entrypoints: [], symbols } }, "full");
  assert.match(output, /3 first[^\n]*via dependency\.ts:dependency at 11 \(reference\)/);
  assert.match(output, /5 second[^\n]*via dependency\.ts:dependency at 21/);
  assert.match(output, /7 third[^\n]*via dependency\.ts:dependency at 11 \(reference\)/);
});

test("detailed impact retains the nearest dependency frontier and reached handler evidence without listing every deeper symbol", () => {
  const value: ImpactValue = {
    ...impact,
    symbols: [
      { file: "consumer.ts", symbol: "direct", kind: "function", line: 12, endLine: 18, depth: 1, confidence: 0.7, fanIn: 2, via: { file: "first.ts", symbol: "first", lines: [15], basis: "reference" } },
      { file: "other.ts", symbol: "deeper", kind: "function", line: 22, depth: 2, confidence: 1, fanIn: 0 },
      { file: "other.ts", symbol: "anotherDeeperConsumer", kind: "function", line: 32, depth: 2, confidence: 1, fanIn: 0 },
      { file: "other.ts", symbol: "thirdDeeperConsumer", kind: "function", line: 42, depth: 2, confidence: 1, fanIn: 0 },
      { file: "route.ts", symbol: "handler", kind: "function", line: 9, depth: 3, confidence: 1, fanIn: 0, via: { file: "consumer.ts", symbol: "direct", lines: [11], basis: "call" } },
    ],
  };
  const output = renderImpact({ ...fact, value }, "full");
  assert.match(output, /12-18 direct[^\n]*confidence 0\.7[^\n]*fan-in 2/);
  assert.match(output, /via first\.ts:first at 15 \(reference\)/);
  assert.match(output, /9 handler[^\n]*via consumer\.ts:direct at 11/);
  assert.doesNotMatch(output, /22 deeper/);
  assert.match(output, /3 other symbols[^\n]*full: true/);
  assert.doesNotMatch(renderImpact({ ...fact, value }), /12-18 direct/);
});

test("impact detail localizes cut anchors and limits while counting their reference places", () => {
  const partial: Fact<ImpactValue> = { ...base, status: "partial", value: impact, cuts: [
    { kind: "unresolved-link", at: ["service.ts::Service.read", "consumer-a.ts:12", "consumer-b.ts:91"] },
    { kind: "depth", at: ["route.ts::handler"], limit: 4 },
  ] };
  const summary = renderImpact(partial);
  const detail = renderImpact(partial, "full");
  assert.match(summary, /unresolved-link/);
  assert.match(summary, /depth[^\n]*limit 4/);
  assert.doesNotMatch(summary, /consumer-a\.ts|Service\.read/);
  assert.match(detail, /service\.ts[\s\S]*Service\.read/);
  assert.match(detail, /2 reference places/);
  assert.match(detail, /route\.ts::handler[^\n]*limit 4/);
  assert.doesNotMatch(detail, /consumer-a\.ts|consumer-b\.ts/);
  assert.match(detail, /full: true/);
});

test("summary counts omitted origin associations per entrypoint rather than counting the seed inventory", () => {
  const value: ImpactValue = {
    ...impact,
    seeds: [...impact.seeds, { file: "unused-a.ts", symbol: "unusedA", line: 3, basis: "lines" }, { file: "unused-b.ts", symbol: "unusedB", line: 4, basis: "lines" }],
    entrypoints: [...impact.entrypoints, { ...impact.entrypoints[0]!, name: "GET /y", seeds: [1] }],
  };
  const summary = renderImpact({ ...fact, value }).split("impacted symbols")[0]!;
  assert.match(summary, /origin associations \(3\)/);
  assert.match(summary, /GET \/x[^\n]*\n\s+origins: 2/);
  assert.match(summary, /GET \/y[^\n]*\n\s+origins: 1/);
  assert.match(summary, /detail "full"[^\n]*full: true/);
});

test("impact guidance explains contextual full lookups and the origin-index join", () => {
  const value: ImpactValue = { ...impact, symbols: [{ file: "caller.ts", symbol: "use", kind: "function", line: 12, depth: 1, confidence: 1, fanIn: 0, via: { file: "first.ts", symbol: "first", lines: [15], basis: "reference" } }] };
  for (const detail of ["summary", "full"] as const) {
    const guide = renderImpact({ ...fact, value }, detail).split("Investigation guide:")[1] ?? "";
    assert.ok(guide.includes("value.entrypoints"));
    assert.ok(guide.includes("handler.path") && guide.includes("handler.symbol") && guide.includes("handler.line"));
    assert.ok(guide.includes("zero-based") && guide.includes("value.seeds"));
    assert.ok(guide.includes("value.symbols") && guide.includes("via.lines") && guide.includes("symbol's own file"));
    assert.ok(guide.includes("full: true"));
    assert.ok(guide.includes("same snapshot"));
    assert.doesNotMatch(guide, /value\.links|value\.sections/);
  }
});

test("workspace guidance qualifies repository payloads and joins reach IDs rather than display numbers", () => {
  const link = { id: "link-a", from: { repo: "a", file: "call.ts", symbol: "send", line: 4 }, to: { repo: "b", kind: "http-route" as const, name: "GET /x", handler: { path: "route.ts", line: 9, symbol: "handler" } }, transport: "http" as const, basis: "route-overlap" as const, confidence: 0.6 };
  const value: WorkspaceImpactValue = {
    workspace: { repos: ["a", "b"], gateways: [], unmatchedGateways: [], unserved: ["missing-api"], source: "request" }, repositorySnapshots: [], trigger: { repo: "a" },
    sections: { a: { ...base, status: "complete", value: { reads: [], impact, callSites: [], unmatched: [], external: [] } }, b: { ...base, status: "unknown", reason: "index-unavailable" } },
    links: [{ link, direction: "downstream", reach: ["link-a"] }],
  };
  const guide = renderWorkspaceImpact({ ...base, status: "complete", value }, "full").split("Investigation guide:")[1] ?? "";
  assert.ok(guide.includes('value.sections["a"].value.impact'));
  assert.ok(guide.includes("section.status") && guide.includes("value.reads"));
  assert.ok(guide.includes("value.links") && guide.includes("reach") && guide.includes("link.id"));
  assert.ok(guide.includes("IDs") && guide.includes("display numbers"));
  assert.ok(guide.includes("value.workspace.unserved") && guide.includes("ye_ast_workspace"));
  assert.doesNotMatch(guide, /value\.entrypoints/);
});

test("unknown and verified-empty impact guidance distinguishes missing analysis from scoped emptiness", () => {
  const unknown = renderImpact({ ...base, status: "unknown", reason: "index-unavailable" }, "full").split("Investigation guide:")[1] ?? "";
  assert.ok(unknown.includes("reason") && unknown.includes("evidence"));
  assert.doesNotMatch(unknown, /value\.|no recorded consequences/);
  const empty = renderImpact({ ...fact, value: { ...impact, seeds: [], symbols: [], entrypoints: [] } }, "full").split("Investigation guide:")[1] ?? "";
  assert.ok(empty.includes("no recorded consequences") && empty.includes("inputs.declaredScope"));
  assert.doesNotMatch(empty, /value\.entrypoints|value\.symbols|value\.seeds/);
});
