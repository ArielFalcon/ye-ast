import { canonicalJson } from "../shared/canonical-json.ts";
import type { Result } from "../shared/result.ts";
import { ELEMENT, parseAccessPath, type AccessPath } from "./access-path.ts";
import type { Literal } from "./use-operation.ts";

/** The classes of JSON value a change can introduce, in the order a normalized change lists them. */
export const VALUE_CLASSES = ["null", "undefined", "boolean", "number", "string", "array", "object"] as const;

export type ValueClass = (typeof VALUE_CLASSES)[number];

const NAMED_KINDS = ["nullable", "optional", "removed"] as const;

/** The kinds of change, in the order a normalized change lists them. */
const CHANGE_KINDS = [...NAMED_KINDS, "renamed", "type", "values", "wrapped", "meaning"] as const;

type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The kinds a `type` change can state: every class but the absences. */
const TYPE_KINDS: readonly ValueClass[] = ["boolean", "number", "string", "array", "object"];

/** The literals a `values` change lets in and the ones it no longer produces, each list sorted and without repeats. */
export interface ValueLiterals {
  added: readonly Literal[];
  removed: readonly Literal[];
}

/** One constraint on the changed property. */
export type ChangeEntry = (typeof NAMED_KINDS)[number] | { renamed: string } | { type: ValueClass } | { values: ValueLiterals } | { wrapped: string } | { meaning: string };

/** One entry as a caller writes it, before it is checked. */
export type ChangeEntryInput = string | Readonly<Record<string, unknown>>;

/** A change as a caller writes it: one entry, or a non-empty list of entries on the same property. */
export type ChangeInput = ChangeEntryInput | readonly ChangeEntryInput[];

/** A kind under which the property is never there: every present value is retired. */
const ALWAYS_ABSENT: ReadonlySet<ChangeKind> = new Set(["removed", "renamed"]);

/** A change normalized once per hypothesis: what it introduces and retires is decided here, never per use. */
export interface Change {
  /** Each entry once, in a fixed order. */
  entries: readonly ChangeEntry[];
  /** The classes of value the new contract permits that the old one did not, in the order of `VALUE_CLASSES`. */
  introduced: readonly ValueClass[];
  alwaysAbsent: boolean;
  /** Where a renamed property sits under the new contract. */
  renamedTo?: AccessPath;
  /** Where the elements of a wrapped array sit under the new contract. */
  elementsAt?: AccessPath;
  /** The literals a `values` entry adds (each walked as itself) and retires; present exactly when the change has that entry. */
  values?: ValueLiterals;
  /** What a `meaning` entry says changed; every use the value reaches is to be reviewed. */
  meaning?: string;
}

export interface ChangeRefusal {
  kind: "unsupported-change" | "contradictory-change";
  detail: string;
}

export function parseChange(input: ChangeInput, property: AccessPath): Result<Change, ChangeRefusal> {
  const written = isList(input) ? input : [input];
  if (written.length === 0) return refuse("unsupported-change", input);
  const entries: ChangeEntry[] = [];
  for (const item of written) {
    const entry = entryOf(item);
    if (entry === undefined) return refuse("unsupported-change", item);
    if (!entries.some((held) => canonicalJson(held) === canonicalJson(entry))) entries.push(entry);
  }
  entries.sort((a, b) => CHANGE_KINDS.indexOf(kindOf(a)) - CHANGE_KINDS.indexOf(kindOf(b)));
  const alwaysAbsent = entries.some((entry) => ALWAYS_ABSENT.has(kindOf(entry)));
  if (alwaysAbsent && entries.length > 1) return refuse("contradictory-change", input);
  if (contradicts(entries)) return refuse("contradictory-change", input);
  const introduced = VALUE_CLASSES.filter((value) => entries.some((entry) => introducedBy(entry) === value));
  const renamed = entries.find((entry) => typeof entry === "object" && "renamed" in entry);
  const wrapped = entries.find((entry) => typeof entry === "object" && "wrapped" in entry);
  const values = entries.find((entry) => typeof entry === "object" && "values" in entry);
  const meaning = entries.find((entry) => typeof entry === "object" && "meaning" in entry);
  return {
    ok: true,
    value: {
      entries,
      introduced,
      alwaysAbsent,
      ...(renamed === undefined ? {} : { renamedTo: [...property.slice(0, -1), renamed.renamed] }),
      ...(wrapped === undefined ? {} : { elementsAt: [...property, wrapped.wrapped, ELEMENT] }),
      ...(values === undefined ? {} : { values: values.values }),
      ...(meaning === undefined ? {} : { meaning: meaning.meaning }),
    },
  };
}

/** The change as the answer echoes it: a single entry as written, several as their normalized list. */
export function writtenChange({ entries }: Change): ChangeEntry | readonly ChangeEntry[] {
  return entries.length === 1 ? entries[0]! : entries;
}

export function formatChange(change: Change): string {
  const written = writtenChange(change);
  return typeof written === "string" ? written : canonicalJson(written);
}

function entryOf(item: ChangeEntryInput): ChangeEntry | undefined {
  if (typeof item === "string") return NAMED_KINDS.find((kind) => kind === item);
  const keys = Object.keys(item);
  const [key] = keys;
  if (keys.length !== 1) return undefined;
  if (key === "type") return TYPE_KINDS.find((kind) => kind === item.type) === undefined ? undefined : { type: item.type as ValueClass };
  if (key === "values") return valuesOf(item.values);
  if (key === "meaning") return typeof item.meaning === "string" && item.meaning.trim() !== "" ? { meaning: item.meaning } : undefined;
  if (key !== "renamed" && key !== "wrapped") return undefined;
  const written = item[key];
  if (typeof written !== "string") return undefined;
  const name = parseAccessPath(written);
  return name?.length === 1 && name[0] !== ELEMENT ? (key === "renamed" ? { renamed: written } : { wrapped: written }) : undefined;
}

const LITERAL_ORDER = ["boolean", "number", "string"];

function valuesOf(written: unknown): ChangeEntry | undefined {
  if (typeof written !== "object" || written === null || Array.isArray(written)) return undefined;
  const lists = written as Readonly<Record<string, unknown>>;
  if (Object.keys(lists).some((key) => key !== "added" && key !== "removed")) return undefined;
  const added = literalsOf(lists.added);
  const removed = literalsOf(lists.removed);
  return added === undefined || removed === undefined || added.length + removed.length === 0 ? undefined : { values: { added, removed } };
}

/** A missing list is empty; anything but a list of strings, finite numbers and booleans is not a list of literals. */
function literalsOf(written: unknown): Literal[] | undefined {
  if (written === undefined) return [];
  if (!Array.isArray(written) || !written.every(isLiteral)) return undefined;
  const literals = [...new Set<Literal>(written)];
  return literals.sort((a, b) => LITERAL_ORDER.indexOf(typeof a) - LITERAL_ORDER.indexOf(typeof b) || (a < b ? -1 : a > b ? 1 : 0));
}

const isLiteral = (written: unknown): written is Literal => typeof written === "boolean" || typeof written === "string" || (typeof written === "number" && Number.isFinite(written));

const kindOf = (entry: ChangeEntry): ChangeKind => (typeof entry === "string" ? entry : (CHANGE_KINDS.find((kind) => kind in entry) as ChangeKind));

const introducedBy = (entry: ChangeEntry): ValueClass | undefined => {
  if (typeof entry === "string") return entry === "nullable" ? "null" : "undefined";
  if ("type" in entry) return entry.type;
  if ("wrapped" in entry) return "object";
  return "renamed" in entry ? "undefined" : undefined;
};

/** Two kinds stated for one value, a wrapper that is also a stated kind, or two wrappers: entries no value can satisfy together. */
function contradicts(entries: readonly ChangeEntry[]): boolean {
  if (entries.some((entry) => typeof entry === "object" && "values" in entry && entry.values.added.some((literal) => entry.values.removed.includes(literal)))) return true;
  const of = (kind: ChangeKind) => entries.filter((entry) => kindOf(entry) === kind);
  return of("type").length > 1 || of("wrapped").length > 1 || (of("wrapped").length > 0 && of("type").length > 0) || of("values").length > 1 || statesOtherKind(entries);
}

/** A literal of a kind other than the one a `type` entry states, or any literal when it states an array or an object: a value no value can be. */
function statesOtherKind(entries: readonly ChangeEntry[]): boolean {
  const stated = entries.find((entry) => typeof entry === "object" && "type" in entry);
  const listed = entries.find((entry) => typeof entry === "object" && "values" in entry);
  return stated !== undefined && listed !== undefined && [...listed.values.added, ...listed.values.removed].some((literal) => typeof literal !== stated.type);
}

const isList = (input: ChangeInput): input is readonly ChangeEntryInput[] => Array.isArray(input);

function refuse(kind: ChangeRefusal["kind"], written: ChangeInput): Result<never, ChangeRefusal> {
  return { ok: false, fault: { kind, detail: typeof written === "string" ? written : canonicalJson(written) } };
}
