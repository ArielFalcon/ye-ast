import { canonicalJson } from "../shared/canonical-json.ts";
import type { Evidence, UnknownReason } from "../shared/fact.ts";
import { compareText } from "../shared/code-node.ts";
import { ELEMENT, formatAccessPath, type AccessPath } from "./access-path.ts";
import type { Result } from "../shared/result.ts";
import { derivedChange, type Change, type ChangeRefusal, type ValueClass, type ValueDelta } from "./change.ts";
import { ANYTHING, LITERAL_CLASSES, NOTHING, type KnownShape, type LiteralClass, type Shape, type ShapeProperty, type ValueSet } from "./payload-shape.ts";
import { derivedRequestChange, type RequestChange } from "./request-change.ts";
import type { Literal } from "./use-operation.ts";

/** A value the head no longer permits and the derivation lists without following: a literal class narrowed or gone counts as the class. */
type RetiredValue = "null" | "absence" | "array" | "object" | LiteralClass;

/** What a change did at one place, in the order a derivation lists them for a place. */
export const SHAPE_DELTAS = [
  "removed",
  "undeclared",
  "introduced-absence",
  "introduced-null",
  "introduced-class",
  "literals-added",
  "literals-retired",
  "retired-absence",
  "retired-null",
  "retired-class",
  "added-required",
  "added-optional",
  "constraint-narrowed",
  "constraint-widened",
  "constraint-changed",
  "annotation-changed",
] as const;

export type ShapeDelta = (typeof SHAPE_DELTAS)[number];

/** One thing a change did at one place of a payload, before any side of the exchange says what it means. */
export interface ShapeDifference {
  path: AccessPath;
  delta: ShapeDelta;
  /** The class a class delta names, or the keyword a constraint or annotation delta names. */
  subject?: string;
  /** The keyword's value at each revision, absent where the revision does not carry it. */
  base?: unknown;
  head?: unknown;
}

/** A change to one property of a payload, normalized as a written hypothesis is. */
export interface DerivedHypothesis<C = Change> {
  property: AccessPath;
  change: C;
  /** The differences the change answers, which the derivation also lists. */
  differences: readonly ShapeDifference[];
}

/** A place the derivation stops at, so what lies at or below it is not decided. */
export interface DerivationFrontier {
  path: AccessPath;
  kind: "unsupported-delta" | "recursive-shape" | "unknown-shape" | "unclassified-difference";
  side?: "base" | "head";
  reason?: UnknownReason;
  evidence?: readonly Evidence[];
  detail?: string;
}

/** The hypotheses a change derives, every difference it made (those of the hypotheses included), and where it stopped. */
export interface Derivation<C = Change> {
  hypotheses: readonly DerivedHypothesis<C>[];
  differences: readonly ShapeDifference[];
  frontiers: readonly DerivationFrontier[];
}

/** What each revision lets one place hold, with the delta a response reading names, when the place gains a value. */
interface PlaceValues {
  base: ValueSet;
  head: ValueSet;
  delta: ValueDelta | undefined;
}

/** Which side of an exchange a derivation reads a change from: what change a place derives, and the differences that change answers. */
export interface Reading<C> {
  change(place: PlaceValues): Result<C, ChangeRefusal> | undefined;
  answers: ReadonlySet<ShapeDelta>;
}

/** A response breaks its readers with what it introduces. */
export const RESPONSE_READING: Reading<Change> = Object.freeze({
  change: ({ delta }: PlaceValues) => (delta === undefined ? undefined : derivedChange(delta)),
  answers: new Set<ShapeDelta>(["removed", "undeclared", "introduced-absence", "introduced-null", "introduced-class", "literals-added", "literals-retired"]),
});

/** A request breaks its writers with what the server stops accepting. */
export const REQUEST_READING: Reading<RequestChange> = Object.freeze({
  change: ({ base, head }: PlaceValues) => derivedRequestChange(base, head),
  answers: new Set<ShapeDelta>(["retired-absence", "retired-null", "retired-class", "literals-retired", "added-required", "added-optional"]),
});

/** A reading that lists the differences and derives no change: no reader follows the place. */
export const LISTING: Reading<never> = Object.freeze({ change: () => undefined, answers: new Set<ShapeDelta>() });

type Entry =
  | { kind: "place"; path: AccessPath; values: PlaceValues; undeclared?: true; added?: true }
  | { kind: "difference"; path: AccessPath; difference: Omit<ShapeDifference, "path"> }
  | { kind: "frontier"; path: AccessPath; frontier: Omit<DerivationFrontier, "path"> };

/** What is reported at or below one place, with the shallowest stack depth a recursion cut at it re-entered (`Infinity` when none left the place). */
interface Walk {
  entries: readonly Entry[];
  floor: number;
}

interface Absence {
  base: boolean;
  head: boolean;
}

const OPEN_OBJECT = Object.freeze({ properties: [] as readonly ShapeProperty[], open: true });
const NOT_ABSENT: Absence = { base: false, head: false };

const FLAGS: readonly { value: ValueClass; retired: RetiredValue; allows(values: ValueSet): boolean }[] = [
  { value: "null", retired: "null", allows: (values) => values.null },
  { value: "undefined", retired: "absence", allows: (values) => values.absent },
  { value: "array", retired: "array", allows: (values) => values.array },
  { value: "object", retired: "object", allows: (values) => values.object },
];

/**
 * What a change from the base to the head shape of one payload did to each property path: introduced values are the
 * head's minus the base's, retired values the base's minus the head's, and each change kind is a name for one such pair.
 * The reading decides which change a place derives (a response by default); `absent` says whether each revision lets the
 * root be missing, as a body that is not required.
 * A property only the head declares is an addition, and nothing below it is derived. A keyword the value set does not
 * state is compared as a bound, a narrowing keyword or an annotation; any other keyword that changed is an unclassified
 * frontier. A schema reached by several paths (the same shape object on both sides) is compared once and reported under
 * every path; one that re-enters a pair it is inside stops there with a frontier.
 */
export function deriveChanges(base: Shape, head: Shape): Derivation;
export function deriveChanges<C>(base: Shape, head: Shape, reading: Reading<C>, absent?: Absence): Derivation<C>;
export function deriveChanges<C>(base: Shape, head: Shape, reading: Reading<C> = RESPONSE_READING as Reading<C>, absent: Absence = NOT_ABSENT): Derivation<C> {
  const { entries } = new Comparison().place(base, head, absent);
  const derived: { property: AccessPath; change: C }[] = [];
  const differences: ShapeDifference[] = [];
  const frontiers: DerivationFrontier[] = [];
  for (const entry of entries) {
    if (entry.kind === "difference") differences.push({ path: entry.path, ...entry.difference });
    else if (entry.kind === "frontier") frontiers.push({ path: entry.path, ...entry.frontier });
    else {
      if (entry.added !== true) differences.push(...namedDifferences(entry).map((difference) => ({ path: entry.path, ...difference })));
      const change = reading.change(entry.values);
      if (change === undefined) continue;
      if (entry.path.length === 0 || entry.path.at(-1) === ELEMENT) frontiers.push({ path: entry.path, kind: "unsupported-delta" });
      else if (!change.ok) frontiers.push({ path: entry.path, kind: "unsupported-delta", detail: change.fault.kind });
      else derived.push({ property: entry.path, change: change.value });
    }
  }
  const byPath = (a: AccessPath, b: AccessPath) => compareText(formatAccessPath(a), formatAccessPath(b));
  differences.sort((a, b) => byPath(a.path, b.path) || SHAPE_DELTAS.indexOf(a.delta) - SHAPE_DELTAS.indexOf(b.delta) || compareText(a.subject ?? "", b.subject ?? ""));
  const answered = (property: AccessPath) => differences.filter(({ path, delta }) => byPath(path, property) === 0 && reading.answers.has(delta));
  return {
    hypotheses: derived.map((hypothesis) => ({ ...hypothesis, differences: answered(hypothesis.property) })).sort((a, b) => byPath(a.property, b.property)),
    differences,
    frontiers: frontiers.sort((a, b) => byPath(a.path, b.path) || compareText(a.kind, b.kind) || compareText(a.side ?? "", b.side ?? "") || compareText(a.detail ?? "", b.detail ?? "")),
  };
}

/** The differences a place's delta names: one per introduced class, and one per direction of its literals; one undeclared difference for a property an open object stops declaring. */
function namedDifferences({ values: { delta }, undeclared }: Extract<Entry, { kind: "place" }>): Omit<ShapeDifference, "path">[] {
  if (undeclared === true) return [{ delta: "undeclared" }];
  if (delta === undefined) return [];
  const { introduced, added, retired, alwaysAbsent } = delta;
  if (alwaysAbsent) return [{ delta: "removed" }];
  const named = introduced.map((value): Omit<ShapeDifference, "path"> => (value === "null" ? { delta: "introduced-null" } : value === "undefined" ? { delta: "introduced-absence" } : { delta: "introduced-class", subject: value }));
  if (added.length > 0) named.push({ delta: "literals-added" });
  if (retired.length > 0) named.push({ delta: "literals-retired" });
  return named;
}

class Comparison {
  private readonly done = new Map<Shape, Map<Shape, readonly Entry[]>>();
  private readonly inside = new Map<Shape, Map<Shape, number>>();
  private depth = 0;

  /** One place seen from both revisions; `absent` says whether each revision lets the place be missing, which a shape never states. */
  place(base: Shape, head: Shape, absent: Absence): Walk {
    if (base.kind === "unknown" || head.kind === "unknown") return { entries: unknownPlaces(base, head), floor: Infinity };
    const values = { base: { ...base.values, absent: absent.base }, head: { ...head.values, absent: absent.head } };
    const own = compareValues(values.base, values.head);
    const entries: Entry[] = own.gained.map((retired) => ({ kind: "difference", path: [], difference: retiredDifference(retired) }));
    if (own.delta !== undefined || own.gained.length > 0) entries.push({ kind: "place", path: [], values: { ...values, delta: own.delta } });
    entries.push(...compareKeywords(base.keywords ?? {}, head.keywords ?? {}));
    const below = this.below(base, head);
    return { entries: [...entries, ...below.entries], floor: below.floor };
  }

  private below(base: KnownShape, head: KnownShape): Walk {
    if (base === head) return { entries: [], floor: Infinity };
    const finished = this.done.get(base)?.get(head);
    if (finished !== undefined) return { entries: finished, floor: Infinity };
    const reentered = this.inside.get(base)?.get(head);
    if (reentered !== undefined) return { entries: [{ kind: "frontier", path: [], frontier: { kind: "recursive-shape" } }], floor: reentered };

    const mine = this.depth++;
    if (!this.inside.has(base)) this.inside.set(base, new Map());
    this.inside.get(base)!.set(head, mine);
    const entries: Entry[] = [];
    let floor = Infinity;
    const take = (segment: string, walk: Walk) => {
      entries.push(...walk.entries.map((entry) => ({ ...entry, path: [segment, ...entry.path] })));
      floor = Math.min(floor, walk.floor);
    };
    const { paired, added, baseOpen, headOpen } = propertiesOf(base, head);
    for (const [name, baseProperty, headProperty] of paired) {
      const headShape = headProperty?.shape ?? (headOpen ? ANYTHING : NOTHING);
      const walk = this.place(baseProperty.shape, headShape, { base: !baseProperty.required, head: headProperty === undefined || !headProperty.required });
      take(name, headProperty === undefined && headOpen ? undeclared(walk) : walk);
    }
    for (const { name, required, shape } of added) {
      entries.push({ kind: "difference", path: [name], difference: { delta: required ? "added-required" : "added-optional" } });
      if (shape.kind === "known") entries.push({ kind: "place", path: [name], values: { base: { ...(baseOpen ? ANYTHING : NOTHING).values, absent: true }, head: { ...shape.values, absent: !required }, delta: undefined }, added: true });
    }
    if (base.values.array && head.values.array) take(ELEMENT, this.place(base.elements ?? ANYTHING, head.elements ?? ANYTHING, NOT_ABSENT));
    this.depth--;
    this.inside.get(base)!.delete(head);
    if (floor >= mine) {
      if (!this.done.has(base)) this.done.set(base, new Map());
      this.done.get(base)!.set(head, entries);
      floor = Infinity;
    }
    return { entries, floor };
  }
}

/** A property an open object stops declaring, with everything below it: each delta is an undeclared one, and what keywords and retired values it lost is implied. */
function undeclared({ entries, floor }: Walk): Walk {
  return { entries: entries.flatMap((entry): Entry[] => (entry.kind === "frontier" ? [entry] : entry.kind === "place" ? [{ ...entry, undeclared: true }] : [])), floor };
}

interface Properties {
  /** The properties the base declares, each with the head's property of that name. */
  paired: readonly [string, ShapeProperty, ShapeProperty | undefined][];
  /** The properties only the head declares. */
  added: readonly ShapeProperty[];
  baseOpen: boolean;
  headOpen: boolean;
}

/** The properties of both revisions where both can hold an object; none where either cannot. */
function propertiesOf(base: KnownShape, head: KnownShape): Properties {
  if (!base.values.object || !head.values.object) return { paired: [], added: [], baseOpen: true, headOpen: true };
  const baseObject = base.object ?? OPEN_OBJECT;
  const headObject = head.object ?? OPEN_OBJECT;
  const held = new Map(headObject.properties.map((property) => [property.name, property]));
  const declared = new Set(baseObject.properties.map(({ name }) => name));
  return {
    paired: baseObject.properties.map((property): [string, ShapeProperty, ShapeProperty | undefined] => [property.name, property, held.get(property.name)]),
    added: headObject.properties.filter(({ name }) => !declared.has(name)),
    baseOpen: baseObject.open,
    headOpen: headObject.open,
  };
}

const retiredDifference = (retired: RetiredValue): Omit<ShapeDifference, "path"> =>
  retired === "null" ? { delta: "retired-null" } : retired === "absence" ? { delta: "retired-absence" } : { delta: "retired-class", subject: retired };

const UPPER_BOUNDS: ReadonlySet<string> = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"]);
const LOWER_BOUNDS: ReadonlySet<string> = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"]);
/** Keywords whose presence narrows the place and whose value has no order. */
const NARROWING: ReadonlySet<string> = new Set(["pattern", "format", "multipleOf", "uniqueItems"]);
/** Keywords that describe the place without restricting the values a reader receives (`readOnly` restricts only what a writer sends). */
const ANNOTATIONS: ReadonlySet<string> = new Set(["default", "deprecated", "readOnly", "xml"]);
/** A keyword at its default value says what its absence says. */
const DEFAULTS: Readonly<Record<string, unknown>> = { uniqueItems: false, deprecated: false, readOnly: false };

/** What a change did to the keywords of one place: a bound, a narrowing keyword or an annotation is a difference, any other keyword a frontier. */
function compareKeywords(base: Readonly<Record<string, unknown>>, head: Readonly<Record<string, unknown>>): Entry[] {
  const meaningful = (keyword: string, value: unknown) => (value === DEFAULTS[keyword] ? undefined : value);
  const entries: Entry[] = [];
  for (const keyword of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort(compareText)) {
    const was = meaningful(keyword, base[keyword]);
    const now = meaningful(keyword, head[keyword]);
    if (was === undefined ? now === undefined : now !== undefined && canonicalJson(was) === canonicalJson(now)) continue;
    const delta = keywordDelta(keyword, was, now);
    if (delta === undefined) entries.push({ kind: "frontier", path: [], frontier: { kind: "unclassified-difference", detail: keyword } });
    else entries.push({ kind: "difference", path: [], difference: { delta, subject: keyword, ...(was === undefined ? {} : { base: was }), ...(now === undefined ? {} : { head: now }) } });
  }
  return entries;
}

function keywordDelta(keyword: string, was: unknown, now: unknown): ShapeDelta | undefined {
  if (ANNOTATIONS.has(keyword)) return "annotation-changed";
  const upper = UPPER_BOUNDS.has(keyword);
  if (!upper && !LOWER_BOUNDS.has(keyword) && !NARROWING.has(keyword)) return undefined;
  if (was === undefined) return "constraint-narrowed";
  if (now === undefined) return "constraint-widened";
  if (NARROWING.has(keyword) || typeof was !== "number" || typeof now !== "number") return "constraint-changed";
  return (upper ? now < was : now > was) ? "constraint-narrowed" : "constraint-widened";
}

function unknownPlaces(base: Shape, head: Shape): Entry[] {
  return ([["base", base], ["head", head]] as const).flatMap(([side, shape]): Entry[] => (shape.kind === "unknown" ? [{ kind: "frontier", path: [], frontier: { kind: "unknown-shape", side, reason: shape.reason, evidence: shape.evidence } }] : []));
}

const presentIn = (values: ValueSet): boolean => values.null || values.array || values.object || LITERAL_CLASSES.some((valueClass) => values.literals[valueClass] === "every" || values.literals[valueClass].length > 0);

/** What the head introduces and retires at one place, as the delta a change is built from, and the guarantees it gains and leaves unfollowed. */
function compareValues(base: ValueSet, head: ValueSet): { delta: ValueDelta | undefined; gained: RetiredValue[] } {
  const introduced: ValueClass[] = [];
  const gained: RetiredValue[] = [];
  const added: Literal[] = [];
  const retired: Literal[] = [];
  for (const { value, retired: name, allows } of FLAGS) {
    if (allows(head) && !allows(base)) introduced.push(value);
    else if (allows(base) && !allows(head)) gained.push(name);
  }
  for (const valueClass of LITERAL_CLASSES) {
    const was = base.literals[valueClass];
    const now = head.literals[valueClass];
    if (now === "every") {
      if (was !== "every") introduced.push(valueClass);
    } else if (was === "every") gained.push(valueClass);
    else {
      added.push(...now.filter((literal) => !was.includes(literal)));
      retired.push(...was.filter((literal) => !now.includes(literal)));
    }
  }
  if (head.absent && !presentIn(head) && presentIn(base)) return { delta: { introduced: [], added: [], retired: [], alwaysAbsent: true, oldGuarantee: base }, gained: [] };
  const changes = introduced.length + added.length + retired.length > 0;
  return { delta: changes ? { introduced, added, retired, alwaysAbsent: false, oldGuarantee: base } : undefined, gained };
}
