import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContractConsequences, renderDecisions, renderEntrypointMap, renderImpact, renderImporters, renderTrace, renderWorkspace, renderWorkspaceImpact } from "./render.ts";
import { renderFactHeader } from "./presentation-context.ts";
import { ANYTHING, CAPABILITY_ABSENT, SCHEMA, type Cut, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { ConsequencesValue, HypothesisAnswer } from "../core/domain/contracts/consequence-fact.ts";

const base: FactBase = { schema: SCHEMA, snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
const partial = <T>(value: T, cuts: readonly Cut[]): Fact<T> => ({ ...base, status: "partial", value, cuts: cuts as [Cut, ...Cut[]] });
const complete = <T>(value: T): Fact<T> => ({ ...base, status: "complete", value });
const call = (at: string, reason: Cut["reason"], subReason?: Cut["subReason"]): Cut => ({ kind: "unresolved-link", at: [at, "src/a.ts::A.save"], reason, ...(subReason === undefined ? {} : { subReason }), reach: { kind: "call-at", place: at } });
const DISPATCH = call("src/flow.ts:2 save", "dispatch", CAPABILITY_ABSENT);
const RECEIVER = call("src/flow.ts:9 port.save", "receiver-unproven");
const DEPTH: Cut = { kind: "depth", at: ["src/flow.ts::deep"], limit: 2, reason: "depth", reach: ANYTHING };

test("the status line counts cuts by kind and reason, and a bound whose reason is its kind is named once", () => {
  const fact = partial(null, [RECEIVER, DISPATCH, call("src/flow.ts:11 port.save", "receiver-unproven"), DEPTH, { kind: "section", at: ["web"], reason: "section-partial", reach: ANYTHING }]);
  assert.equal(renderFactHeader(fact)[0], "status: partial (cuts: 2 unresolved-link receiver-unproven, 1 depth, 1 section section-partial: web, 1 unresolved-link dispatch)");
});

const answer = (findings: HypothesisAnswer["findings"]): HypothesisAnswer => ({ hypothesis: { method: "GET", path: "/orders", target: "response", property: "id", change: "removed" }, oldContract: "guaranteed-the-old-values" as never, status: "complete", findings });
const unknownFinding = { status: "unknown", reason: "unresolved", evidence: [] } as const;

test("a complete collection with unknown items states how many are undecided, and a bare complete stays bare", () => {
  const routes = (items: readonly unknown[]) => complete({ entrypoints: complete(items) }) as never;
  const map = renderEntrypointMap(routes([unknownFinding, unknownFinding]), "summary").split("\n");
  assert.equal(map[0], "status: complete (2 undecided)");
  assert.ok(map.includes("  status: complete (2 undecided)"), map.join("\n"));
  assert.equal(renderEntrypointMap(routes([]), "summary").split("\n")[0], "status: complete");

  const site = { reason: "unresolved", evidence: [{ path: "src/a.ts", line: 4 }], path: "src/a.ts", line: 4, symbol: "call", transport: "http" };
  const workspace = (unresolved: readonly unknown[]) => complete({ workspace: { repos: ["a"], source: "request" }, repositorySnapshots: [], sections: { a: complete({ names: [], unresolved }) }, candidates: [], links: [], unlinked: [], unserved: [] }) as never;
  assert.equal(renderWorkspace(workspace([site]), "summary").split("\n")[0], "status: complete (1 undecided)");
  assert.equal(renderWorkspace(workspace([]), "summary").split("\n")[0], "status: complete");

  const decisions = (unresolved: readonly unknown[]) => complete({ decisions: [], repositories: [], source: "request", unresolved }) as never;
  assert.equal(renderDecisions(decisions([{ repo: "a", ...site }]), "summary").split("\n")[0], "status: complete (1 undecided)");
  assert.equal(renderDecisions(decisions([]), "summary").split("\n")[0], "status: complete");

  const consequences = renderContractConsequences(complete<ConsequencesValue>({ repositorySnapshots: [], answers: [answer([unknownFinding])] }), "details").split("\n");
  assert.equal(consequences[0], "status: complete (1 undecided)");
  assert.match(consequences.find((line) => line.startsWith("  1. "))!, /: complete \(1 undecided\)$/);
});

test("a composite whose only cut is one unknown section prints that section's status and reason", () => {
  const sectionCut = (at: string): Cut => ({ kind: "section", at: [at], reason: "section-unknown", reach: ANYTHING });
  const unknownAnswer: HypothesisAnswer = { ...answer([]), status: "unknown", reason: "no-extractor", detail: "d" };
  const consequences = partial<ConsequencesValue>({ repositorySnapshots: [], answers: [unknownAnswer] }, [sectionCut("answers.0")]);
  assert.equal(renderContractConsequences(consequences, "summary").split("\n")[0], "status: partial (section answers.0: unknown (no-extractor))");

  const value = { workspace: { repos: ["web"], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [], trigger: { repo: "web" }, sections: { web: { ...base, status: "unknown", reason: "deadline" } }, links: [] };
  assert.equal(renderWorkspaceImpact(partial(value, [sectionCut("web")]) as never).split("\n")[0], "status: partial (section web: unknown (deadline))");
  assert.equal(renderWorkspaceImpact(partial(value, [sectionCut("web"), DEPTH]) as never).split("\n")[0], "status: partial (cuts: 1 depth, 1 section section-unknown: web)");
});

function trace(cuts: readonly Cut[]): Fact<TraceValue> {
  return partial<TraceValue>({ roots: [{ target: "src/flow.ts:1-20", steps: [0] }], steps: [{ id: 0, depth: 0, file: "src/flow.ts", symbol: "run", kind: "function", line: 1, endLine: 20 }], readingPlan: { ranges: [{ file: "src/flow.ts", start: 1, end: 20, steps: [0] }], lines: 20 }, cost: { expanded: 1 } }, cuts);
}

test("a trace call cut renders its reason, with its sub-reason, in summary and details", () => {
  const fact = trace([DISPATCH, RECEIVER]);
  const summary = renderTrace(fact, "summary").split("\n");
  assert.ok(summary.includes("    dispatch (capability-absent): save ×1 in 1 file → could be: A.save"), summary.join("\n"));
  assert.ok(summary.includes("    receiver-unproven: save ×1 in 1 file → could be: A.save"), summary.join("\n"));
  const details = renderTrace(fact, "details").split("\n");
  assert.ok(details.includes("    dispatch (capability-absent): src/flow.ts:2 save (src/a.ts::A.save)"), details.join("\n"));
  assert.ok(details.includes("    receiver-unproven: src/flow.ts:9 port.save (src/a.ts::A.save)"), details.join("\n"));
});

test("details print the reason, with its sub-reason, on every other cut row; a summary row stays as it was", () => {
  const specifier: Cut = { kind: "unresolved-link", at: ["src/b.ts", "src/b.ts:4 ./missing"], reason: "specifier", reach: ANYTHING };
  const noExtractor: Cut = { kind: "no-extractor", at: ["src/c.ts"], reason: "language", reach: ANYTHING };
  const template: Cut = { kind: "no-extractor", at: ["src/d.vue"], reason: "template-uncovered", reach: ANYTHING };
  const importers = partial({ files: [] }, [specifier, noExtractor, template]);
  const details = renderImporters(importers, "details").split("\n");
  assert.ok(details.includes("  unresolved-link specifier at src/b.ts: line 4 (./missing)"), details.join("\n"));
  assert.ok(details.includes("  no-extractor language (1): src/c.ts"), details.join("\n"));
  assert.ok(details.includes("  no-extractor template-uncovered (1): src/d.vue"), details.join("\n"));
  assert.ok(renderImporters(importers, "summary").split("\n").includes("  no-extractor (2): src/c.ts, src/d.vue"));

  const impact = renderImpact(partial({ seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } }, [RECEIVER, DISPATCH, DEPTH]), "details");
  assert.match(impact, /receiver-unproven/);
  assert.match(impact, /dispatch \(capability-absent\)/);
});
