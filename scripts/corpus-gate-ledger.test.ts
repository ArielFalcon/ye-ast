import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Answer } from "./corpus-gate-diff.ts";
import { CutLedgerError, cutLedger, cutViolations, languageOf, ledgerDifference, parseCutExpectations } from "./corpus-gate-ledger.ts";

interface CutSpec {
  kind?: string;
  at?: string[];
  reason?: string;
  subReason?: string;
}

function cut({ kind = "unresolved-link", at = ["src/app/orders.ts"], reason = "receiver-unproven", subReason }: CutSpec = {}) {
  return { kind, at, reason, ...(subReason === undefined ? {} : { subReason }), reach: { kind: "anything" } };
}

function answer(id: string, family: string, stdout: unknown): Answer {
  return { id, family, argv: [], exit: 0, stdout, stderr: "" };
}

function partial(cuts: unknown[], value: object = {}) {
  return { status: "partial", value, cuts };
}

const traceValue = (expanded: number) => ({ steps: [], cost: { expanded } });

describe("cutLedger", () => {
  it("keys a row by family, language, kind, reason and sub-reason, and counts the answers holding it by status", () => {
    const ledger = cutLedger([
      answer("g/a", "impact", partial([cut(), cut({ at: ["src/app/orders.ts:12 call"] })])),
      answer("g/b", "impact", partial([cut({ at: ["src/main/Order.java:Order.save"] }), cut({ subReason: "unproven" })])),
      answer("g/c", "callers", partial([cut({ kind: "depth", reason: "depth", at: ["docs/readme.md"] })])),
      answer("g/d", "impact", { status: "complete", value: {} }),
    ]);
    assert.deepEqual(
      ledger.rows.map(({ family, language, kind, reason, subReason, cuts, answersWith }) => [family, language, kind, reason, subReason, cuts, answersWith.partial]),
      [
        ["callers", "none", "depth", "depth", undefined, 1, 1],
        ["impact", "java", "unresolved-link", "receiver-unproven", undefined, 1, 1],
        ["impact", "typescript", "unresolved-link", "receiver-unproven", undefined, 2, 1],
        ["impact", "typescript", "unresolved-link", "receiver-unproven", "unproven", 1, 1],
      ],
    );
    assert.deepEqual(ledger.families, [
      { family: "callers", answers: { complete: 0, partial: 1, unknown: 0 } },
      { family: "impact", answers: { complete: 1, partial: 2, unknown: 0 } },
    ]);
  });

  it("reads the language from the file of a place, never from a look-alike that no profile reads", () => {
    assert.deepEqual(
      ["src/a.ts", "src/a.ts:12", "src/a.ts:Order.save", "src/A.java:7", "module:app:src/a.ts", "src/a.test.ts", "src/a.tsx.md", undefined].map(languageOf),
      ["typescript", "typescript", "typescript", "java", "typescript", "none", "none", "none"],
    );
  });

  it("counts the cuts of the sections a composite holds, beside the section cuts of the composite", () => {
    const composite = partial([cut({ kind: "section", reason: "section-partial", at: ["links"] })], { links: partial([cut({ reason: "join-unsettled" })]) });
    assert.deepEqual(cutLedger([answer("g/w", "workspace", composite)]).rows.map((row) => row.reason), ["section-partial", "join-unsettled"]);
  });

  it("gives a rate per 100 expanded steps only to a family whose facts count steps", () => {
    const ledger = cutLedger([
      answer("g/t1", "trace", partial([cut(), cut()], traceValue(40))),
      answer("g/t2", "trace", partial([cut()], traceValue(10))),
      answer("g/t3", "trace", partial([cut({ reason: "dispatch" })], traceValue(0))),
      answer("g/i", "impact", partial([cut()])),
    ]);
    const row = (family: string, reason: string) => ledger.rows.find((candidate) => candidate.family === family && candidate.reason === reason);
    assert.deepEqual([row("trace", "receiver-unproven")?.steps, row("trace", "receiver-unproven")?.per100Steps], [50, 6]);
    assert.equal(row("trace", "dispatch")?.per100Steps, null);
    assert.equal("per100Steps" in (row("impact", "receiver-unproven") ?? {}), false);
  });

  it("fails on a reason or a sub-reason outside the closed sets of the facts contract", () => {
    const code = (spec: CutSpec) => {
      try {
        cutLedger([answer("g/a", "impact", partial([cut(spec)]))]);
      } catch (error) {
        return error instanceof CutLedgerError ? error.code : "other";
      }
      return "accepted";
    };
    assert.equal(code({ reason: "other" }), "unknown-cut-reason");
    assert.equal(code({ subReason: "other" }), "unknown-cut-sub-reason");
    assert.equal(code({ subReason: "several-bodies" }), "accepted");
  });
});

describe("ledgerDifference", () => {
  it("lists only the rows that differ, a row one side lacks as null, and the total cuts of each side", () => {
    const base = cutLedger([answer("g/a", "impact", partial([cut(), cut({ reason: "dispatch" }), cut({ reason: "hub", kind: "hub" })]))]);
    const candidate = cutLedger([answer("g/a", "impact", partial([cut(), cut({ reason: "dispatch" }), cut({ reason: "dispatch" }), cut({ reason: "depth", kind: "depth" })]))]);
    const difference = ledgerDifference(base, candidate);
    assert.deepEqual(difference.rows.map((row) => [row.reason, row.base?.cuts ?? null, row.candidate?.cuts ?? null]), [
      ["depth", null, 1],
      ["hub", 1, null],
      ["dispatch", 1, 2],
    ]);
    assert.deepEqual(difference.totals, { base: 3, candidate: 4 });
  });
});

describe("cutViolations", () => {
  const base = cutLedger([answer("g/a", "impact", partial([cut(), cut(), cut({ reason: "dispatch" })]))]);
  const candidate = cutLedger([answer("g/a", "impact", partial([cut(), cut({ reason: "dispatch" }), cut({ reason: "hub", kind: "hub" })]))]);
  const rules = (values: string[]) => cutViolations(base, candidate, parseCutExpectations(values)).map((violation) => `${violation.reason}:${violation.direction}`);

  it("passes a declared reason that moved as declared and fails one that did not", () => {
    assert.deepEqual(rules(["receiver-unproven:-", "hub:+"]), []);
    assert.deepEqual(rules(["receiver-unproven:+", "dispatch:-", "depth:±"]), ["depth:±", "dispatch:-", "receiver-unproven:+"]);
    assert.deepEqual(rules(["receiver-unproven:±"]), []);
  });

  it("never fails a reason nobody declared, however much it moved", () => {
    assert.deepEqual(cutViolations(base, candidate, []), []);
  });

  it("refuses an expectation for a reason the facts contract does not know", () => {
    assert.throws(() => parseCutExpectations(["unknown-reason:-"]), { code: "invalid-expectation" });
    assert.throws(() => parseCutExpectations(["hub:+", "hub:-"]), { code: "duplicate-expectation" });
  });
});
