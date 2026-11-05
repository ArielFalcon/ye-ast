import { test } from "node:test";
import { z } from "zod";
import { recoveryControlShapeFor, validRecoveryControls } from "./evidence-schema.ts";
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
  const text = renderImporters({ ...base, status: "complete", value }, "details");
  assert.match(text, /barrel\.ts": reexporters\[0\], users\[2\]/);
  assert.match(text, /dynamic\.ts": dynamic importers\[0\], users\[3\], unresolved name matches\[0\]/);
  assert.match(text, /type\.ts": type importers\[0\], users\[4\]/);
  for (const file of ["static.ts", "shared.ts", "barrel.ts", "dynamic.ts", "type.ts", "other.ts", "unknown.ts"]) assert.equal(text.split(file).length - 1, 1, text);
  assert.deepEqual(value, original);
});

test("detailed impact shows one recorded origin association and counts the remaining associations", () => {
  const summary = renderImpact(fact).split("impacted symbols")[0]!;
  const detail = renderImpact(fact, "details").split("impacted symbols")[0]!;
  assert.doesNotMatch(summary, /one verified origin/);
  assert.match(detail, /one verified origin: first\.ts:2 first/);
  assert.match(detail, /1 other origin/);
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
  const full = renderWorkspaceImpact(workspaceFact, "details");
  assert.match(summary, /20.*mode: "full"/);
  assert.doesNotMatch(summary, /unserved-service-0/);
  assert.doesNotMatch(full, /unserved-service-0/);
  assert.match(full, /20.*mode: "full"/);
});

test("detail shares consecutive identical dependencies without losing symbol locations or order", () => {
  const via = { file: "src/domain/shared/long-dependency-path.ts", symbol: "Dependency.resolve", lines: [17, 29], basis: "reference" as const };
  const symbols = [3, 5, 9].map((line) => ({ file: "consumer.ts", line, symbol: `use${line}`, kind: "function", depth: 1, confidence: 1, fanIn: 0, via }));
  const value = { ...impact, entrypoints: [], symbols };
  const detail = renderImpact({ ...fact, value }, "details");
  assert.equal(detail.split(via.file).length - 1, 1);
  assert.match(detail, /via src\/domain\/shared\/long-dependency-path\.ts:Dependency\.resolve at 17, 29 \(reference\)/);
  assert.match(detail, /3 use3[\s\S]*5 use5[\s\S]*9 use9/);
  assert.equal(renderImpact({ ...fact, value }, "details"), detail);
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
  for (const detail of ["summary", "details"] as const) {
    const output = renderWorkspaceImpact(workspaceFact, detail);
    const a = output.split("cuts for repository a:")[1]?.split("cuts for repository b:")[0] ?? "";
    const b = output.split("cuts for repository b:")[1] ?? "";
    if (detail === "details") {
      assert.match(a, /depth \(8\): same-relative-path\.ts::use0[^\n]*limit 1/);
      assert.match(b, /depth \(8\): same-relative-path\.ts::use0[^\n]*limit 5/);
    } else {
      assert.match(a, /depth \(8\); limit 1/);
      assert.match(b, /depth \(8\); limit 5/);
      assert.doesNotMatch(a + b, /::use0/);
      assert.equal((a.match(/"kind":"cut-places"/g) ?? []).length, 1);
      assert.equal((b.match(/"kind":"cut-places"/g) ?? []).length, 1);
    }
  }
});

test("short origin paths do not trigger exhaustive association expansion", () => {
  const value: ImpactValue = { ...impact, seeds: [{ file: "a", symbol: "a", line: 1, basis: "lines" }, { file: "b", symbol: "b", line: 2, basis: "lines" }] };
  const detail = renderImpact({ ...fact, value }, "details").split("impacted symbols")[0]!;
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
  const output = renderImpact({ ...fact, value: { ...impact, entrypoints: [], symbols } }, "details");
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
  const output = renderImpact({ ...fact, value }, "details");
  assert.match(output, /12-18 direct[^\n]*confidence 0\.7[^\n]*fan-in 2/);
  assert.match(output, /via first\.ts:first at 15 \(reference\)/);
  assert.match(output, /9 handler[^\n]*via consumer\.ts:direct at 11/);
  assert.doesNotMatch(output, /22 deeper/);
  assert.match(output, /3 other symbols[^\n]*mode: "full"/);
  assert.doesNotMatch(renderImpact({ ...fact, value }), /12-18 direct/);
});

test("impact detail localizes cut anchors and limits while counting their reference places", () => {
  const partial: Fact<ImpactValue> = { ...base, status: "partial", value: impact, cuts: [
    { kind: "unresolved-link", at: ["service.ts::Service.read", "consumer-a.ts:12", "consumer-b.ts:91"] },
    { kind: "depth", at: ["route.ts::handler"], limit: 4 },
  ] };
  const summary = renderImpact(partial);
  const detail = renderImpact(partial, "details");
  assert.match(summary, /unresolved-link/);
  assert.match(summary, /depth[^\n]*limit 4/);
  assert.doesNotMatch(summary, /consumer-a\.ts|Service\.read/);
  assert.match(detail, /service\.ts[\s\S]*Service\.read/);
  assert.match(detail, /2 reference places/);
  assert.match(detail, /route\.ts::handler[^\n]*limit 4/);
  assert.doesNotMatch(detail, /consumer-a\.ts|consumer-b\.ts/);
  assert.match(detail, /mode: "full"/);
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
  assert.match(summary, /mode "details"[^\n]*mode: "full"/);
});

test("impact guidance explains contextual full lookups and the origin-index join", () => {
  const value: ImpactValue = { ...impact, symbols: [{ file: "caller.ts", symbol: "use", kind: "function", line: 12, depth: 1, confidence: 1, fanIn: 0, via: { file: "first.ts", symbol: "first", lines: [15], basis: "reference" } }] };
  for (const detail of ["summary", "details"] as const) {
    const guide = renderImpact({ ...fact, value }, detail).split("Investigation guide:")[1] ?? "";
    assert.ok(guide.includes("value.entrypoints"));
    assert.ok(guide.includes("handler.path") && guide.includes("handler.symbol") && guide.includes("handler.line"));
    assert.ok(guide.includes("zero-based") && guide.includes("value.seeds"));
    assert.ok(guide.includes("value.symbols") && guide.includes("via.lines") && guide.includes("symbol's own file"));
    assert.ok(guide.includes("full mode"));
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
  const guide = renderWorkspaceImpact({ ...base, status: "complete", value }, "details").split("Investigation guide:")[1] ?? "";
  assert.ok(guide.includes('value.sections["a"].value.impact'));
  assert.ok(guide.includes("section.status") && guide.includes("value.reads"));
  assert.ok(guide.includes("value.links") && guide.includes("reach") && guide.includes("link.id"));
  assert.ok(guide.includes("IDs") && guide.includes("display numbers"));
  assert.ok(guide.includes("value.workspace.unserved") && guide.includes("ye_ast_workspace"));
  assert.doesNotMatch(guide, /value\.entrypoints/);
});

test("unknown and verified-empty impact guidance distinguishes missing analysis from scoped emptiness", () => {
  const unknown = renderImpact({ ...base, status: "unknown", reason: "index-unavailable" }, "details").split("Investigation guide:")[1] ?? "";
  assert.ok(unknown.includes("reason") && unknown.includes("evidence"));
  assert.doesNotMatch(unknown, /value\.|no recorded consequences/);
  const emptyFact = { ...fact, value: { ...impact, seeds: [], symbols: [], entrypoints: [] } };
  const empty = renderImpact(emptyFact, "details");
  assert.match(empty, /status: complete/);
  assert.doesNotMatch(empty, /Investigation guide:|Full JSON navigation|ye_ast_callers/);
  const full = renderImpact(emptyFact, "full");
  assert.match(full, /no recorded consequences/);
  assert.match(full, /declared scope/);
  assert.doesNotMatch(full, /value\.entrypoints|value\.symbols|value\.seeds|ye_ast_callers/);
});

test("module-only details compact repeated origin associations and keep the nearest recorded dependency", () => {
  const origins = Array.from({ length: 16 }, (_, i) => ({ file: `src/long-module-origin-${i}.ts`, change: "modified" as const }));
  const modules = [
    { file: "src/consumer.ts", snapshot: "head" as const, depth: 1, origins: origins.map((_, i) => i), via: { file: origins[0]!.file, line: 7, specifier: "pkg", kind: "import" as const, typeOnly: false } },
    { file: "src/deeper.ts", snapshot: "head" as const, depth: 2, origins: origins.map((_, i) => i) },
  ];
  const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], modules: { origins, modules, cost: { expansionsUsed: 2 } }, cost: { expansionsUsed: 0 } };
  const output = renderImpact({ ...fact, value }, "details");
  assert.match(output, /module dependencies \(2/);
  assert.match(output, /at line 7 in this module/);
  assert.match(output, /16.*origin/);
  assert.match(output, /mode: "full"/);
  assert.doesNotMatch(output, /origins 0, 1, 2, 3, 4, 5/);
  assert.doesNotMatch(output, /no recorded consequences or walk origins/);
});

test("module details identify a recorded origin without requiring an index join", () => {
  const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 }, modules: {
    origins: [{ file: "src/origin.ts", change: "modified" }],
    modules: [{ file: "src/consumer.ts", snapshot: "head", depth: 1, origins: [0], via: { file: "src/bridge.ts", line: 7, specifier: "./origin", kind: "import", typeOnly: false } }],
    cost: { expansionsUsed: 1 },
  } };
  const text = renderImpact({ ...fact, value }, "details");
  assert.match(text, /src\/consumer\.ts[^\n]*origin[^\n]*src\/origin\.ts/);
  assert.match(text, /at line 7 in this module/);
});

test("module details share repeated origin context without losing consumers", () => {
  const origin = { file: "src/long/repeated/very-long-origin-name-for-consumers.ts", change: "modified" as const };
  const modules = Array.from({ length: 8 }, (_, i) => ({ file: `src/consumer-${i}.ts`, snapshot: "head" as const, depth: 1, origins: [0] }));
  const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 }, modules: { origins: [origin], modules, cost: { expansionsUsed: 8 } } };
  const text = renderImpact({ ...fact, value }, "details");
  assert.equal(text.split(`origin ${origin.file}`).length - 1, 1);
  assert.match(text, /src\/consumer-0\.ts/);
  assert.match(text, /src\/consumer-7\.ts/);
});

test("full workspace guidance does not imply another walk when only the trigger has one", () => {
  const value: WorkspaceImpactValue = {
    workspace: { repos: ["a", "b"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" },
    repositorySnapshots: [], trigger: { repo: "a" },
    sections: {
      a: { ...base, status: "complete", value: { reads: [], impact, callSites: [], unmatched: [], external: [] } },
      b: { ...base, status: "unknown", reason: "index-unavailable" },
    }, links: [],
  };
  const guide = renderWorkspaceImpact({ ...base, status: "complete", value }, "full");
  assert.match(guide, /value\.sections\["a"\]\.value\.impact/);
  assert.doesNotMatch(guide, /Other repository walks/);
});

test("full guide shares base module revision while retaining each module in the source", () => {
  const modules = Array.from({ length: 33 }, (_, i) => ({ file: `src/base-${i}.ts`, snapshot: "base" as const, depth: 0, origins: [] }));
  const value: ImpactValue = { ...impact, mergeBase: "base-a", modules: { origins: [], modules, cost: { expansionsUsed: 0 } } };
  const before = structuredClone(value);
  const output = renderImpact({ ...fact, value }, "full");
  assert.equal((output.match(/Base modules:/g) ?? []).length, 1);
  assert.match(output, /repo "a", revision "base-a"/);
  assert.match(output, /modules\[\].*file/);
  assert.deepEqual(value, before);
});

test("local base module guidance reuses the recorded query base without repeating its coordinate", () => {
  const value: ImpactValue = { ...impact, mergeBase: "long-base-revision", modules: { origins: [], modules: [{ file: "base.ts", snapshot: "base", depth: 0, origins: [] }], cost: { expansionsUsed: 0 } } };
  const before = structuredClone(value);
  for (const mode of ["summary", "details", "full"] as const) {
    const text: string = renderImpact({ ...fact, value }, mode).split("Investigation guide:")[1]!;
    assert.equal((text.match(/long-base-revision/g) ?? []).length, 1);
    assert.match(text, /base recorded below/);
    assert.deepEqual(value, before);
  }
  const live = { ...fact, snapshot: { repo: "a", kind: "live" as const, head: "h", stateId: "state" }, value };
  assert.match(renderImpact(live, "full"), /revision "long-base-revision"/);
  assert.match(renderImpact({ ...fact, value }, "full", { tool: "callers" }), /revision "long-base-revision"/);
});

test("workspace base guides retain each owner's own merge base", () => {
  const section = (mergeBase?: string): Fact<RepoImpact> => ({ ...base, status: "complete", value: { reads: [], callSites: [], unmatched: [], external: [], impact: { ...impact, ...(mergeBase === undefined ? {} : { mergeBase }), modules: { origins: [], modules: Array.from({ length: 4 }, (_, i) => ({ file: `same-${i}.ts`, snapshot: "base" as const, depth: 0, origins: [] })), cost: { expansionsUsed: 0 } } } } });
  const value: WorkspaceImpactValue = { workspace: { repos: ["a", "b", "c"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: "a", mergeBase: "trigger-base" }, sections: { a: section("base-a"), b: section("base-b"), c: section() }, links: [] };
  const output = renderWorkspaceImpact({ ...base, status: "complete", value }, "full");
  assert.match(output, /Base modules: repo "a", revision "base-a"/);
  assert.match(output, /Base modules: repo "b", revision "base-b"/);
  assert.match(output, /Base modules: repo "c", revision unavailable/);
});

test("reached handlers share selector owner while preserving every origin association", () => {
  const entrypoints = Array.from({ length: 8 }, (_, i) => ({ ...impact.entrypoints[0]!, name: `GET /route-${i}`, handler: { path: `src/route-${i}.ts`, symbol: `handler${i}`, line: i + 1 }, seeds: [0] }));
  const text = renderImpact({ ...fact, value: { ...impact, entrypoints } }, "details");
  assert.equal((text.match(/"kind":"handler-origins"/g) ?? []).length, 1);
  for (let i = 0; i < 8; i++) {
    assert.match(text, new RegExp(`GET /route-${i}[^\\n]*handler${i}`));
    assert.match(text, new RegExp(`"path":"src/route-${i}\\.ts","symbol":"handler${i}","line":${i + 1}`));
  }
  assert.match(text, /next 8 handler rows/);
  assert.doesNotMatch(text, /origin association above/);
});

test("module lookups share kind and owner while retaining every literal module coordinate", () => {
  const modules = Array.from({ length: 12 }, (_, i) => ({ file: `src/module-${i}.ts`, snapshot: "head" as const, depth: 1, origins: [0] }));
  const value: ImpactValue = { ...impact, entrypoints: [], modules: { origins: [{ file: "src/origin.ts", change: "modified" }], modules, cost: { expansionsUsed: 12 } } };
  const text = renderImpact({ ...fact, value }, "details");
  assert.equal((text.match(/"kind":"module-origins"/g) ?? []).length, 1);
  for (const module of modules) assert.ok(text.includes(JSON.stringify({ file: module.file, snapshot: module.snapshot })));
  const example = JSON.parse(text.match(/Module lookup:.*complete select example: (\{[^\n]+\})/)![1]!);
  const controls = z.strictObject(recoveryControlShapeFor("impact"));
  for (const row of text.split("\n").filter((line) => line.includes("module: {"))) {
    const module = JSON.parse(row.match(/module: (\{[^}]+\})/)![1]!);
    const request = { select: { kind: example.kind, owner: example.owner, module }, page: { limit: 1 } };
    assert.ok(controls.safeParse(request).success);
    assert.ok(validRecoveryControls("impact", request));
  }
});

test("callers guidance does not advertise module selectors even if reused impact data has modules", () => {
  const value: ImpactValue = { ...impact, modules: { origins: [{ file: "origin.ts", change: "modified" }], modules: [{ file: "consumer.ts", snapshot: "head", depth: 1, origins: [0] }], cost: { expansionsUsed: 1 } } };
  const text = renderImpact({ ...fact, value }, "full", { tool: "callers" });
  assert.doesNotMatch(text, /module lookup uses/);
  assert.match(text, /modules\.origins/);
});

test("equal caller origin support is defined once with every handler association", () => {
  const entrypoints = Array.from({ length: 8 }, (_, i) => ({ ...impact.entrypoints[0]!, name: `GET /route-${i}`, handler: { path: `src/route-${i}.ts`, symbol: `handler${i}`, line: i + 1 }, seeds: [0] }));
  const text = renderImpact({ ...fact, value: { ...impact, entrypoints } }, "details");
  assert.equal((text.match(/one verified origin: first\.ts:2 first/g) ?? []).length, 1);
  assert.match(text, /next 8 handler rows/);
  assert.doesNotMatch(text, /origin association above/);
});

test("different caller confidence does not share origin support", () => {
  const entrypoints = Array.from({ length: 4 }, (_, i) => ({ ...impact.entrypoints[0]!, confidence: i % 2 ? 0.7 : 1, name: `route-${i}`, handler: { path: `route-${i}.ts`, symbol: `h${i}`, line: i + 1 }, seeds: [0] }));
  const text = renderImpact({ ...fact, value: { ...impact, entrypoints } }, "details");
  assert.equal((text.match(/one verified origin: first\.ts:2 first/g) ?? []).length, 4);
  assert.doesNotMatch(text, /origin association above/);
});

test("unavailable recovery keeps the reason and does not promise executable lookup", () => {
  const context = { tool: "callers" as const, recovery: { version: 1 as const, status: "unavailable" as const, reason: "unresolved-context" as const } };
  const text = renderImpact(fact, "details", context);
  assert.match(text, /recovery unavailable.*unresolved-context/i);
  assert.doesNotMatch(text, /lookup example:/);
  assert.match(text, /"path":"route\.ts","symbol":"handler","line":9/);
});

test("unavailable recovery labels cut coordinates without advertising selection", () => {
  const partial: Fact<ImpactValue> = { ...fact, status: "partial", cuts: [{ kind: "depth", at: ["src/file.ts"], limit: 1 }] };
  const text = renderImpact(partial, "details", { tool: "callers", recovery: { version: 1, status: "unavailable", reason: "deadline" } });
  assert.match(text, /cutIndex/);
  assert.doesNotMatch(text, /lookup example:|Selection lookup:/);
  assert.match(text, /deadline/);
});

test("callers guidance uses revision without unrelated impact base advice", () => {
  const text = renderImpact(fact, "details", { tool: "callers" });
  assert.doesNotMatch(text, /instead of impact base\/head|base-side modules/);
  assert.match(text, /revision "abc"/);
});

test("handler rows retain literal coordinates once and scope origin recovery to the category", () => {
  const value = { ...impact, entrypoints: Array.from({ length: 8 }, (_, index) => ({ ...impact.entrypoints[0]!, name: `GET /${index}`, handler: { path: `route ${index}:file.ts`, symbol: "handler", line: 9, endLine: 14 } })) };
  const text = renderImpact({ ...base, status: "complete", value }, "details");
  assert.doesNotMatch(text, /origin association above|; mode: "full" includes all/);
  assert.match(text, /next 8/);
  for (let index = 0; index < 8; index++) {
    assert.match(text, new RegExp(`"path":"route ${index}:file.ts"`));
    assert.doesNotMatch(text, new RegExp(`route ${index}:file.ts:9`));
  }
  assert.match(text, /endLine.*14/);
});


test("singleton categories keep recovery help shorter than the old repeated layout", () => {
  const singleton: ImpactValue = { seeds: [{ file: "a.ts", symbol: "a", line: 1, basis: "lines" }, { file: "b.ts", symbol: "b", line: 1, basis: "lines" }], symbols: [], entrypoints: [{ kind: "http-route", name: "GET /x", handler: { path: "r.ts", symbol: "h", line: 1 }, depth: 1, confidence: 1, seeds: [0, 1] }], cost: { expansionsUsed: 0 } };
  const reached = renderImpact({ ...base, status: "complete", value: singleton }, "details").split("reached entrypoints (1):\n")[1]!.split("impacted symbols")[0]!;
  const oldReached = '  A recorded origin is an association, not a complete call chain.\n  - http-route GET /x -> r.ts:1 h (depth 1); lookup example: {"kind":"handler-origins","owner":{"kind":"local"},"handler":{"path":"r.ts","symbol":"h","line":1}}\n    one verified origin: a.ts:1 a (lines); 1 other origin; mode: "full" includes all\n';
  assert.ok(Buffer.byteLength(reached) <= Buffer.byteLength(oldReached), reached);
  assert.match(reached, /full.*all origin/);

  const modules: ImpactValue = { seeds: [], symbols: [], entrypoints: [], modules: { origins: [{ file: "o.ts", change: "modified" }], modules: [{ file: "c.ts", snapshot: "head", depth: 1, origins: [0] }], cost: { expansionsUsed: 1 } }, cost: { expansionsUsed: 0 } };
  const moduleRows = renderImpact({ ...base, status: "complete", value: modules }, "summary").split("module dependencies (1, not symbol or entrypoint impact):\n")[1]!.split("module expansions")[0]!;
  const oldModules = '  head c.ts [lookup example: {"kind":"module-origins","owner":{"kind":"local"},"module":{"file":"c.ts","snapshot":"head"}}] (depth 1, 1 origin association; mode: "full" includes all)\n';
  assert.ok(Buffer.byteLength(moduleRows) <= Buffer.byteLength(oldModules), moduleRows);
  assert.match(moduleRows, /full.*all origin/);
});
