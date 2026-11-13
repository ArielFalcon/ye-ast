import assert from "node:assert/strict";
import test from "node:test";
import { calleeOf, compareOccurrence, countedAlike, nameTail, normalizedSpelling, ownMemberOf, receiverOf, receiverRootOf, sameOccurrence, withoutTypeArguments, type OrderedPlace } from "./call-place.ts";

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

test("the tail of a name is what follows its last separator", () => {
  assert.deepEqual(["x.save", "this.svc.load", "Class.forName", "a::b", "Plain"].map(nameTail), ["save", "load", "forName", "b", "Plain"]);
});

test("a `#` that starts a name's last segment is part of the name, and one inside it separates a module from its name", () => {
  assert.deepEqual(["x.#save", "this.#save", "#save", "x?.#save", "a::#save"].map(nameTail), ["#save", "#save", "#save", "#save", "#save"]);
  assert.deepEqual(["module#name", "a#b.#c", "module#name.save"].map(nameTail), ["name", "#c", "save"]);
});

test("a private name is the callee a spelling names, not a computed one", () => {
  assert.deepEqual(calleeOf("this.#save"), { form: "member", name: "#save" });
  assert.deepEqual(calleeOf("#save"), { form: "bare", name: "#save" });
  assert.equal(ownMemberOf("this.#save"), "#save");
});

test("a chain spelled with its arguments, line breaks and comments normalizes to the spelling without them", () => {
  const written = 'sb.append("a(", x.get())\n    // .append(old)\n    .append(\')\') /* note */ .append';
  assert.equal(normalizedSpelling(written), "sb.append().append().append");
  assert.equal(normalizedSpelling("sb.append().append().append"), "sb.append().append().append");
});

test("a member's type arguments are dropped and a constructor's are kept", () => {
  assert.equal(normalizedSpelling("ImmutableMap.<String, List<String>>builder().put"), "ImmutableMap.builder().put");
  assert.equal(normalizedSpelling("new HashMap<String, Object>().put"), "newHashMap<String,Object>().put");
});

test("a member call's receiver root is the name its chain starts from; a bare call has none", () => {
  assert.deepEqual(["SCHEMA.safeParse", "this.items.map", "ITEMS.flatMap(f).slice", "run", "make().run", "this.run"].map(receiverRootOf), ["SCHEMA", "items", "ITEMS", undefined, undefined, undefined]);
});

test("a column is counted alike up to its line's first character outside ASCII and not past it", () => {
  assert.equal(countedAlike(4, "a.b(); 'é'.c()"), true);
  assert.equal(countedAlike(8, "a.b(); 'é'.c()"), true);
  assert.equal(countedAlike(9, "a.b(); 'é'.c()"), false);
  assert.equal(countedAlike(40, "plain ascii"), true);
});

test("a written type name drops every type argument list, nested ones and those of a qualifier included", () => {
  assert.equal(withoutTypeArguments("Repo<Map<String, List<Long>>>"), "Repo");
  assert.equal(withoutTypeArguments("Outer<Map<K, V>, W>.Inner<B>"), "Outer.Inner");
});
