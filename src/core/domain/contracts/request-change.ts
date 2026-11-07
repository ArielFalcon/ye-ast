import { canonicalJson } from "../shared/canonical-json.ts";
import type { Result } from "../shared/result.ts";
import { literalsOf, TYPE_KINDS, type ChangeInput, type ChangeRefusal, type ValueClass } from "./change.ts";
import { LITERAL_CLASSES, type ClassValues, type LiteralClass, type ValueSet } from "./payload-shape.ts";
import type { Literal } from "./use-operation.ts";

/** One thing a server stops accepting at a request property. */
export type RequestEntry = "required" | "non-nullable" | { type: ValueClass } | { values: { removed: readonly Literal[] } };

/** A request change normalized once per hypothesis: what the server no longer accepts, as the value set a producer must not write. */
export interface RequestChange {
  /** Each entry once, in a fixed order. */
  entries: readonly RequestEntry[];
  rejected: ValueSet;
}

const ORDER = ["required", "non-nullable", "type", "values"] as const;

const kindOf = (entry: RequestEntry): (typeof ORDER)[number] => (typeof entry === "string" ? entry : "type" in entry ? "type" : "values");

/** What a request hypothesis states is the server's rejection; the response kinds state what a reader may now receive and are refused. */
export function parseRequestChange(input: ChangeInput): Result<RequestChange, ChangeRefusal> {
  const written = Array.isArray(input) ? (input as readonly ChangeInput[]) : [input];
  const entries: RequestEntry[] = [];
  for (const item of written) {
    const entry = entryOf(item);
    if (entry === undefined) return refuse("unsupported-change", item);
    if (!entries.some((held) => canonicalJson(held) === canonicalJson(entry))) entries.push(entry);
  }
  if (entries.length === 0) return refuse("unsupported-change", input);
  if (contradicts(entries)) return refuse("contradictory-change", input);
  entries.sort((a, b) => ORDER.indexOf(kindOf(a)) - ORDER.indexOf(kindOf(b)));
  return { ok: true, value: { entries, rejected: rejectionOf(entries) } };
}

/** The change as the answer echoes it: a single entry as written, several as their normalized list. */
export function writtenRequestChange({ entries }: RequestChange): RequestEntry | readonly RequestEntry[] {
  return entries.length === 1 ? entries[0]! : entries;
}

function entryOf(item: ChangeInput): RequestEntry | undefined {
  if (typeof item === "string") return item === "required" || item === "non-nullable" ? item : undefined;
  if (Array.isArray(item)) return undefined;
  const object = item as Readonly<Record<string, unknown>>;
  const keys = Object.keys(object);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "type") return TYPE_KINDS.find((kind) => kind === object.type) === undefined ? undefined : { type: object.type as ValueClass };
  if (keys[0] !== "values") return undefined;
  const lists = object.values;
  if (typeof lists !== "object" || lists === null || Array.isArray(lists) || Object.keys(lists).some((key) => key !== "removed")) return undefined;
  const removed = literalsOf((lists as Readonly<Record<string, unknown>>).removed);
  return removed === undefined || removed.length === 0 ? undefined : { values: { removed } };
}

/** Two types, two lists of literals, or a literal in a class a type already rejects: entries no server can state together. */
function contradicts(entries: readonly RequestEntry[]): boolean {
  const types = entries.filter((entry) => typeof entry === "object" && "type" in entry);
  const lists = entries.filter((entry) => typeof entry === "object" && "values" in entry);
  if (types.length > 1 || lists.length > 1) return true;
  const [type] = types;
  const [list] = lists;
  return type !== undefined && list !== undefined && list.values.removed.some((literal) => typeof literal !== type.type);
}

function rejectionOf(entries: readonly RequestEntry[]): ValueSet {
  const type = entries.find((entry) => typeof entry === "object" && "type" in entry)?.type;
  const removed = entries.find((entry) => typeof entry === "object" && "values" in entry)?.values.removed ?? [];
  const literals = Object.fromEntries(LITERAL_CLASSES.map((valueClass): [LiteralClass, ClassValues] => [valueClass, type === undefined || type === valueClass ? removed.filter((literal) => typeof literal === valueClass) : "every"])) as Record<LiteralClass, ClassValues>;
  return {
    literals,
    array: type !== undefined && type !== "array",
    object: type !== undefined && type !== "object",
    null: entries.includes("non-nullable"),
    absent: entries.includes("required"),
  };
}

function refuse(kind: ChangeRefusal["kind"], written: ChangeInput): Result<never, ChangeRefusal> {
  return { ok: false, fault: { kind, detail: typeof written === "string" ? written : canonicalJson(written) } };
}
