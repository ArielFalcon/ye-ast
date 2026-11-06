import assert from "node:assert/strict";
import test from "node:test";
import { calleeOf, compareOccurrence, ownMemberOf, receiverOf, sameOccurrence, type OrderedPlace } from "./call-place.ts";

test("a bare name is a bare callee, a dotted or chained spelling a member callee named by its last name", () => {
  assert.deepEqual(calleeOf("helper"), { form: "bare", name: "helper" });
  assert.deepEqual(calleeOf("this.svc.get"), { form: "member", name: "get" });
  assert.deepEqual(calleeOf("head().tail"), { form: "member", name: "tail" });
});

test("a callee the spelling does not name is computed", () => {
  assert.deepEqual(calleeOf("(this as any)[key]"), { form: "computed" });
  assert.deepEqual(calleeOf("handlers.list[0]"), { form: "computed" });
  assert.deepEqual(calleeOf("(make())"), { form: "computed" });
});

test("this.<member> and this.<member>.<rest> name the member; any other receiver names none", () => {
  assert.equal(ownMemberOf("this.save"), "save");
  assert.equal(ownMemberOf("this.save.call"), "save");
  assert.equal(ownMemberOf("other.save"), undefined);
  assert.equal(ownMemberOf("this"), undefined);
  assert.equal(ownMemberOf("this[key]"), undefined);
});

const EDGE = { source: "run", line: 8, column: 4, targetName: "head" };
const REFERENCE = { from: "run", line: 8, column: 4, name: "head" };

test("a member call's receiver is the last name before the member; a call, an index, this or no receiver names none", () => {
  assert.deepEqual(["fn.call", "this.supply.get", "a.b.c.run", "head().get", "x[k].run", "this.run", "run"].map(receiverOf), ["fn", "supply", "c", undefined, undefined, undefined, undefined]);
});

test("a reference is the edge's occurrence only at the same source, line and column with the edge's target as its last name", () => {
  assert.equal(sameOccurrence(EDGE, REFERENCE), true);
  assert.equal(sameOccurrence(EDGE, { ...REFERENCE, from: "other" }), false);
  assert.equal(sameOccurrence(EDGE, { ...REFERENCE, line: 9 }), false);
  assert.equal(sameOccurrence(EDGE, { ...REFERENCE, column: 5 }), false);
});

test("a chain link at the edge's place keeps its own name, so it is a distinct occurrence", () => {
  assert.equal(sameOccurrence(EDGE, { ...REFERENCE, name: "head().tail" }), false);
});

test("places order by line, column, spelling and target, with an unplaced one last", () => {
  const place = (line: number | null, column: number | null, spelling: string, target: string): OrderedPlace => ({ line, column, spelling, target });
  const places = [
    place(null, null, "a", "t1"),
    place(9, 0, "a", "t1"),
    place(8, null, "a", "t1"),
    place(8, 4, "b", "t1"),
    place(8, 4, "a", "t2"),
    place(8, 4, "a", "t1"),
    place(8, 0, "z", "t9"),
  ];
  assert.deepEqual(places.toSorted(compareOccurrence), [
    place(8, 0, "z", "t9"),
    place(8, 4, "a", "t1"),
    place(8, 4, "a", "t2"),
    place(8, 4, "b", "t1"),
    place(8, null, "a", "t1"),
    place(9, 0, "a", "t1"),
    place(null, null, "a", "t1"),
  ]);
});
