import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type Answer,
  type AnswerComparison,
  ExpectationError,
  compareAnswers,
  differences,
  parseExpectations,
  topStatus,
  violations,
} from "./corpus-gate-diff.ts";

function answer(stdout: unknown, overrides: Partial<Answer> = {}): Answer {
  return { id: "g/q", family: "links", argv: ["workspace", "{repo:a}"], exit: 0, stdout, stderr: "", ...overrides };
}

describe("differences", () => {
  it("compares arrays as multisets: a modified element is one removal and one addition, a kept one is neither", () => {
    const found = differences({ items: [{ n: 1 }, { n: 2 }, { n: 2 }] }, { items: [{ n: 2 }, { n: 3 }, { n: 2 }] });
    assert.deepEqual(found, [
      { kind: "removed", path: "/items", base: { n: 1 } },
      { kind: "added", path: "/items", candidate: { n: 3 } },
    ]);
  });

  it("reports an order change alone as a reordering, so equal elements in another order are still a difference", () => {
    assert.deepEqual(differences({ items: [1, 2] }, { items: [2, 1] }), [{ kind: "reordered", path: "/items" }]);
  });

  it("reports added and removed keys apart from a changed value, by path", () => {
    assert.deepEqual(differences({ a: 1, b: { c: "x" } }, { b: { c: "y" }, d: true }), [
      { kind: "removed", path: "/a", base: 1 },
      { kind: "changed", path: "/b/c", base: "x", candidate: "y" },
      { kind: "added", path: "/d", candidate: true },
    ]);
  });
});

describe("compareAnswers", () => {
  it("counts the arrays whose length changed and reads the shallowest status", () => {
    const comparison = compareAnswers(
      answer({ fact: { status: "complete", value: { links: [1, 2], other: [{ items: [1] }] } } }),
      answer({ fact: { status: "partial", value: { links: [1], other: [{ items: [] }] } } }),
    );
    assert.deepEqual(comparison.counters, [{ path: "/fact/value/links", base: 2, candidate: 1 }]);
    assert.deepEqual([comparison.base.status, comparison.candidate.status], ["complete", "partial"]);
  });

  it("treats a stderr change as a difference of the answer", () => {
    const comparison = compareAnswers(answer({}), answer({}, { stderr: "notice" }));
    assert.equal(comparison.identical, false);
    assert.equal(comparison.changed, 1);
  });
});

describe("violations", () => {
  const added = compareAnswers(answer({ status: "complete", links: [1] }), answer({ status: "complete", links: [1, 2] }));
  const removed = compareAnswers(answer({ status: "complete", links: [1, 2] }), answer({ status: "complete", links: [1] }));
  const degraded = compareAnswers(answer({ status: "complete", links: [] }), answer({ status: "partial", links: [] }));
  const rules = (comparison: AnswerComparison, expect: string[]) => violations([comparison], parseExpectations(expect)).map((violation) => violation.rule);

  it("fails a difference in a family the change did not declare, and passes nothing under none", () => {
    assert.deepEqual(rules(added, ["none"]), ["undeclared-family"]);
    assert.deepEqual(rules(added, ["impact:±"]), ["undeclared-family"]);
  });

  it("admits under + only additions and under - only removals", () => {
    assert.deepEqual(rules(added, ["links:+"]), []);
    assert.deepEqual(rules(removed, ["links:+"]), ["undeclared-direction"]);
    assert.deepEqual(rules(removed, ["links:-"]), []);
    assert.deepEqual(rules(added, ["links:-"]), ["undeclared-direction"]);
  });

  it("fails a complete answer that degrades unless its family declares ±", () => {
    assert.ok(rules(degraded, ["links:-"]).includes("degraded"));
    assert.deepEqual(rules(degraded, ["links:±"]), []);
  });

  it("fails a new non-zero exit even when its family declares ±", () => {
    const failed = compareAnswers(answer({ status: "complete" }), answer("", { exit: 1 }));
    assert.deepEqual(rules(failed, ["links:±"]), ["new-failure"]);
  });
});

describe("parseExpectations", () => {
  it("rejects a malformed value, a family declared twice and none beside a family", () => {
    const code = (values: string[]) => {
      try {
        parseExpectations(values);
      } catch (error) {
        return error instanceof ExpectationError ? error.code : "other";
      }
      return "accepted";
    };
    assert.equal(code(["links"]), "invalid-expectation");
    assert.equal(code(["links:+", "links:-"]), "duplicate-expectation");
    assert.equal(code(["none", "links:+"]), "none-with-families");
  });
});

describe("topStatus", () => {
  it("never reads a status inside an array", () => {
    assert.equal(topStatus({ items: [{ status: "complete" }] }), null);
  });
});
