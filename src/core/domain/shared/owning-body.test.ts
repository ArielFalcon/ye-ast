import assert from "node:assert/strict";
import test from "node:test";
import { owningBody, type SourceSpan } from "./owning-body.ts";

const span = (name: string, startLine: number, startColumn: number, endLine: number, endColumn: number): SourceSpan & { name: string } => ({ name, start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } });

test("a place belongs to the innermost declaration around it, by line and column, never to one beside it", () => {
  const bodies = [span("Api", 3, 0, 9, 1), span("a", 5, 1, 5, 29), span("b", 5, 30, 5, 58), span("inner", 5, 40, 5, 50)];
  assert.deepEqual([[5, 7], [5, 32], [5, 45], [5, 29], [5, 58], [7, 0], [2, 0]].map(([line, column]) => owningBody(bodies, { line: line!, column: column! })?.name), ["a", "b", "inner", "Api", "Api", "Api", undefined]);
});

test("of two declarations that start together, the one that ends first owns the place", () => {
  assert.equal(owningBody([span("outer", 4, 2, 9, 0), span("inner", 4, 2, 6, 0)], { line: 5, column: 0 })?.name, "inner");
});
