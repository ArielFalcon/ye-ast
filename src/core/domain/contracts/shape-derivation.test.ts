import assert from "node:assert/strict";
import test from "node:test";
import { ELEMENT, formatAccessPath } from "./access-path.ts";
import { ANYTHING, type KnownShape, type Shape, type ShapeProperty, type ValueSet } from "./payload-shape.ts";
import { deriveChanges, LISTING, REQUEST_READING } from "./shape-derivation.ts";

const set = (overrides: Partial<ValueSet> = {}): ValueSet => ({ literals: { boolean: [], number: [], string: [] }, array: false, object: false, null: false, absent: false, ...overrides });
const known = (values: ValueSet, rest: Partial<KnownShape> = {}): KnownShape => ({ kind: "known", values, ...rest });

const TEXT = known(set({ literals: { boolean: [], number: [], string: "every" } }));
const NUMBER = known(set({ literals: { boolean: [], number: "every", string: [] } }));
const NULLABLE_TEXT = known(set({ literals: { boolean: [], number: [], string: "every" }, null: true }));
const enumeration = (...strings: string[]) => known(set({ literals: { boolean: [], number: [], string: strings } }));
const property = (name: string, shape: Shape, required = true): ShapeProperty => ({ name, required, shape });
const object = (properties: readonly ShapeProperty[], open = false): KnownShape => known(set({ object: true }), { object: { properties, open } });
const array = (elements: Shape): KnownShape => known(set({ array: true }), { elements });

const hypotheses = (base: Shape, head: Shape) => deriveChanges(base, head).hypotheses.map(({ property: path, change }) => [formatAccessPath(path), change.entries] as const);
const differences = (base: Shape, head: Shape) => deriveChanges(base, head).differences.map(({ path, delta, subject }) => [formatAccessPath(path), delta, subject] as const);
const keyed = (shape: KnownShape, keywords: Readonly<Record<string, unknown>>): KnownShape => ({ ...shape, keywords });

test("a required property the head no longer declares in a closed object is removed, and the base value set is the old guarantee", () => {
  const derived = deriveChanges(object([property("typeId", NUMBER), property("name", TEXT)]), object([property("name", TEXT)]));
  assert.deepEqual(hypotheses(object([property("typeId", NUMBER), property("name", TEXT)]), object([property("name", TEXT)])), [["typeId", ["removed"]]]);
  assert.deepEqual(derived.hypotheses[0]!.change.oldGuarantee, set({ literals: { boolean: [], number: "every", string: [] } }));
  assert.deepEqual([derived.differences.map(({ delta }) => delta), derived.frontiers], [["removed"], []]);
});

test("a property that becomes nullable, optional or both is the introduced value, one name each", () => {
  const base = object([property("city", TEXT), property("zip", TEXT)]);
  const head = object([property("city", NULLABLE_TEXT), property("zip", TEXT, false)]);
  assert.deepEqual(hypotheses(base, head), [["city", ["nullable"]], ["zip", ["optional"]]]);
  assert.deepEqual(differences(base, head), [["city", "introduced-null", undefined], ["zip", "introduced-absence", undefined]]);
});

test("an enumeration opened to its class is a type change whose old guarantee names the listed literals", () => {
  const derived = deriveChanges(object([property("kind", enumeration("CAT", "DOG"))]), object([property("kind", TEXT)]));
  assert.deepEqual(derived.hypotheses.map(({ change }) => [change.entries, change.oldGuarantee?.literals.string]), [[[{ type: "string" }], ["CAT", "DOG"]]]);
});

test("literals added to and removed from an enumeration are the values change", () => {
  const derived = deriveChanges(object([property("kind", enumeration("CAT", "DOG"))]), object([property("kind", enumeration("CAT", "BIRD"))]));
  assert.deepEqual(derived.hypotheses.map(({ change }) => change.entries), [[{ values: { added: ["BIRD"], removed: ["DOG"] } }]]);
  assert.deepEqual(derived.differences.map(({ delta }) => delta), ["literals-added", "literals-retired"]);
});

test("a class swapped for another introduces the new class and gains nothing to follow but the retired one, which is listed", () => {
  const derived = deriveChanges(object([property("size", TEXT)]), object([property("size", NUMBER)]));
  assert.deepEqual(derived.hypotheses.map(({ change }) => change.entries), [[{ type: "number" }]]);
  assert.deepEqual(differences(object([property("size", TEXT)]), object([property("size", NUMBER)])), [["size", "introduced-class", "number"], ["size", "retired-class", "string"]]);
});

test("a retired null or retired absence is a difference the head gains: listed with its place, never a hypothesis", () => {
  const derived = deriveChanges(object([property("city", NULLABLE_TEXT), property("zip", TEXT, false)]), object([property("city", TEXT), property("zip", TEXT)]));
  assert.deepEqual(derived.hypotheses, []);
  assert.deepEqual(derived.differences.map(({ path, delta }) => [formatAccessPath(path), delta]), [["city", "retired-null"], ["zip", "retired-absence"]]);
});

test("a property only the head declares is an addition, required or optional, in an open or a closed object, and nothing below it is derived", () => {
  const added = [property("fresh", object([property("deep", TEXT)])), property("maybe", TEXT, false)];
  for (const open of [false, true]) {
    assert.deepEqual(deriveChanges(object([property("a", TEXT)], open), object([property("a", TEXT), ...added], open)), {
      hypotheses: [],
      differences: [{ path: ["fresh"], delta: "added-required" }, { path: ["maybe"], delta: "added-optional" }],
      frontiers: [],
    });
  }
});

test("an upper bound lowered or added narrows the place and one raised or dropped widens it; a lower bound the other way round", () => {
  const base = object([property("a", keyed(TEXT, { maxLength: 10 })), property("b", keyed(TEXT, { maxLength: 10 })), property("c", keyed(TEXT, { maxLength: 10 })), property("d", TEXT), property("e", keyed(NUMBER, { minimum: 1 })), property("f", keyed(NUMBER, { minimum: 1 })), property("g", NUMBER)]);
  const head = object([property("a", keyed(TEXT, { maxLength: 9 })), property("b", keyed(TEXT, { maxLength: 11 })), property("c", TEXT), property("d", keyed(TEXT, { maxItems: 3 })), property("e", keyed(NUMBER, { minimum: 2 })), property("f", keyed(NUMBER, { minimum: 0 })), property("g", keyed(NUMBER, { minimum: 0 }))]);
  assert.deepEqual(differences(base, head), [
    ["a", "constraint-narrowed", "maxLength"],
    ["b", "constraint-widened", "maxLength"],
    ["c", "constraint-widened", "maxLength"],
    ["d", "constraint-narrowed", "maxItems"],
    ["e", "constraint-narrowed", "minimum"],
    ["f", "constraint-widened", "minimum"],
    ["g", "constraint-narrowed", "minimum"],
  ]);
  assert.deepEqual(deriveChanges(base, head).differences[0], { path: ["a"], delta: "constraint-narrowed", subject: "maxLength", base: 10, head: 9 });
});

test("a pattern, format, multiple or uniqueness added narrows the place, dropped widens it, and one replaced, like a bound that is not a number, is a change", () => {
  const base = object([property("a", TEXT), property("b", keyed(TEXT, { format: "int32" })), property("c", keyed(TEXT, { pattern: "^a" })), property("d", keyed(NUMBER, { exclusiveMinimum: true })), property("e", keyed(TEXT, { uniqueItems: false }))]);
  const head = object([property("a", keyed(TEXT, { pattern: "^a" })), property("b", TEXT), property("c", keyed(TEXT, { pattern: "^b" })), property("d", keyed(NUMBER, { exclusiveMinimum: false })), property("e", keyed(TEXT, { uniqueItems: true }))]);
  assert.deepEqual(differences(base, head), [
    ["a", "constraint-narrowed", "pattern"],
    ["b", "constraint-widened", "format"],
    ["c", "constraint-changed", "pattern"],
    ["d", "constraint-changed", "exclusiveMinimum"],
    ["e", "constraint-narrowed", "uniqueItems"],
  ]);
});

test("a default, a deprecation, a read-only mark or an XML name that changed is an annotation change, and equal keywords derive nothing", () => {
  const base = object([property("a", keyed(TEXT, { default: "x", maxLength: 3 })), property("b", TEXT), property("c", keyed(TEXT, { readOnly: true })), property("d", TEXT)]);
  const head = object([property("a", keyed(TEXT, { default: "y", maxLength: 3 })), property("b", keyed(TEXT, { deprecated: true })), property("c", TEXT), property("d", keyed(TEXT, { default: null }))]);
  assert.deepEqual(differences(base, head), [["a", "annotation-changed", "default"], ["b", "annotation-changed", "deprecated"], ["c", "annotation-changed", "readOnly"], ["d", "annotation-changed", "default"]]);
});

test("a keyword the derivation does not classify that changed is an unclassified difference at its place, never silence", () => {
  const derived = deriveChanges(object([property("id", keyed(NUMBER, { writeOnly: true }))]), object([property("id", NUMBER)]));
  assert.deepEqual([derived.differences, derived.frontiers], [[], [{ path: ["id"], kind: "unclassified-difference", detail: "writeOnly" }]]);
});

test("an open object that stops declaring a property holds every value there: each class the base did not allow is introduced, as one undeclared difference", () => {
  const derived = deriveChanges(object([property("name", known(TEXT.values, { keywords: { maxLength: 3 } }))], true), object([], true));
  assert.deepEqual(derived.differences, [{ path: ["name"], delta: "undeclared" }]);
  assert.deepEqual(derived.hypotheses[0]!.differences, derived.differences);
  const nested = deriveChanges(object([property("owner", object([property("name", TEXT)]))], true), object([], true));
  assert.deepEqual(nested.differences.map(({ path, delta }) => [formatAccessPath(path), delta]), [["owner", "undeclared"], ["owner.name", "undeclared"]]);
  assert.deepEqual(derived.hypotheses[0]!.change.entries, ["nullable", "optional", { type: "boolean" }, { type: "number" }, { type: "array" }, { type: "object" }]);
  assert.deepEqual(derived.hypotheses[0]!.change.introduced, ["null", "undefined", "boolean", "number", "array", "object"]);
  assert.deepEqual(derived.hypotheses[0]!.change.oldGuarantee, set({ literals: { boolean: [], number: [], string: "every" } }));
});

test("a closed object that stops declaring an optional property still leaves it removed: the head allows nothing but absence", () => {
  assert.deepEqual(hypotheses(object([property("name", TEXT, false)]), object([])), [["name", ["removed"]]]);
});

test("one schema reached by two paths is reported under both, the second not dropped after the first", () => {
  const address = (city: Shape) => object([property("city", city)]);
  const [baseAddress, headAddress] = [address(TEXT), address(NULLABLE_TEXT)];
  const base = object([property("billing", baseAddress), property("shipping", baseAddress)]);
  const head = object([property("billing", headAddress), property("shipping", headAddress)]);
  assert.deepEqual(hypotheses(base, head), [["billing.city", ["nullable"]], ["shipping.city", ["nullable"]]]);
});

test("a shared pair is compared once however many paths reach it", () => {
  let reads = 0;
  const counted = (shape: KnownShape): KnownShape => ({ ...shape, get object() { reads++; return shape.object!; } });
  const baseAddress = counted(object([property("city", TEXT)]));
  const headAddress = counted(object([property("city", NULLABLE_TEXT)]));
  const paths = ["a", "b", "c"].map((name) => property(name, baseAddress));
  deriveChanges(object(paths), object(paths.map(({ name }) => property(name, headAddress))));
  assert.equal(reads, 2);
});

test("a recursive schema stops where it re-enters its own pair, with a frontier at that place and the deltas above it kept", () => {
  const cycle = (city: Shape): KnownShape => {
    const node = object([property("city", city)]);
    node.object!.properties = [...node.object!.properties, property("next", node, false)];
    return node;
  };
  const derived = deriveChanges(cycle(TEXT), cycle(NULLABLE_TEXT));
  assert.deepEqual(hypotheses(cycle(TEXT), cycle(NULLABLE_TEXT)), [["city", ["nullable"]]]);
  assert.deepEqual(derived.frontiers.map(({ path, kind }) => [formatAccessPath(path), kind]), [["next", "recursive-shape"]]);
});

test("a pair cut by a recursion above it is not reused from another path, where its inside is not cut", () => {
  const build = (leaf: Shape) => {
    const a = object([property("w", leaf)]);
    const b = object([property("v", leaf)]);
    a.object!.properties = [property("b", b), property("w", leaf)];
    b.object!.properties = [property("a", a), property("v", leaf)];
    return object([property("first", a), property("second", b)]);
  };
  const derived = deriveChanges(build(TEXT), build(NULLABLE_TEXT));
  assert.deepEqual(derived.hypotheses.map(({ property: path }) => formatAccessPath(path)), ["first.b.v", "first.w", "second.a.b.v", "second.a.w", "second.v"]);
  assert.deepEqual(derived.frontiers.map(({ path }) => formatAccessPath(path)), ["first.b.a", "second.a.b.a"]);
});

test("a delta at the response root or at an array element is an unsupported delta at that place, and still a listed difference", () => {
  assert.deepEqual(deriveChanges(TEXT, NULLABLE_TEXT), { hypotheses: [], differences: [{ path: [], delta: "introduced-null" }], frontiers: [{ path: [], kind: "unsupported-delta" }] });
  const derived = deriveChanges(object([property("tags", array(TEXT))]), object([property("tags", array(NULLABLE_TEXT))]));
  assert.deepEqual([derived.hypotheses, derived.frontiers.map(({ path, kind }) => [formatAccessPath(path), kind])], [[], [["tags[]", "unsupported-delta"]]]);
});

test("read as a request, the same comparison derives what the server stops accepting, answering the retired differences, while a response derives nothing from them", () => {
  const base = object([property("a", NULLABLE_TEXT, false), property("b", enumeration("A", "B"))]);
  const head = object([property("a", TEXT), property("b", enumeration("A"))]);
  const derived = deriveChanges(base, head, REQUEST_READING);
  assert.deepEqual(derived.hypotheses.map(({ property: path, change, differences: answered }) => [formatAccessPath(path), change.entries, answered.map(({ delta }) => delta)]), [
    ["a", ["required", "non-nullable"], ["retired-absence", "retired-null"]],
    ["b", [{ values: { removed: ["B"] } }], ["literals-retired"]],
  ]);
  assert.deepEqual(derived.hypotheses[0]!.change.oldAcceptance, { ...NULLABLE_TEXT.values, absent: true });
  assert.deepEqual(derived.differences, deriveChanges(base, head).differences);
  assert.deepEqual(deriveChanges(base, head).hypotheses.map(({ property: path }) => formatAccessPath(path)), ["b"]);
});

test("read as a request, a required property only the head declares is required of every writer, and an open base accepted any value there, so a property it newly declares answers its addition", () => {
  const closed = deriveChanges(object([]), object([property("id", TEXT), property("note", TEXT, false)]), REQUEST_READING);
  assert.deepEqual(closed.hypotheses.map(({ property: path, change, differences: answered }) => [formatAccessPath(path), change.entries, answered.map(({ delta }) => delta)]), [["id", ["required"], ["added-required"]]]);
  const open = deriveChanges(object([], true), object([property("id", TEXT), property("note", TEXT, false)], true), REQUEST_READING);
  assert.deepEqual(open.hypotheses.map(({ property: path, change, differences: answered }) => [formatAccessPath(path), change.entries, answered.map(({ delta }) => delta)]), [["id", ["required", "non-nullable", { type: "string" }], ["added-required"]], ["note", ["non-nullable", { type: "string" }], ["added-optional"]]]);
});

test("read as a request, a body that becomes required is a difference at its root and an unsupported delta there; a reading that lists derives no hypothesis", () => {
  const derived = deriveChanges(TEXT, TEXT, REQUEST_READING, { base: true, head: false });
  assert.deepEqual([derived.hypotheses, derived.differences, derived.frontiers], [[], [{ path: [], delta: "retired-absence" }], [{ path: [], kind: "unsupported-delta" }]]);
  const listed = deriveChanges(object([property("page", NULLABLE_TEXT, false)]), object([property("page", TEXT)]), LISTING);
  assert.deepEqual([listed.hypotheses, listed.frontiers, listed.differences.map(({ delta }) => delta)], [[], [], ["retired-absence", "retired-null"]]);
});

test("a property inside array elements is derived under the element segment", () => {
  const element = (city: Shape) => array(object([property("city", city)]));
  const derived = deriveChanges(object([property("items", element(TEXT))]), object([property("items", element(NULLABLE_TEXT))]));
  assert.deepEqual(derived.hypotheses.map(({ property: path }) => path), [["items", ELEMENT, "city"]]);
});

test("a place a side cannot state is a frontier carrying its side, reason and evidence, and nothing below it is derived", () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api.yml", line: 4, via: "oneOf" }] };
  const derived = deriveChanges(object([property("pet", object([property("name", TEXT)]))]), object([property("pet", unknown)]));
  assert.deepEqual(derived, { hypotheses: [], differences: [], frontiers: [{ path: ["pet"], kind: "unknown-shape", side: "head", reason: "unresolved", evidence: unknown.evidence }] });
});

test("an anything-place on both sides derives nothing, and an object whose head loses the class retires it", () => {
  assert.deepEqual(deriveChanges(object([property("x", ANYTHING)]), object([property("x", ANYTHING)])), { hypotheses: [], differences: [], frontiers: [] });
  const derived = deriveChanges(object([property("x", object([]))]), object([property("x", TEXT)]));
  assert.deepEqual(derived.differences.filter(({ delta }) => delta === "retired-class").map(({ subject }) => subject), ["object"]);
});

test("the derivation is deterministic: hypotheses, gains and frontiers come out sorted by path whatever the declaration order", () => {
  const base = object([property("b", TEXT), property("a", TEXT)]);
  const head = object([property("b", NULLABLE_TEXT), property("a", NULLABLE_TEXT)]);
  assert.deepEqual(hypotheses(base, head).map(([path]) => path), ["a", "b"]);
});
