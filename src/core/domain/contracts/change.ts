import { canonicalJson } from "../shared/canonical-json.ts";
import type { Result } from "../shared/result.ts";
import { ELEMENT, parseAccessPath, type AccessPath } from "./access-path.ts";
import type { Absence } from "./use-operation.ts";

const NAMED_KINDS = ["nullable", "optional", "removed"] as const;

/** The kinds of change, in the order a normalized change lists them. */
const CHANGE_KINDS = [...NAMED_KINDS, "renamed"] as const;

type ChangeKind = (typeof CHANGE_KINDS)[number];

/** One constraint on the changed property. */
export type ChangeEntry = (typeof NAMED_KINDS)[number] | { renamed: string };

/** One entry as a caller writes it, before it is checked. */
export type ChangeEntryInput = string | Readonly<Record<string, unknown>>;

/** A change as a caller writes it: one entry, or a non-empty list of entries on the same property. */
export type ChangeInput = ChangeEntryInput | readonly ChangeEntryInput[];

/** The value a kind lets in that the old guarantee ruled out. */
const INTRODUCES: Readonly<Record<ChangeKind, Absence>> = { nullable: "null", optional: "undefined", removed: "undefined", renamed: "undefined" };

/** A kind under which the property is never there: every present value is retired. */
const ALWAYS_ABSENT: ReadonlySet<ChangeKind> = new Set(["removed", "renamed"]);

const ABSENCES: readonly Absence[] = ["null", "undefined"];

/** A change normalized once per hypothesis: what it introduces and retires is decided here, never per use. */
export interface Change {
  /** Each entry once, in a fixed order. */
  entries: readonly ChangeEntry[];
  /** The values the new contract permits that the old one did not, `null` first. */
  introduced: readonly Absence[];
  alwaysAbsent: boolean;
  /** Where a renamed property sits under the new contract. */
  renamedTo?: AccessPath;
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
  const introduced = ABSENCES.filter((value) => entries.some((entry) => INTRODUCES[kindOf(entry)] === value));
  const renamed = entries.find((entry) => typeof entry !== "string");
  return { ok: true, value: { entries, introduced, alwaysAbsent, ...(renamed === undefined ? {} : { renamedTo: [...property.slice(0, -1), renamed.renamed] }) } };
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
  const { renamed } = item;
  if (typeof renamed !== "string" || Object.keys(item).length !== 1) return undefined;
  const name = parseAccessPath(renamed);
  return name?.length === 1 && name[0] !== ELEMENT ? { renamed } : undefined;
}

const kindOf = (entry: ChangeEntry): ChangeKind => (typeof entry === "string" ? entry : "renamed");

const isList = (input: ChangeInput): input is readonly ChangeEntryInput[] => Array.isArray(input);

function refuse(kind: ChangeRefusal["kind"], written: ChangeInput): Result<never, ChangeRefusal> {
  return { ok: false, fault: { kind, detail: typeof written === "string" ? written : canonicalJson(written) } };
}
