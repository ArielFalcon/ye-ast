import assert from "node:assert/strict";
import test from "node:test";
import type { TraceStep } from "./trace-fact.ts";
import { readingPlan } from "./reading-plan.ts";

function step(id: number, file: string, line: number, endLine?: number, seen?: number): TraceStep {
  return { id, depth: 0, file, symbol: `s${id}`, kind: "function", line, ...(endLine === undefined ? {} : { endLine }), ...(seen === undefined ? {} : { seen }) };
}

test("ranges of one file that overlap or touch merge and keep their step ids, and the line count counts each line once", () => {
  const plan = readingPlan([step(0, "src/a.ts", 10, 30), step(1, "src/a.ts", 12, 14), step(2, "src/a.ts", 31, 35), step(3, "src/a.ts", 40, 41)]);
  assert.deepEqual(plan, {
    ranges: [
      { file: "src/a.ts", start: 10, end: 35, steps: [0, 1, 2] },
      { file: "src/a.ts", start: 40, end: 41, steps: [3] },
    ],
    lines: 28,
  });
});

test("files follow their first appearance in the steps and ranges within a file follow their lines", () => {
  const plan = readingPlan([step(0, "src/b.ts", 50, 60), step(1, "src/a.ts", 5), step(2, "src/b.ts", 10, 12)]);
  assert.deepEqual(plan.ranges.map(({ file, start, end, steps }) => [file, start, end, steps]), [
    ["src/b.ts", 10, 12, [2]],
    ["src/b.ts", 50, 60, [0]],
    ["src/a.ts", 5, 5, [1]],
  ]);
});

test("a seen step adds nothing to read", () => {
  const plan = readingPlan([step(0, "src/a.ts", 10, 12), step(1, "src/b.ts", 3, 9, 0)]);
  assert.deepEqual(plan, { ranges: [{ file: "src/a.ts", start: 10, end: 12, steps: [0] }], lines: 3 });
});
