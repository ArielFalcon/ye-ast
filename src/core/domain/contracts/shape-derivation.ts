import type { Evidence, UnknownReason } from "../shared/fact.ts";
import { compareText } from "../shared/code-node.ts";
import { ELEMENT, formatAccessPath, type AccessPath } from "./access-path.ts";
import { derivedChange, type Change, type ValueClass, type ValueDelta } from "./change.ts";
import { ANYTHING, LITERAL_CLASSES, type KnownShape, type LiteralClass, type Shape, type ShapeProperty, type ValueSet } from "./payload-shape.ts";
import type { Literal } from "./use-operation.ts";

/** A value the head no longer permits and the derivation lists without following: a literal class narrowed or gone counts as the class. */
export type RetiredValue = "null" | "absence" | "array" | "object" | LiteralClass;

export interface GainedGuarantee {
  path: AccessPath;
  retired: RetiredValue;
}

/** A change to one property of the response, normalized as a written hypothesis is. */
export interface DerivedHypothesis {
  property: AccessPath;
  change: Change;
}

/** A place the derivation stops at, so what lies at or below it is not decided. */
export interface DerivationFrontier {
  path: AccessPath;
  kind: "unsupported-delta" | "recursive-shape" | "unknown-shape";
  side?: "base" | "head";
  reason?: UnknownReason;
  evidence?: readonly Evidence[];
  detail?: string;
}

export interface Derivation {
  hypotheses: readonly DerivedHypothesis[];
  gained: readonly GainedGuarantee[];
  frontiers: readonly DerivationFrontier[];
}

type Entry =
  | { kind: "delta"; path: AccessPath; delta: ValueDelta }
  | { kind: "gained"; path: AccessPath; retired: RetiredValue }
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

const NOTHING: KnownShape = Object.freeze({ kind: "known", values: Object.freeze({ literals: Object.freeze({ boolean: [], number: [], string: [] }), array: false, object: false, null: false, absent: false }) });
const OPEN_OBJECT = Object.freeze({ properties: [] as readonly ShapeProperty[], open: true });
const NOT_ABSENT: Absence = { base: false, head: false };

const FLAGS: readonly { value: ValueClass; retired: RetiredValue; allows(values: ValueSet): boolean }[] = [
  { value: "null", retired: "null", allows: (values) => values.null },
  { value: "undefined", retired: "absence", allows: (values) => values.absent },
  { value: "array", retired: "array", allows: (values) => values.array },
  { value: "object", retired: "object", allows: (values) => values.object },
];

/**
 * What a change from the base to the head shape of one response did to each property path: introduced values are the
 * head's minus the base's, retired values the base's minus the head's, and each change kind is a name for one such pair.
 * A property the base does not declare is an addition and derives nothing. A schema reached by several paths (the same
 * shape object on both sides) is compared once and reported under every path; one that re-enters a pair it is inside
 * stops there with a frontier.
 */
export function deriveChanges(base: Shape, head: Shape): Derivation {
  const { entries } = new Comparison().place(base, head, NOT_ABSENT);
  const hypotheses: DerivedHypothesis[] = [];
  const gained: GainedGuarantee[] = [];
  const frontiers: DerivationFrontier[] = [];
  for (const entry of entries) {
    if (entry.kind === "gained") gained.push({ path: entry.path, retired: entry.retired });
    else if (entry.kind === "frontier") frontiers.push({ path: entry.path, ...entry.frontier });
    else if (entry.path.length === 0 || entry.path.at(-1) === ELEMENT) frontiers.push({ path: entry.path, kind: "unsupported-delta" });
    else {
      const change = derivedChange(entry.delta);
      if (change.ok) hypotheses.push({ property: entry.path, change: change.value });
      else frontiers.push({ path: entry.path, kind: "unsupported-delta", detail: change.fault.kind });
    }
  }
  const byPath = (a: AccessPath, b: AccessPath) => compareText(formatAccessPath(a), formatAccessPath(b));
  return {
    hypotheses: hypotheses.sort((a, b) => byPath(a.property, b.property)),
    gained: gained.sort((a, b) => byPath(a.path, b.path) || compareText(a.retired, b.retired)),
    frontiers: frontiers.sort((a, b) => byPath(a.path, b.path) || compareText(a.kind, b.kind) || compareText(a.side ?? "", b.side ?? "")),
  };
}

class Comparison {
  private readonly done = new Map<Shape, Map<Shape, readonly Entry[]>>();
  private readonly inside = new Map<Shape, Map<Shape, number>>();
  private depth = 0;

  /** One place seen from both revisions; `absent` says whether each revision lets the place be missing, which a shape never states. */
  place(base: Shape, head: Shape, absent: Absence): Walk {
    if (base.kind === "unknown" || head.kind === "unknown") return { entries: unknownPlaces(base, head), floor: Infinity };
    const own = compareValues({ ...base.values, absent: absent.base }, { ...head.values, absent: absent.head });
    const entries: Entry[] = own.gained.map((retired) => ({ kind: "gained", path: [], retired }));
    if (own.delta !== undefined) entries.push({ kind: "delta", path: [], delta: own.delta });
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
    for (const [name, baseProperty, headProperty] of propertiesOf(base, head)) {
      const headShape = headProperty?.shape ?? ((head.object ?? OPEN_OBJECT).open ? ANYTHING : NOTHING);
      take(name, this.place(baseProperty.shape, headShape, { base: !baseProperty.required, head: headProperty === undefined || !headProperty.required }));
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

/** The properties the base declares where both revisions can hold an object, each with the head's property of that name. */
function propertiesOf(base: KnownShape, head: KnownShape): readonly [string, ShapeProperty, ShapeProperty | undefined][] {
  if (!base.values.object || !head.values.object) return [];
  const held = new Map((head.object ?? OPEN_OBJECT).properties.map((property) => [property.name, property]));
  return (base.object ?? OPEN_OBJECT).properties.map((property): [string, ShapeProperty, ShapeProperty | undefined] => [property.name, property, held.get(property.name)]);
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
