import type { ReadingPlan, ReadingRange, TraceStep } from "./trace-fact.ts";

/**
 * The spans of every step not `seen`, merged per file where they overlap or touch, files in their first pre-order
 * appearance and ranges by line, with the lines to read counted once.
 */
export function readingPlan(steps: readonly TraceStep[]): ReadingPlan {
  const read = steps.filter((step) => step.seen === undefined);
  const ranges = [...Map.groupBy(read, (step) => step.file)].flatMap(([file, inFile]) => {
    const merged: ReadingRange[] = [];
    for (const step of inFile.toSorted((a, b) => a.line - b.line)) {
      const end = step.endLine ?? step.line;
      const last = merged.at(-1);
      if (last !== undefined && step.line <= last.end + 1) merged[merged.length - 1] = { ...last, end: Math.max(last.end, end), steps: [...last.steps, step.id].sort((a, b) => a - b) };
      else merged.push({ file, start: step.line, end, steps: [step.id] });
    }
    return merged;
  });
  return { ranges, lines: ranges.reduce((total, { start, end }) => total + end - start + 1, 0) };
}
