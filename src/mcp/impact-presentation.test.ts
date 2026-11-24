import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, type Cut, type Fact, type FactBase, type WalkBounds } from "../core/domain/shared/fact.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import { renderImpact, renderImporters, renderWorkspaceImpact } from "./render.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";

const base: FactBase = { schema: SCHEMA, snapshot: { repo: "a", kind: "sha", sha: "abc" }, producer: { name: "test", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "c", declaredConfig: {}, engines: {} }, evidence: [] };
const impact = { seeds: [{ file: "first.ts", line: 2, symbol: "first", basis: "lines" }, { file: "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts", line: 8, symbol: "second", basis: "lines" }], symbols: [], entrypoints: [{ kind: "http-route", name: "GET /x", handler: { path: "route.ts", line: 9, symbol: "handler" }, depth: 1, confidence: 1, seeds: [0, 1] }], cost: { expansionsUsed: 0 } } satisfies ImpactValue;
const fact: Fact<ImpactValue> = { ...base, status: "complete", value: impact };

test("module importer forms remain distinct without repeating related file paths", () => {
  const value: ImportersValue = { files: [{ file: "target.ts", importers: ["static.ts", "shared.ts"], reexporters: ["barrel.ts", "shared.ts"], dynamicImporters: ["dynamic.ts"], typeImporters: ["type.ts"], users: ["static.ts", "shared.ts", "barrel.ts", "dynamic.ts", "type.ts", "other.ts"], unresolvedNamers: ["dynamic.ts", "unknown.ts"] }] };
  const original = structuredClone(value);
  const text = renderImporters({ ...base, status: "complete", value }, "details");
  assert.match(text, /barrel\.ts": reexporters\[0\], users\[2\]/);
  assert.match(text, /dynamic\.ts": dynamic importers\[0\], users\[3\], also unresolved name matches\[0\]/);
  assert.match(text, /type\.ts": type importers\[0\], users\[4\]/);
  for (const file of ["static.ts", "shared.ts", "barrel.ts", "dynamic.ts", "type.ts", "other.ts", "unknown.ts"]) assert.equal(text.split(file).length - 1, 1, text);
  assert.deepEqual(value, original);
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
  assert.match(summary, /20.*answer\.json/);
  assert.doesNotMatch(summary, /unserved-service-0/);
  assert.doesNotMatch(full, /unserved-service-0/);
  assert.match(full, /20.*answer\.json/);
});

test("workspace cut anchors and distinct limits stay with their owning repository", () => {
  const symbols = Array.from({ length: 8 }, (_, i) => ({ file: "same-relative-path.ts", line: i + 1, symbol: `use${i}`, kind: "function", depth: 0, confidence: 1, fanIn: 0 }));
  const section = (depth: number): Fact<RepoImpact> => ({
    ...base, status: "partial",
    cuts: [{ kind: "depth", at: ["same-relative-path.ts::use0"], limit: depth + 1, reason: "depth", reach: { kind: "anything" } }, ...symbols.slice(1).map((symbol) => ({ kind: "depth" as const, at: [`${symbol.file}::${symbol.symbol}`], limit: depth + 1, reason: "depth" as const, reach: { kind: "anything" as const } }))],
    value: { reads: [], callSites: [], unmatched: [], external: [], unresolved: [], impact: { ...impact, seeds: [], entrypoints: [], symbols: symbols.map((symbol) => ({ ...symbol, depth })) } },
  });
  const value: WorkspaceImpactValue = {
    workspace: { repos: ["a", "b"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" },
    repositorySnapshots: [], trigger: { repo: "a" }, sections: { a: section(0), b: section(4) }, links: [],
  };
  const workspaceFact: Fact<WorkspaceImpactValue> = { ...base, status: "partial", cuts: [{ kind: "section", at: ["a", "b"], reason: "section-partial", reach: { kind: "anything" } }], value };
  for (const detail of ["summary", "details"] as const) {
    const output = renderWorkspaceImpact(workspaceFact, detail);
    const a = output.split("cuts for repository a:")[1]?.split("cuts for repository b:")[0] ?? "";
    const b = output.split("cuts for repository b:")[1] ?? "";
    if (detail === "details") {
      assert.match(a, /depth \(limit 1\)[\s\S]*same-relative-path\.ts::use0/);
      assert.match(b, /depth \(limit 5\)[\s\S]*same-relative-path\.ts::use0/);
    } else {
      assert.match(a, /8 depth \(limit 1\)/);
      assert.match(b, /8 depth \(limit 5\)/);
      assert.doesNotMatch(a + b, /::use0/);
      assert.match(output, /"kind":"cut-places","owner":\{"kind":"section","repo":"a"\}/);
      assert.match(output, /"kind":"cut-places","owner":\{"kind":"section","repo":"b"\}/);
    }
  }
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

test("impact detail localizes cut anchors and limits while counting their reference places", () => {
  const partial: Fact<ImpactValue> = { ...base, status: "partial", value: impact, cuts: [
    { kind: "unresolved-link", at: ["service.ts::Service.read", "consumer-a.ts:12", "consumer-b.ts:91"], reason: "hidden-caller", reach: { kind: "anything" } },
    { kind: "depth", at: ["route.ts::handler"], limit: 4, reason: "depth", reach: { kind: "anything" } },
  ] };
  const summary = renderImpact(partial);
  const detail = renderImpact(partial, "details");
  assert.match(summary, /unresolved-link/);
  assert.match(summary, /depth[^\n]*limit 4/);
  assert.doesNotMatch(summary, /consumer-a\.ts|Service\.read/);
  assert.match(detail, /service\.ts[\s\S]*Service\.read/);
  assert.match(detail, /consumer-a\.ts:12/);
  assert.match(detail, /consumer-b\.ts:91/);
  assert.match(detail, /depth \(limit 4\)[\s\S]*route\.ts::handler/);

});

test("impact detail says where the property a reassignable cut's calls run may have been replaced, in both layouts", () => {
  const reassignable: Cut = { kind: "unresolved-link", at: ["page.ts", "page.ts:16 this.wallet.balance"], reason: "reassignable", cause: ["overdraft.ts:2 reassignment", "wallet.ts:9 reassignment"], reach: { kind: "anything" } };
  const detail = renderImpact({ ...base, status: "partial", value: impact, cuts: [reassignable] }, "details");
  assert.match(detail, /reassignable[\s\S]*overdraft\.ts:2 reassignment[\s\S]*wallet\.ts:9 reassignment/);
  const many: Cut[] = Array.from({ length: 12 }, (_, line) => ({ ...reassignable, at: [`page-${line}.ts`, `page-${line}.ts:1 this.wallet.balance`] }));
  assert.match(renderImpact({ ...base, status: "partial", value: impact, cuts: many as [Cut, ...Cut[]] }, "details"), /reassignable[\s\S]*overdraft\.ts:2 reassignment[\s\S]*wallet\.ts:9 reassignment/);
});

test("impact guidance explains contextual full lookups and the origin-index join", () => {
  const value: ImpactValue = { ...impact, symbols: [{ file: "caller.ts", symbol: "use", kind: "function", line: 12, depth: 1, confidence: 1, fanIn: 0, via: { file: "first.ts", symbol: "first", lines: [15], basis: "reference" } }] };
  for (const detail of ["summary", "details"] as const) {
    const [body, guide = ""] = renderImpact({ ...fact, value }, detail).split("Investigation guide:");
    assert.match(body!, /origins 0, 1/);
    assert.doesNotMatch(guide, /answer\.json/);
    assert.doesNotMatch(guide, /value\.entrypoints|value\.symbols|value\.seeds/);
  }
  {
    const guide = renderImpact({ ...fact, value }, "full").split("Investigation guide:")[1] ?? "";
    assert.ok(guide.includes("value.entrypoints"));
    assert.ok(guide.includes("handler.path") && guide.includes("handler.symbol") && guide.includes("handler.line"));
    assert.ok(guide.includes("zero-based") && guide.includes("value.seeds"));
    assert.ok(guide.includes("value.symbols") && guide.includes("via.lines") && guide.includes("symbol's own file"));
    assert.ok(guide.includes("same snapshot"));
    assert.doesNotMatch(guide, /value\.links|value\.sections/);
  }
});

test("workspace guidance qualifies repository payloads and joins reach entries to the link keys the text prints as numbers", () => {
  const link = { id: "link-a", from: { repo: "a", file: "call.ts", symbol: "send", line: 4 }, to: { repo: "b", kind: "http-route" as const, name: "GET /x", handler: { path: "route.ts", line: 9, symbol: "handler" } }, transport: "http" as const, basis: "route-overlap" as const, confidence: 0.6 };
  const value: WorkspaceImpactValue = {
    workspace: { repos: ["a", "b"], gateways: [], unmatchedGateways: [], unserved: ["missing-api"], source: "request" }, repositorySnapshots: [], trigger: { repo: "a" },
    sections: { a: { ...base, status: "complete", value: { reads: [], impact, callSites: [], unmatched: [], external: [], unresolved: [] } }, b: { ...base, status: "unknown", reason: "index-unavailable" } },
    links: [{ link, direction: "downstream", reach: ["link-a"] }],
  };
  const text = renderWorkspaceImpact({ ...base, status: "complete", value }, "details").split("Investigation guide:")[1] ?? "";
  assert.doesNotMatch(text, /value\.sections|value\.links|Destination:/);
  const guide = renderWorkspaceImpact({ ...base, status: "complete", value }, "full").split("Investigation guide:")[1] ?? "";
  assert.ok(guide.includes('value.sections["a"].value.impact'));
  assert.ok(guide.includes("section.status") && guide.includes("value.reads"));
  assert.ok(guide.includes("value.links") && guide.includes("reach") && guide.includes("link.id"));
  assert.ok(guide.includes("link.id values") && guide.includes("link numbers the text prints"));
  assert.ok(guide.includes("value.workspace.unserved") && guide.includes("ye_ast_workspace"));
  assert.doesNotMatch(guide, /value\.entrypoints/);
});

test("unknown and verified-empty impact guidance distinguishes missing analysis from scoped emptiness", () => {
  const unknownFact: Fact<ImpactValue> = { ...base, status: "unknown", reason: "no-extractor", evidence: [{ path: "src/legacy.cob", line: 3 }] };
  for (const detail of ["summary", "details"] as const) {
    const unknown = renderImpact(unknownFact, detail);
    assert.match(unknown, /status: unknown \(no-extractor\)\n {2}evidence: src\/legacy\.cob:3/);
    assert.doesNotMatch(unknown, /result JSON|value\.[a-z]|no recorded consequences|budget|narrower/);
    assert.doesNotMatch(unknown, /mode "details" (locates|shows|lists)|answer\.json (includes|lists|returns)/);
  }
  const unknownFull = renderImpact(unknownFact, "full");
  assert.match(unknownFull, /reason and evidence in the result JSON/);
  assert.doesNotMatch(unknownFull, /value\.[a-z]/);
  const deadline = renderImpact({ ...base, status: "unknown", reason: "deadline" }, "summary", { tool: "callers" });
  assert.match(deadline, /narrower scope or fewer targets/);
  const emptyFact = { ...fact, value: { ...impact, seeds: [], symbols: [], entrypoints: [] } };
  const empty = renderImpact(emptyFact, "details");
  assert.match(empty, /status: complete/);
  assert.doesNotMatch(empty, /Investigation guide:|Full JSON navigation|ye_ast_callers/);
  const full = renderImpact(emptyFact, "full");
  assert.match(full, /no recorded consequences/);
  assert.match(full, /declared scope/);
  assert.doesNotMatch(full, /value\.entrypoints|value\.symbols|value\.seeds|ye_ast_callers/);
});

test("full workspace guidance does not imply another walk when only the trigger has one", () => {
  const value: WorkspaceImpactValue = {
    workspace: { repos: ["a", "b"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" },
    repositorySnapshots: [], trigger: { repo: "a" },
    sections: {
      a: { ...base, status: "complete", value: { reads: [], impact, callSites: [], unmatched: [], external: [], unresolved: [] } },
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
  const section = (mergeBase?: string): Fact<RepoImpact> => ({ ...base, status: "complete", value: { reads: [], callSites: [], unmatched: [], external: [], unresolved: [], impact: { ...impact, ...(mergeBase === undefined ? {} : { mergeBase }), modules: { origins: [], modules: Array.from({ length: 4 }, (_, i) => ({ file: `same-${i}.ts`, snapshot: "base" as const, depth: 0, origins: [] })), cost: { expansionsUsed: 0 } } } } });
  const value: WorkspaceImpactValue = { workspace: { repos: ["a", "b", "c"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: "a", mergeBase: "trigger-base" }, sections: { a: section("base-a"), b: section("base-b"), c: section() }, links: [] };
  const output = renderWorkspaceImpact({ ...base, status: "complete", value }, "full");
  assert.match(output, /Base modules: repo "a", revision "base-a"/);
  assert.match(output, /Base modules: repo "b", revision "base-b"/);
  assert.match(output, /Base modules: repo "c", revision unavailable/);
});

test("text base guides keep the literal coordinate and never point at JSON the answer lacks", () => {
  const modules = Array.from({ length: 5 }, (_, i) => ({ file: `src/base-${i}.ts`, snapshot: "base" as const, depth: 0, origins: [] }));
  const local: ImpactValue = { ...impact, mergeBase: "base-a", modules: { origins: [], modules, cost: { expansionsUsed: 0 } } };
  const section: Fact<RepoImpact> = { ...base, status: "complete", value: { reads: [], callSites: [], unmatched: [], external: [], unresolved: [], impact: local } };
  const value: WorkspaceImpactValue = { workspace: { repos: ["a", "b"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: "a" }, sections: { a: section, b: section }, links: [] };
  for (const mode of ["summary", "details"] as const) {
    const localText = renderImpact({ ...fact, value: local }, mode);
    const workspaceText = renderWorkspaceImpact({ ...base, status: "complete", value }, mode);
    for (const text of [localText, workspaceText]) {
      assert.doesNotMatch(text.split("Investigation guide:")[1]!, /value\.(repositorySnapshots|sections|modules)/);
      for (const module of modules) assert.ok(text.includes(JSON.stringify(module.file)) || text.includes(module.file));
    }
    for (const repo of ["a", "b"]) assert.match(workspaceText, new RegExp(`Base modules \\(5\\): repo "${repo}", revision "base-a"`));
  }
});

test("text base guides stay bounded as base modules grow and name the answer file recovery", () => {
  const guideFor = (count: number, mode: "summary" | "details"): string => {
    const modules = Array.from({ length: count }, (_, i) => ({ file: `src/base-${i}.ts`, snapshot: "base" as const, depth: 0, origins: [] }));
    const local: ImpactValue = { ...impact, mergeBase: "base-a", modules: { origins: [], modules, cost: { expansionsUsed: 0 } } };
    return renderImpact({ ...fact, value: local }, mode).split("Investigation guide:")[1]!;
  };
  for (const mode of ["summary", "details"] as const) {
    const small = guideFor(40, mode);
    const large = guideFor(400, mode);
    assert.equal(large.split("\n").length, small.split("\n").length);
    assert.match(large, /Base modules \(400\): repo "a", revision "base-a"/);
    assert.match(large, /answer\.json lists every one/);
    assert.doesNotMatch(large, /Base module: /);
    assert.doesNotMatch(large, /value\.modules/);
  }
});

test("full mode keeps its base module guide", () => {
  const modules = Array.from({ length: 400 }, (_, i) => ({ file: `src/base-${i}.ts`, snapshot: "base" as const, depth: 0, origins: [] }));
  const local: ImpactValue = { ...impact, mergeBase: "base-a", modules: { origins: [], modules, cost: { expansionsUsed: 0 } } };
  const guide = renderImpact({ ...fact, value: local }, "full").split("Investigation guide:")[1]!;
  assert.match(guide, /Base modules: repo "a", revision "base-a"; inspect value\.modules\.modules\[\] for each base module's file/);
  assert.doesNotMatch(guide, /Base module: /);
});

test("callers guidance does not advertise module selectors even if reused impact data has modules", () => {
  const value: ImpactValue = { ...impact, modules: { origins: [{ file: "origin.ts", change: "modified" }], modules: [{ file: "consumer.ts", snapshot: "head", depth: 1, origins: [0] }], cost: { expansionsUsed: 1 } } };
  const text = renderImpact({ ...fact, value }, "full", { tool: "callers" });
  assert.doesNotMatch(text, /module lookup uses/);
  assert.match(text, /modules\.origins/);
});

test("unavailable recovery keeps the reason and does not promise executable lookup", () => {
  const context = { tool: "callers" as const, recovery: { version: 1 as const, status: "unavailable" as const, reason: "unresolved-context" as const } };
  const text = renderImpact(fact, "details", context);
  assert.match(text, /recovery unavailable.*unresolved-context/i);
  assert.doesNotMatch(text, /lookup example:/);
  assert.match(text, /9 http-route GET \/x -> handler \(depth/);
});

test("unavailable recovery labels cut coordinates without advertising selection", () => {
  const partial: Fact<ImpactValue> = { ...fact, status: "partial", cuts: [{ kind: "depth", at: ["src/file.ts"], limit: 1, reason: "depth", reach: { kind: "anything" } }] };
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

test("a handler symbol with whitespace keeps a complete literal selector on every row", () => {
  const value = { ...impact, entrypoints: Array.from({ length: 8 }, (_, index) => ({ ...impact.entrypoints[0]!, name: `GET /${index}`, handler: { path: `route-${index}.ts`, symbol: index === 7 ? "default export" : "handler", line: 9 } })) };
  const text = renderImpact({ ...base, status: "complete", value }, "details");
  assert.doesNotMatch(text, /Handler lookup:/);
  assert.equal((text.match(/lookup example: \{"kind":"handler-origins"/g) ?? []).length, 8);
});

test("established walk bounds name their budget field; ambiguous or unrecorded bounds name none", () => {
  const cuts: [Cut, ...Cut[]] = [{ kind: "depth", at: ["a.ts::a"], limit: 2, reason: "depth", reach: { kind: "anything" } }, { kind: "hub", at: ["b.ts::b"], limit: 40, reason: "hub", reach: { kind: "anything" } }, { kind: "caller-budget", at: ["c.ts::c"], limit: 9, reason: "caller-budget", reach: { kind: "anything" } }];
  const withWalk = (walk?: WalkBounds): Fact<ImpactValue> => ({ ...base, inputs: { ...base.inputs, declaredConfig: walk === undefined ? {} : { walk } }, status: "partial", cuts, value: { ...impact, entrypoints: [] } });
  for (const detail of ["summary", "details", "full"] as const) {
    const established = renderImpact(withWalk({ depth: 2, hubFanIn: 40, expansions: 9 }), detail);
    assert.match(established, /budget\.depth 2/, detail);
    assert.match(established, /budget\.hubFanIn 40/, detail);
    assert.doesNotMatch(established, /budget\.expansions/, detail);
    assert.doesNotMatch(renderImpact(withWalk(), detail), /budget\./, detail);
    assert.doesNotMatch(renderImpact(withWalk({ depth: 3, hubFanIn: 41 }), detail), /budget\./, detail);
  }
  const workspace: WorkspaceImpactValue = {
    workspace: { repos: ["a"], gateways: [], unmatchedGateways: [], unserved: [], source: "none" }, repositorySnapshots: [], trigger: { repo: "a" },
    sections: { a: { ...base, inputs: { ...base.inputs, declaredConfig: { walk: { depth: 2 } } }, status: "partial", cuts, value: { reads: [], impact: { ...impact, entrypoints: [] }, callSites: [], unmatched: [], external: [], unresolved: [] } } }, links: [],
  };
  const sectionText = renderWorkspaceImpact({ ...base, status: "partial", cuts: [{ kind: "section", at: ["a"], reason: "section-partial", reach: { kind: "anything" } }], value: workspace }, "summary").split("cuts for repository a:")[1] ?? "";
  assert.match(sectionText, /depth cuts stopped at the walk bound budget\.depth 2/);
  assert.doesNotMatch(sectionText, /budget\.(hubFanIn|expansions)/);
});

test("workspace follow-up guidance appears only where its condition holds", () => {
  const empty: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };
  const section = (value: ImpactValue): Fact<RepoImpact> => ({ ...base, status: "complete", value: { reads: [], impact: value, callSites: [], unmatched: [], external: [], unresolved: [] } });
  const workspace = (sections: WorkspaceImpactValue["sections"], links: WorkspaceImpactValue["links"] = []): Fact<WorkspaceImpactValue> => ({
    ...base, status: "complete",
    value: { workspace: { repos: Object.keys(sections), gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: "a" }, sections, links },
  });
  const link = { id: "link-a", from: { repo: "b", file: "call.ts", symbol: "send", line: 4 }, to: { repo: "a", kind: "http-route" as const, name: "GET /x", handler: { path: "route.ts", line: 9, symbol: "handler" } }, transport: "http" as const, basis: "route-overlap" as const, confidence: 1 };
  const unavailable = { tool: "impact" as const, recovery: { version: 1 as const, status: "unavailable" as const, reason: "redacted-context" as const } };
  for (const detail of ["summary", "details"] as const) {
    assert.doesNotMatch(renderWorkspaceImpact(workspace({ a: section(empty) }), detail), /Investigation guide:/, detail);
    const bound = renderWorkspaceImpact(workspace({ a: section(impact) }), detail);
    assert.match(bound, /Investigation guide:/, detail);
    assert.doesNotMatch(bound, /recorded owner/, detail);
    const linked = renderWorkspaceImpact(workspace({ a: section(impact), b: section(impact) }, [{ link, direction: "upstream", reach: ["link-a"] }]), detail, unavailable);
    assert.match(linked, /recorded owner/, detail);
    assert.equal(linked.split("Recovery unavailable (redacted-context)").length - 1, 1, detail);
  }
  assert.doesNotMatch(renderWorkspaceImpact(workspace({ a: section(impact) }), "full"), /recorded owner/);
  assert.match(renderWorkspaceImpact(workspace({ a: section(impact), b: section(impact) }), "full"), /recorded owner/);
});

test("a reached UI route names the place its route entry is declared at", () => {
  const value: ImpactValue = { ...impact, entrypoints: [{ kind: "ui-route", name: "/orders", handler: { path: "src/orders.page.ts", symbol: "OrdersPage", line: 5 }, depth: 1, confidence: 1, seeds: [0], declaredAt: { path: "src/routes.ts", line: 12 } }] };
  const output = renderImpact({ ...fact, value }, "details");
  assert.match(output, /ui-route \/orders -> OrdersPage \(depth 1, origins 0, at src\/routes\.ts:12\)/);
});

test("a reached HTTP route names no declaration place", () => {
  const output = renderImpact({ ...fact, value: { ...impact, entrypoints: [{ ...impact.entrypoints[0]!, name: "GET /orders" }] } }, "details");
  assert.doesNotMatch(output, / at src\/routes\.ts/);
});

const dependent = (index: number, depth: number) => ({ file: `src/dep-${index}.ts`, symbol: `dep${index}`, kind: "function", line: index + 1, depth, confidence: 1, fanIn: 0 });

test("a summary says when no dependent is recorded, with or without containment rows", () => {
  const contains = { file: "src/owner.ts", symbol: "Owner", kind: "class", line: 1, depth: 0, confidence: 1, fanIn: 0, via: { file: "src/owner.ts", symbol: "Owner.find", lines: [], basis: "contains" as const } };
  for (const symbols of [[], [contains]]) {
    const text = renderImpact({ ...fact, value: { ...impact, seeds: [{ file: "src/owner.ts", symbol: "Owner.find", line: 3, basis: "requested" }], entrypoints: [], symbols } as ImpactValue });
    assert.match(text, /no dependent recorded/, JSON.stringify(symbols));
  }
  assert.doesNotMatch(renderImpact({ ...fact, value: { ...impact, entrypoints: [], symbols: [dependent(0, 1)] } as ImpactValue }), /no dependent recorded/);
});
