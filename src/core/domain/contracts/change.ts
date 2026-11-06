import { canonicalJson } from "../shared/canonical-json.ts";
import type { Result } from "../shared/result.ts";
import { ELEMENT, parseAccessPath, type AccessPath } from "./access-path.ts";

/** The classes of JSON value a change can introduce, in the order a normalized change lists them. */
export const VALUE_CLASSES = ["null", "undefined", "boolean", "number", "string", "array", "object"] as const;

export type ValueClass = (typeof VALUE_CLASSES)[number];

const NAMED_KINDS = ["nullable", "optional", "removed"] as const;

/** The kinds of change, in the order a normalized change lists them. */
const CHANGE_KINDS = [...NAMED_KINDS, "renamed", "type", "wrapped"] as const;

type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The kinds a `type` change can state: every class but the absences. */
const TYPE_KINDS: readonly ValueClass[] = ["boolean", "number", "string", "array", "object"];

/** One constraint on the changed property. */
export type ChangeEntry = (typeof NAMED_KINDS)[number] | { renamed: string } | { type: ValueClass } | { wrapped: string };

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
  return {
    ok: true,
    value: {
      entries,
      introduced,
      alwaysAbsent,
      ...(renamed === undefined ? {} : { renamedTo: [...property.slice(0, -1), renamed.renamed] }),
      ...(wrapped === undefined ? {} : { elementsAt: [...property, wrapped.wrapped, ELEMENT] }),
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
  if (key !== "renamed" && key !== "wrapped") return undefined;
  const written = item[key];
  if (typeof written !== "string") return undefined;
  const name = parseAccessPath(written);
  return name?.length === 1 && name[0] !== ELEMENT ? (key === "renamed" ? { renamed: written } : { wrapped: written }) : undefined;
}

const kindOf = (entry: ChangeEntry): ChangeKind => (typeof entry === "string" ? entry : "renamed" in entry ? "renamed" : "type" in entry ? "type" : "wrapped");

const introducedBy = (entry: ChangeEntry): ValueClass | undefined => {
  if (typeof entry === "string") return entry === "nullable" ? "null" : "undefined";
  if ("type" in entry) return entry.type;
  return "wrapped" in entry ? "object" : "undefined";
};

/** Two kinds stated for one value, a wrapper that is also a stated kind, or two wrappers: entries no value can satisfy together. */
function contradicts(entries: readonly ChangeEntry[]): boolean {
  const of = (kind: ChangeKind) => entries.filter((entry) => kindOf(entry) === kind);
  return of("type").length > 1 || of("wrapped").length > 1 || (of("wrapped").length > 0 && of("type").length > 0);
}

const isList = (input: ChangeInput): input is readonly ChangeEntryInput[] => Array.isArray(input);

function refuse(kind: ChangeRefusal["kind"], written: ChangeInput): Result<never, ChangeRefusal> {
  return { ok: false, fault: { kind, detail: typeof written === "string" ? written : canonicalJson(written) } };
}
