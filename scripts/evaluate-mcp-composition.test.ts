import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComposeQuery } from "../src/mcp/query-schema.ts";
import {
  CATEGORIES, EvaluationInputError, orderVariants, parseCorpus, redactEnvironment, scoreRun, selectQueries, type Category, type Judgment, type ResponseLine,
} from "./evaluate-mcp-composition.ts";

// A controlled run directory: the scorer's input contract, not a product run. Ids are chosen so that a part, a relation
// and a read are distinct, and the two baseline responses belong to different families.
const PART = `p1:${"a".repeat(64)}`;
const RELATION = `l1:${"b".repeat(64)}`;
const READ = `r1:${"c".repeat(64)}`;
const MISSING = `l1:${"f".repeat(64)}`;

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

type KeyedProposition = { id: string; kind: "required" | "forbidden" | "uncertainty"; text: string; category?: Category; composed?: string[]; baseline?: string[]; applicable: boolean | "unknown" };

const PROPOSITIONS: KeyedProposition[] = [
  { id: "p1", kind: "required", text: "dependence recorded", composed: ["relations"], baseline: ["callers"], applicable: true },
  { id: "p2", kind: "forbidden", category: "import-as-call", text: "import proves call", applicable: true },
  { id: "p3", kind: "uncertainty", text: "a read is partial", composed: ["reads"], baseline: ["importers"], applicable: true },
  { id: "p4", kind: "forbidden", category: "unknown-as-empty", text: "everything complete", applicable: false },
];

function runDir(propositions: KeyedProposition[] = PROPOSITIONS): string {
  const dir = mkdtempSync(join(tmpdir(), "ye-ast-eval-test-"));
  scratch.push(dir);
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(value));
  };
  const expectedResponses = (["baseline", "composed"] as const).flatMap(condition => [1, 2].map(replicate => ({ caseId: "c", condition, order: "original", replicate })));
  write("manifest.json", { expectedResponses });
  write("answer-key.json", { cases: { c: { families: ["callers", "importers"], propositions } } });
  write("outputs/c/baseline/q0.full.json", { text: "", isError: false, structured: { value: { symbols: [{ callers: ["x"] }] } } });
  write("outputs/c/baseline/q1.full.json", { text: "", isError: false, structured: { value: { files: [{ "a/b": 1 }] } } });
  write("outputs/c/composed/full.json", { text: "", isError: false, structured: { graph: { parts: [{ id: PART }], relations: [{ id: RELATION }], reads: [{ id: READ }] } } });
  return dir;
}

function response(overrides: Partial<ResponseLine> = {}): ResponseLine {
  return {
    caseId: "c", condition: "composed", order: "original", replicate: 1, model: "test-consumer", answer: "The dependence is recorded.",
    claims: [{ id: "p1", text: "recorded dependence", citations: [RELATION] }],
    uncertainties: [{ id: "p3", text: "partial read", citations: [READ] }],
    ...overrides,
  };
}

function judged(line: ResponseLine, verdicts: Partial<Record<string, Judgment["verdict"]>> = {}, extra: Partial<Judgment> = {}): Judgment[] {
  const base = { caseId: line.caseId, condition: line.condition, order: line.order, replicate: line.replicate, reason: "checked against cited support" };
  return [
    ...[...line.claims, ...line.uncertainties].map(a => ({ ...base, claimId: a.id, verdict: verdicts[a.id] ?? "supported", supports: a.citations, ...extra })),
    { ...base, claimId: "answer", verdict: verdicts.answer ?? "consistent", supports: [] },
  ] as Judgment[];
}

const jsonl = (...lines: unknown[]) => lines.map(line => JSON.stringify(line)).join("\n");
const adjudicated = (judgments: Judgment[]) => ({ adjudicator: { kind: "human", id: "reviewer" }, judgments });
const scoreOf = (report: ReturnType<typeof scoreRun>, condition = "composed", replicate = 1) => report.responses.find(r => r.key === `c|${condition}|original|${replicate}`)!;
const codes = (report: ReturnType<typeof scoreRun>, condition?: string, replicate?: number) => scoreOf(report, condition, replicate).failures.map(f => f.code);

describe("scoring citations", () => {
  it("fails a composed id absent from the prepared graph, and a baseline pointer that selects nothing", () => {
    const dir = runDir();
    const composed = response({ claims: [{ id: "p1", text: "t", citations: [MISSING] }] });
    const baseline = response({ condition: "baseline", claims: [{ id: "p1", text: "t", citations: ["q0:/value/symbols/3"] }], uncertainties: [{ id: "p3", text: "t", citations: ["q1:/value/files/0/a~1b"] }] });
    const report = scoreRun(dir, jsonl(composed, baseline), adjudicated([...judged(composed), ...judged(baseline)]));
    assert.deepEqual(scoreOf(report).failures, [{ code: "unresolved-citation", claimId: "p1", citation: MISSING }]);
    // The escaped pointer of q1 resolves; only the out-of-range index fails.
    assert.deepEqual(scoreOf(report, "baseline").failures, [{ code: "unresolved-citation", claimId: "p1", citation: "q0:/value/symbols/3" }]);
  });

  it("does not accept an id of the other condition: a graph id in a baseline response does not resolve", () => {
    const line = response({ condition: "baseline", claims: [{ id: "p1", text: "t", citations: [RELATION] }], uncertainties: [] });
    assert.deepEqual(codes(scoreRun(runDir(), jsonl(line), adjudicated(judged(line))), "baseline"), ["unresolved-citation"]);
  });

  it("fails a resolvable citation from a table or family the proposition does not admit", () => {
    const composed = response({ claims: [{ id: "p1", text: "t", citations: [PART] }] });
    const baseline = response({ condition: "baseline", claims: [{ id: "p1", text: "t", citations: ["q1:/value/files"] }], uncertainties: [] });
    const report = scoreRun(runDir(), jsonl(composed, baseline), adjudicated([...judged(composed), ...judged(baseline)]));
    assert.deepEqual(codes(report), ["inadmissible-citation"]);
    assert.deepEqual(codes(report, "baseline"), ["inadmissible-citation"]);
  });

  it("fails a claim with no citation", () => {
    const line = response({ claims: [{ id: "p1", text: "t", citations: [] }] });
    assert.deepEqual(codes(scoreRun(runDir(), jsonl(line), adjudicated(judged(line)))), ["uncited-claim"]);
  });
});

describe("scoring material failures", () => {
  it("fails an applicable forbidden proposition with its category even when a judgment calls it supported", () => {
    const line = response({ claims: [...response().claims, { id: "p2", text: "the import shows a call", citations: [RELATION] }] });
    const report = scoreRun(runDir(), jsonl(line), adjudicated(judged(line)));
    assert.equal(scoreOf(report).status, "fail");
    assert.deepEqual(codes(report), ["import-as-call"]);
  });

  it("maps every corpus category of an asserted forbidden proposition to a failure of that category", () => {
    for (const category of CATEGORIES) {
      const dir = runDir([...PROPOSITIONS.filter(p => p.id !== "p2"), { id: "p2", kind: "forbidden", category, text: "x", applicable: true }]);
      const line = response({ claims: [...response().claims, { id: "p2", text: "x", citations: [PART] }] });
      assert.deepEqual(codes(scoreRun(dir, jsonl(line), adjudicated(judged(line)))), [category], category);
    }
  });

  it("leaves a forbidden proposition that does not apply to adjudication instead of failing it", () => {
    const line = response({ claims: [...response().claims, { id: "p4", text: "complete", citations: [READ] }] });
    const unjudged = scoreRun(runDir(), jsonl(line), adjudicated(judged(response())));
    assert.equal(scoreOf(unjudged).status, "not_evaluated");
    assert.ok(scoreOf(unjudged).pending.includes("judgment for p4"));
    assert.equal(scoreOf(scoreRun(runDir(), jsonl(line), adjudicated(judged(line)))).status, "pass");
  });

  it("fails an own claim the adjudicator rejects, with the categories the adjudicator names", () => {
    const line = response({ claims: [...response().claims, { id: "extra:1", text: "the route is broken by the change", citations: [RELATION] }] });
    const report = scoreRun(runDir(), jsonl(line), adjudicated(judged(line, { "extra:1": "unsupported" }, {})
      .map(j => j.claimId === "extra:1" ? { ...j, categories: ["reach-as-breakage"] } : j)));
    assert.deepEqual(codes(report), ["reach-as-breakage", "unsupported-claim"]);
  });

  it("fails a prose answer the adjudicator marks as presenting an unknown as empty", () => {
    const line = response();
    const judgments = judged(line, { answer: "violates" }).map(j => j.claimId === "answer" ? { ...j, categories: ["unknown-as-empty" as Category] } : j);
    assert.deepEqual(codes(scoreRun(runDir(), jsonl(line), adjudicated(judgments))), ["unknown-as-empty"]);
  });

  it("fails a catalogue-looking id that the case does not define", () => {
    const line = response({ claims: [...response().claims, { id: "p9", text: "t", citations: [PART] }] });
    assert.deepEqual(codes(scoreRun(runDir(), jsonl(line), adjudicated(judged(line)))), ["unknown-proposition"]);
  });

  it("fails a duplicated and a malformed response for their expected keys", () => {
    const line = response();
    const malformed = { ...response({ replicate: 2 }), claims: "p1" };
    const report = scoreRun(runDir(), jsonl(line, line, malformed), adjudicated(judged(line)));
    assert.deepEqual(codes(report), ["duplicate-response"]);
    assert.deepEqual(codes(report, "composed", 2), ["invalid-response"]);
  });
});

describe("scoring adjudication", () => {
  it("passes two prose variants that assert the same supported claims", () => {
    const first = response({ answer: "One recorded dependence; one read is partial." });
    const second = response({ replicate: 2, answer: "A partial read limits it, but the dependence itself is recorded.", claims: [{ id: "p1", text: "different words", citations: [RELATION] }] });
    const report = scoreRun(runDir(), jsonl(first, second), adjudicated([...judged(first), ...judged(second)]));
    assert.equal(scoreOf(report).status, "pass");
    assert.equal(scoreOf(report, "composed", 2).status, "pass");
    assert.deepEqual(scoreOf(report).recall.requiredAsserted, ["p1"]);
  });

  it("rejects a supported verdict whose support exists but the response did not cite, leaving the claim unevaluated", () => {
    const line = response();
    const judgments = judged(line).map(j => j.claimId === "p1" ? { ...j, supports: [PART] } : j);
    const score = scoreOf(scoreRun(runDir(), jsonl(line), adjudicated(judgments)));
    assert.equal(score.status, "not_evaluated");
    assert.deepEqual(score.rejectedJudgments.map(r => r.claimId), ["p1"]);
  });

  it("reports a missing required proposition as recall, not as a pass of that proposition", () => {
    const line = response({ claims: [] });
    const score = scoreOf(scoreRun(runDir(), jsonl(line), adjudicated(judged(line))));
    assert.equal(score.status, "pass");
    assert.deepEqual(score.recall.requiredApplicable, ["p1"]);
    assert.deepEqual(score.recall.requiredAsserted, []);
  });
});

describe("scoring absent data", () => {
  it("is not_evaluated with no responses, an empty file, or no judgments, and never pass", () => {
    const dir = runDir();
    for (const report of [scoreRun(dir, undefined, undefined), scoreRun(dir, "", adjudicated([])), scoreRun(dir, jsonl(response()), undefined)]) {
      assert.equal(report.overall, "not_evaluated");
      assert.ok(report.responses.every(r => r.status !== "pass"));
    }
  });

  it("keeps the expected responses that were not delivered as not_evaluated when others pass", () => {
    const line = response();
    const report = scoreRun(runDir(), jsonl(line), adjudicated(judged(line)));
    assert.equal(scoreOf(report).status, "pass");
    assert.equal(scoreOf(report, "baseline", 2).status, "not_evaluated");
    assert.equal(report.overall, "not_evaluated");
  });
});

describe("preparation helpers", () => {
  const query = (name: ComposeQuery["name"], repo: string, extra: Record<string, unknown> = {}) => ({ name, arguments: { repo, revision: "h", ...extra } }) as unknown as ComposeQuery;

  it("orders as listed, reversed and round-robin by repository, dropping orders that repeat", () => {
    const queries = [query("ye_ast_entrypoints", "shop"), query("ye_ast_outline", "shop"), query("ye_ast_importers", "web")];
    assert.deepEqual(orderVariants(queries).map(o => [o.name, o.indices]), [["original", [0, 1, 2]], ["reversed", [2, 1, 0]], ["interleaved", [0, 2, 1]]]);
    assert.deepEqual(orderVariants([queries[0]!]).map(o => o.name), ["original"]);
  });

  it("selects by branch, overrides only the revision with the fixture's commit, and reports a missing family", () => {
    const fixture = { base: "B", head: "H", queries: [query("ye_ast_callers", "shop"), query("ye_ast_callers", "shop", { workspace: {} }), query("ye_ast_outline", "shop")] };
    const selected = selectQueries([{ family: "callers", branch: "workspace" }, { family: "outline", revision: "base" }], fixture);
    assert.ok(selected.ok);
    assert.equal(selected.queries[0], fixture.queries[1]);
    assert.deepEqual(selected.queries[1]!.arguments, { repo: "shop", revision: "B" });
    assert.deepEqual(selectQueries([{ family: "decisions" }], fixture), { ok: false, reason: "fixture has no decisions query" });
  });

  it("removes the fixture root, including a longer path that contains it", () => {
    const out = redactEnvironment('{"a":"/tmp/x/shop","b":"/tmp/x"}', ["/tmp/x"]);
    assert.equal(out, '{"a":"<fixture-root>/shop","b":"<fixture-root>"}');
  });
});

describe("corpus", () => {
  const corpusPath = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "evaluations", "mcp-composition", "cases.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { cases: { id: string; propositions: Record<string, unknown>[] }[] };

  it("parses the shipped corpus, with the plan's six cases, the seven-family case and every category forbidden somewhere", () => {
    const parsed = parseCorpus(corpus);
    for (const id of ["handler-outline", "change-duplicate-dependence", "imports-vs-symbols", "workspace-link-cut", "decision-options", "snapshot-mismatch", "seven-families", "no-overlap"]) {
      assert.ok(parsed.cases.some(c => c.id === id), id);
    }
    assert.deepEqual(new Set(parsed.cases.find(c => c.id === "seven-families")!.queries.map(q => q.family)).size, 7);
    const forbidden = new Set(parsed.cases.flatMap(c => c.propositions.flatMap(p => p.category === undefined ? [] : [p.category])));
    assert.deepEqual([...forbidden].sort(), [...CATEGORIES].sort());
  });

  it("rejects a forbidden proposition without category and an unknown field", () => {
    const withCase = (proposition: Record<string, unknown>) => ({ ...corpus, cases: [{ ...corpus.cases[0]!, propositions: [proposition] }] });
    assert.throws(() => parseCorpus(withCase({ id: "p1", kind: "forbidden", text: "x" })), EvaluationInputError);
    assert.throws(() => parseCorpus(withCase({ id: "p1", kind: "forbidden", category: "import-as-call", text: "x", verdict: "true" })), EvaluationInputError);
    assert.doesNotThrow(() => parseCorpus(withCase({ id: "p1", kind: "forbidden", category: "import-as-call", text: "x" })));
  });
});

describe("assertion identity and supporting context", () => {
  it("accepts additional valid context when a proposition also cites its required evidence kind", () => {
    const line = response({claims:[{id:"p1",text:"dependence with context",citations:[RELATION,PART,READ]}]});
    assert.deepEqual(codes(scoreRun(runDir(),jsonl(line),adjudicated(judged(line)))),[]);
  });
  it("uses structural positions when consumer ids repeat instead of overwriting an assertion", () => {
    const line = response({claims:[{id:"extra:1",text:"recorded",citations:[RELATION]}],uncertainties:[{id:"extra:1",text:"partial",citations:[READ]}]});
    const ambiguous=scoreOf(scoreRun(runDir(),jsonl(line),adjudicated(judged(line))));
    assert.equal(ambiguous.status,"not_evaluated");
    assert.ok(ambiguous.pending.includes("judgment for /claims/0"));
    assert.ok(ambiguous.pending.includes("judgment for /uncertainties/0"));
    const [claim,uncertainty,answer]=judged(line);
    assert.ok(claim&&uncertainty&&answer);
    const checked=scoreOf(scoreRun(runDir(),jsonl(line),adjudicated([{...claim,claimId:"/claims/0"},{...uncertainty,claimId:"/uncertainties/0"},answer])));
    assert.equal(checked.status,"pass");
  });
});
