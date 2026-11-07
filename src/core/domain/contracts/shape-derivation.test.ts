import assert from "node:assert/strict";
import test from "node:test";
import { ELEMENT, formatAccessPath } from "./access-path.ts";
import { ANYTHING, type KnownShape, type Shape, type ShapeProperty, type ValueSet } from "./payload-shape.ts";
import { deriveChanges } from "./shape-derivation.ts";

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

test("a required property the head no longer declares in a closed object is removed, and the base value set is the old guarantee", () => {
  const derived = deriveChanges(object([property("typeId", NUMBER), property("name", TEXT)]), object([property("name", TEXT)]));
  assert.deepEqual(hypotheses(object([property("typeId", NUMBER), property("name", TEXT)]), object([property("name", TEXT)])), [["typeId", ["removed"]]]);
  assert.deepEqual(derived.hypotheses[0]!.change.oldGuarantee, set({ literals: { boolean: [], number: "every", string: [] } }));
  assert.deepEqual([derived.gained, derived.frontiers], [[], []]);
});

test("a property that becomes nullable, optional or both is the introduced value, one name each", () => {
  const base = object([property("city", TEXT), property("zip", TEXT)]);
  const head = object([property("city", NULLABLE_TEXT), property("zip", TEXT, false)]);
  assert.deepEqual(hypotheses(base, head), [["city", ["nullable"]], ["zip", ["optional"]]]);
});

test("an enumeration opened to its class is a type change whose old guarantee names the listed literals", () => {
  const derived = deriveChanges(object([property("kind", enumeration("CAT", "DOG"))]), object([property("kind", TEXT)]));
  assert.deepEqual(derived.hypotheses.map(({ change }) => [change.entries, change.oldGuarantee?.literals.string]), [[[{ type: "string" }], ["CAT", "DOG"]]]);
});

test("literals added to and removed from an enumeration are the values change", () => {
  const derived = deriveChanges(object([property("kind", enumeration("CAT", "DOG"))]), object([property("kind", enumeration("CAT", "BIRD"))]));
  assert.deepEqual(derived.hypotheses.map(({ change }) => change.entries), [[{ values: { added: ["BIRD"], removed: ["DOG"] } }]]);
});

test("a class swapped for another introduces the new class and gains nothing to follow but the retired one, which is listed", () => {
  const derived = deriveChanges(object([property("size", TEXT)]), object([property("size", NUMBER)]));
  assert.deepEqual(derived.hypotheses.map(({ change }) => change.entries), [[{ type: "number" }]]);
  assert.deepEqual(derived.gained.map(({ path, retired }) => [formatAccessPath(path), retired]), [["size", "string"]]);
});

test("a retired null or retired absence is a gained guarantee: listed with its place, never a hypothesis", () => {
  const derived = deriveChanges(object([property("city", NULLABLE_TEXT), property("zip", TEXT, false)]), object([property("city", TEXT), property("zip", TEXT)]));
  assert.deepEqual(derived.hypotheses, []);
  assert.deepEqual(derived.gained.map(({ path, retired }) => [formatAccessPath(path), retired]), [["city", "null"], ["zip", "absence"]]);
});

test("a property the base does not declare is an addition and derives nothing, in an open or a closed object", () => {
  const added = [property("fresh", TEXT)];
  for (const open of [false, true]) assert.deepEqual(deriveChanges(object([property("a", TEXT)], open), object([property("a", TEXT), ...added], open)), { hypotheses: [], gained: [], frontiers: [] });
});

test("an open object that stops declaring a property holds every value there: each class the base did not allow is introduced", () => {
  const derived = deriveChanges(object([property("name", TEXT)], true), object([], true));
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

test("a delta at the response root or at an array element is an unsupported delta at that place", () => {
  assert.deepEqual(deriveChanges(TEXT, NULLABLE_TEXT), { hypotheses: [], gained: [], frontiers: [{ path: [], kind: "unsupported-delta" }] });
  const derived = deriveChanges(object([property("tags", array(TEXT))]), object([property("tags", array(NULLABLE_TEXT))]));
  assert.deepEqual([derived.hypotheses, derived.frontiers.map(({ path, kind }) => [formatAccessPath(path), kind])], [[], [["tags[]", "unsupported-delta"]]]);
});

test("a property inside array elements is derived under the element segment", () => {
  const element = (city: Shape) => array(object([property("city", city)]));
  const derived = deriveChanges(object([property("items", element(TEXT))]), object([property("items", element(NULLABLE_TEXT))]));
  assert.deepEqual(derived.hypotheses.map(({ property: path }) => path), [["items", ELEMENT, "city"]]);
});

test("a place a side cannot state is a frontier carrying its side, reason and evidence, and nothing below it is derived", () => {
  const unknown: Shape = { kind: "unknown", reason: "unresolved", evidence: [{ path: "api.yml", line: 4, via: "oneOf" }] };
  const derived = deriveChanges(object([property("pet", object([property("name", TEXT)]))]), object([property("pet", unknown)]));
  assert.deepEqual(derived, { hypotheses: [], gained: [], frontiers: [{ path: ["pet"], kind: "unknown-shape", side: "head", reason: "unresolved", evidence: unknown.evidence }] });
});

test("an anything-place on both sides derives nothing, and an object whose head loses the class is a gained guarantee", () => {
  assert.deepEqual(deriveChanges(object([property("x", ANYTHING)]), object([property("x", ANYTHING)])), { hypotheses: [], gained: [], frontiers: [] });
  const derived = deriveChanges(object([property("x", object([]))]), object([property("x", TEXT)]));
  assert.deepEqual(derived.gained.map(({ retired }) => retired), ["object"]);
});

test("the derivation is deterministic: hypotheses, gains and frontiers come out sorted by path whatever the declaration order", () => {
  const base = object([property("b", TEXT), property("a", TEXT)]);
  const head = object([property("b", NULLABLE_TEXT), property("a", NULLABLE_TEXT)]);
  assert.deepEqual(hypotheses(base, head).map(([path]) => path), ["a", "b"]);
});
