/**
 * The value ledger of the corpus gate (RFC-0031): the entries the facts of one side hold, counted by family, language
 * and collection, and the entries a candidate gained and lost against a base. A collection is an array reached from the
 * fact's value through object keys alone, the arrays the per-answer counters read; an entry's identity is the one the
 * per-answer comparison uses, so a modified entry is one lost and one gained. Pure: no I/O, no clock.
 */
import { type Answer, arraysAt, compareText, differences, isObject, topFact } from "./corpus-gate-diff.ts";
import { languageOf } from "./corpus-gate-ledger.ts";

export interface ValueKey {
  family: string;
  /** The language whose profile reads the shallowest `file` the entry states, or the entry itself when it is a string; `none` otherwise. */
  language: string;
  /** The collection's path under the fact's value, such as `symbols` or `readingPlan/ranges`. */
  collection: string;
}

export type ValueRow = ValueKey & { entries: number };

export interface ValueLedger {
  rows: ValueRow[];
  entries: number;
}

export type ValueDifferenceRow = ValueKey & { gained: number; lost: number };

export interface ValueDifference {
  rows: ValueDifferenceRow[];
  totals: { gained: number; lost: number };
}

/** The entries of one side's answers; an answer that is not a fact with a value, exited zero, holds none. */
export function valueLedger(answers: readonly Answer[]): ValueLedger {
  const counts = new Map<string, ValueRow>();
  for (const answer of answers) {
    for (const [collection, entries] of collectionsOf(answer)) {
      for (const entry of entries) {
        const key = keyOf(answer.family, collection, entry);
        const row = counts.get(keyText(key)) ?? { ...key, entries: 0 };
        counts.set(keyText(key), row);
        row.entries += 1;
      }
    }
  }
  const rows = sortedRows(counts);
  return { rows, entries: rows.reduce((sum, row) => sum + row.entries, 0) };
}

/** Per key, the entries the candidate's answer holds and the base's does not (gained) and the reverse (lost), never netted. */
export function valueDifference(base: readonly Answer[], candidate: readonly Answer[]): ValueDifference {
  const candidateById = new Map(candidate.map((answer) => [answer.id, answer]));
  const counts = new Map<string, ValueDifferenceRow>();
  const count = (family: string, collection: string, entry: unknown, side: "gained" | "lost") => {
    const key = keyOf(family, collection, entry);
    const row = counts.get(keyText(key)) ?? { ...key, gained: 0, lost: 0 };
    counts.set(keyText(key), row);
    row[side] += 1;
  };
  for (const before of base) {
    const after = candidateById.get(before.id);
    const baseCollections = collectionsOf(before);
    const candidateCollections = after === undefined ? new Map<string, readonly unknown[]>() : collectionsOf(after);
    for (const collection of new Set([...baseCollections.keys(), ...candidateCollections.keys()])) {
      for (const difference of differences(baseCollections.get(collection) ?? [], candidateCollections.get(collection) ?? [])) {
        if (difference.kind === "added") count(before.family, collection, difference.candidate, "gained");
        if (difference.kind === "removed") count(before.family, collection, difference.base, "lost");
      }
    }
  }
  const rows = sortedRows(counts);
  return { rows, totals: { gained: rows.reduce((sum, row) => sum + row.gained, 0), lost: rows.reduce((sum, row) => sum + row.lost, 0) } };
}

function collectionsOf(answer: Answer): Map<string, readonly unknown[]> {
  const fact = answer.exit === 0 ? topFact(answer.stdout) : null;
  if (fact === null || !isObject(fact.value)) return new Map();
  return new Map([...arraysAt(fact.value)].map(([path, entries]) => [path.slice(1), entries]));
}

function keyOf(family: string, collection: string, entry: unknown): ValueKey {
  return { family, language: languageOf(placeOf(entry)), collection };
}

/** The entry itself when it is a string, otherwise the shallowest `file` string reached through object keys alone. */
function placeOf(entry: unknown): string | undefined {
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
