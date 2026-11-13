/**
 * The value ledger of the corpus gate (RFC-0031): the entries the facts of one side hold, counted by family, language
 * and collection, and the entries a candidate gained, lost and changed against a base. Pure: no I/O, no clock.
 *
 * A collection is an array reached through object keys alone, from the fact's value or from an entry of another
 * collection; a nested one is named by both paths, such as `files/importers`. An array of numbers inside an entry is
 * not a collection but part of that entry's content: its numbers are positions or references into another collection
 * (lines, step ids), so a change to it changes the entry that holds it.
 *
 * An entry is identified by its place: the {@link PLACE_FIELDS} of the shallowest objects, reached through object keys
 * alone from the entry, that state one of {@link PLACE_NAMES} as a string. An entry that states no place is identified
 * by its whole content. A nested entry's identity includes the identity of the entry that holds it, so the same
 * importer under two files is two entries. Entries of one collection that share an identity are paired in the order
 * the answer lists them. An identity only the candidate holds is gained, one only the base holds is lost, one both hold
 * with different content is changed; the three are never netted, so a side's entries are the other's plus gained
 * minus lost.
 */
import { type Answer, arraysAt, canonical, compareText, isObject, topFact } from "./corpus-gate-diff.ts";
import { languageOf } from "./corpus-gate-ledger.ts";

/** The fields whose string value says that an object states where it is. */
const PLACE_NAMES = ["file", "path", "symbol", "name"] as const;
/** The fields that place a declaration, a file or a step of a walk (`at`, the call that reached it). */
const PLACE_FIELDS = ["repo", "file", "path", "symbol", "name", "kind", "line", "column", "at"] as const;

export interface ValueKey {
  family: string;
  /** The language whose profile reads the shallowest `file` the entry states, or the entry itself when it is a string; `none` otherwise. */
  language: string;
  /** The collection's path under the fact's value, such as `symbols`, `readingPlan/ranges` or `files/importers`. */
  collection: string;
}

export type ValueRow = ValueKey & { entries: number };

export interface ValueLedger {
  rows: ValueRow[];
  entries: number;
}

export type ValueDifferenceRow = ValueKey & { gained: number; lost: number; changed: number };

export interface ValueDifference {
  rows: ValueDifferenceRow[];
  totals: { gained: number; lost: number; changed: number };
}

interface Entry {
  collection: string;
  language: string;
  content: string;
}

/** The entries of one side's answers; an answer that is not a fact with a value, exited zero, holds none. */
export function valueLedger(answers: readonly Answer[]): ValueLedger {
  const counts = new Map<string, ValueRow>();
  for (const answer of answers) {
    for (const entry of entriesOf(answer).values()) {
      const key = { family: answer.family, language: entry.language, collection: entry.collection };
      const row = counts.get(keyText(key)) ?? { ...key, entries: 0 };
      counts.set(keyText(key), row);
      row.entries += 1;
    }
  }
  const rows = sortedRows(counts);
  return { rows, entries: rows.reduce((sum, row) => sum + row.entries, 0) };
}

/** Per key, the entries gained, lost and changed between the answers of the same id; a changed entry counts in the candidate's language. */
export function valueDifference(base: readonly Answer[], candidate: readonly Answer[]): ValueDifference {
  const baseById = new Map(base.map((answer) => [answer.id, answer]));
  const candidateById = new Map(candidate.map((answer) => [answer.id, answer]));
  const counts = new Map<string, ValueDifferenceRow>();
  const count = (family: string, entry: Entry, side: "gained" | "lost" | "changed") => {
    const key = { family, language: entry.language, collection: entry.collection };
    const row = counts.get(keyText(key)) ?? { ...key, gained: 0, lost: 0, changed: 0 };
    counts.set(keyText(key), row);
    row[side] += 1;
  };
  for (const id of new Set([...baseById.keys(), ...candidateById.keys()])) {
    const before = baseById.get(id);
    const after = candidateById.get(id);
    const family = (before ?? after)!.family;
    const baseEntries = before === undefined ? new Map<string, Entry>() : entriesOf(before);
    const candidateEntries = after === undefined ? new Map<string, Entry>() : entriesOf(after);
    for (const [identity, entry] of baseEntries) if (!candidateEntries.has(identity)) count(family, entry, "lost");
    for (const [identity, entry] of candidateEntries) {
      const held = baseEntries.get(identity);
      if (held === undefined) count(family, entry, "gained");
      else if (held.content !== entry.content) count(family, entry, "changed");
    }
  }
  const rows = sortedRows(counts);
  const total = (side: "gained" | "lost" | "changed") => rows.reduce((sum, row) => sum + row[side], 0);
  return { rows, totals: { gained: total("gained"), lost: total("lost"), changed: total("changed") } };
}

/** Every entry of the answer's fact, by its collection and identity. */
function entriesOf(answer: Answer): Map<string, Entry> {
  const fact = answer.exit === 0 ? topFact(answer.stdout) : null;
  const found = new Map<string, Entry>();
  if (fact !== null && isObject(fact.value)) collect(fact.value, null, found);
  return found;
}

function collect(holder: Record<string, unknown>, held: { collection: string; identity: string } | null, found: Map<string, Entry>): void {
  for (const [path, array] of arraysAt(holder)) {
    if (held !== null && array.every((element) => typeof element === "number")) continue;
    const collection = held === null ? path.slice(1) : `${held.collection}${path}`;
    const occurrences = new Map<string, number>();
    for (const element of array) {
      const place = identityOf(element);
      const occurrence = occurrences.get(place) ?? 0;
      occurrences.set(place, occurrence + 1);
      const identity = [held?.identity ?? "", place, occurrence].join("\n");
      found.set(`${collection}\n${identity}`, { collection, language: languageOf(fileOf(element)), content: canonical(element) });
      if (isObject(element)) collect(element, { collection, identity }, found);
    }
  }
}

/** The place fields of the shallowest objects that state a place, by their key path from the entry; the whole entry when none does. */
function identityOf(entry: unknown): string {
  let level: [string, unknown][] = [["", entry]];
  while (level.length > 0) {
    const placed = level.filter((pair): pair is [string, Record<string, unknown>] => statesPlace(pair[1]));
    if (placed.length > 0) return canonical(Object.fromEntries(placed.map(([path, node]) => [path, Object.fromEntries(PLACE_FIELDS.filter((field) => field in node).map((field) => [field, node[field]]))])));
    level = level.flatMap(([path, node]) => (isObject(node) ? Object.keys(node).map((key): [string, unknown] => [`${path}/${key}`, node[key]]) : []));
  }
  return canonical(entry);
}

function statesPlace(node: unknown): node is Record<string, unknown> {
  return isObject(node) && PLACE_NAMES.some((name) => typeof node[name] === "string");
}

/** The entry itself when it is a string, otherwise the shallowest `file` string reached through object keys alone. */
function fileOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  let level: unknown[] = [entry];
  while (level.length > 0) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!isObject(node)) continue;
      if (typeof node.file === "string") return node.file;
      next.push(...Object.values(node));
    }
    level = next;
  }
  return undefined;
}

function keyText({ family, language, collection }: ValueKey): string {
  return [family, language, collection].join("\0");
}

function sortedRows<T extends ValueKey>(rows: ReadonlyMap<string, T>): T[] {
  return [...rows.entries()].sort(([a], [b]) => compareText(a, b)).map(([, row]) => row);
}
