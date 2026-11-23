import { frozenValue } from "../../domain/shared/frozen-value.ts";
import type { SnapshotData, SnapshotDataCache, SnapshotReadContent } from "./read-snapshot.ts";

/**
 * What one lookup or one `put` decided. `entryBytes` is the charge of the entry concerned (absent on a miss);
 * `retainedBytes` is what the cache holds after the decision. For `oversize-skipped`, `entryBytes` is the charge of the
 * key plus the UTF-8 bytes of the sources' contents when that alone exceeds the budget (the entry is then never
 * serialized), the exact charge otherwise.
 */
export interface SnapshotCacheEvent {
  outcome: "hit" | "miss" | "admitted" | "evicted" | "oversize-skipped";
  entryBytes?: number;
  retainedBytes: number;
}

/** The units (reads, or the queries that group reads) before the current one whose entries a floor budget never evicts: the base and the head of a change query. */
const HELD_READS = 2;

/**
 * The heap a decoded, frozen entry takes per UTF-8 byte of its key and serialized value, measured through this cache:
 * 1.45-1.76 for derived facts, 0.96-2.07 for a sources entry (2.07 when every string is ASCII, so the decoded strings keep
 * the serialized text alive), rounded up (ADR-0147). Every charge is these bytes, so the budget, the floor and
 * `retainedBytes` count the heap the cache holds, not its serialized size.
 */
export const DECODED_HEAP_PER_SERIALIZED_BYTE = 2.1;

/**
 * The working-set floor: a byte count derived from use, never configured (ADR-0147). Per repository it counts what the
 * entries last used by its latest `1 + HELD_READS` distinct contents of the live tree and of its revisions charge, so an
 * edit moves the live tree's contents and leaves the base revision of a change query counted; the floor is the largest
 * such count measured since the cache began, so it holds one repository's recent working set whatever its size, and a
 * host serving many repositories holds the largest of them, not their sum.
 */
function createWorkingSetFloor() {
  const recent = new Map<string, { live: string[]; revision: string[] }>();
  const charged = new Map<string, number>();
  let floor = 0;
  let latest = "";
  const measure = (): void => {
    const contents = recent.get(latest);
    const total = [...(contents?.live ?? []), ...(contents?.revision ?? [])].reduce((sum, content) => sum + (charged.get(content) ?? 0), 0);
    if (total > floor) floor = total;
  };
  return {
    /** Makes the content a read reads the latest of its repository's live tree or revisions; answers its tag and the content that left. */
    read({ repository, snapshot, key }: SnapshotReadContent): { content: string; left: string | undefined } {
      const content = `${repository}\0${key}`;
      const contents = recent.get(repository) ?? { live: [], revision: [] };
      const ordered = [content, ...contents[snapshot].filter((other) => other !== content)];
      contents[snapshot] = ordered.slice(0, 1 + HELD_READS);
      recent.set(repository, contents);
      latest = repository;
      measure();
      return { content, left: ordered[1 + HELD_READS] };
    },
    /** Moves `bytes` from the content an entry was last used by to the latest read's content `to` (either may be absent). */
    move(bytes: number, from: string | undefined, to: string | undefined): void {
      if (from !== undefined) {
        const left = (charged.get(from) ?? 0) - bytes;
        if (left > 0) charged.set(from, left);
        else charged.delete(from);
      }
      if (to !== undefined) {
        charged.set(to, (charged.get(to) ?? 0) + bytes);
        measure();
      }
    },
    bytes: () => floor,
  };
}

/** The heap charge of `serializedBytes` UTF-8 bytes once decoded and frozen. */
const charge = (serializedBytes: number): number => Math.ceil(serializedBytes * DECODED_HEAP_PER_SERIALIZED_BYTE);

type Entry = { value: unknown; size: number; fact: boolean; read: number; content: string | undefined };

/**
 * `budget` is either a hard cap on the retained bytes, or `"working-set"`: a floor derived from use below which nothing is
 * held back (ADR-0147). With the floor an admission evicts first the entries last used by a content that left its
 * repository's recent ones, then the least recently used, but never one the current read or the `HELD_READS` before it
 * used, so a working set larger than the floor is retained whole and the next read finds it (ADR-0112). All the reads
 * made while a query is open are one read, whatever the number of snapshots the query spans, and each query is its own
 * read even when queries overlap: what was used since the oldest open query began is held until it ends, so the floor
 * never holds more than the open queries used (ADR-0121).
 */
export function createSnapshotDataCache(budget: number | "working-set", observe?: (event: SnapshotCacheEvent) => void): SnapshotDataCache {
  const entries = new Map<string, Entry>();
  const stale = new Map<string, Entry>();
  const floor = budget === "working-set";
  const cap = typeof budget === "number" && Number.isSafeInteger(budget) && budget > 0 ? budget : 0;
  const workingSet = createWorkingSetFloor();
  const limit = (): number => (floor ? workingSet.bytes() : cap);
  let used = 0;
  let factBytes = 0;
  let read = 0;
  let content: string | undefined;
  const openQueries: number[] = [];
  const heldFrom = (): number => Math.min(read - HELD_READS, ...openQueries);
  const held = (entry: { read: number }, from: number): boolean => floor && entry.read > 0 && entry.read >= from;
  const holderOf = (key: string): Map<string, Entry> | undefined => (entries.has(key) ? entries : stale.has(key) ? stale : undefined);
  const release = (key: string): number => {
    const holder = holderOf(key)!;
    const entry = holder.get(key)!;
    holder.delete(key);
    used -= entry.size;
    if (entry.fact) factBytes -= entry.size;
    workingSet.move(entry.size, entry.content, undefined);
    return entry.size;
  };
  const lookup = (key: string): { value: unknown; size: number } | undefined => {
    const holder = holderOf(key);
    const entry = holder?.get(key);
    if (holder === undefined || entry === undefined) return undefined;
    holder.delete(key);
    workingSet.move(entry.size, entry.content, content);
    entry.read = read;
    entry.content = content;
    entries.set(key, entry);
    return entry;
  };
  /** Evicts least recently used entries until `size` fits, then holds the entry; answers how many entries it evicted. */
  const admit = (key: string, value: unknown, size: number, fact: boolean): number => {
    let evicted = 0;
    workingSet.move(size, undefined, content);
    const from = heldFrom();
    while (used + size > limit()) {
      const oldest = (stale.size > 0 ? stale : entries).entries().next().value;
      if (oldest === undefined || held(oldest[1], from)) break;
      const evictedBytes = release(oldest[0]);
      evicted++;
      observe?.({ outcome: "evicted", entryBytes: evictedBytes, retainedBytes: used });
    }
    entries.set(key, { value, size, fact, read, content });
    used += size;
    if (fact) factBytes += size;
    return evicted;
  };
  return {
    beginRead(of) {
      if (openQueries.length === 0) read++;
      if (of === undefined) {
        content = undefined;
        return;
      }
      const { content: reading, left } = workingSet.read(of);
      content = reading;
      if (left === undefined) return;
      for (const [key, entry] of entries) {
        if (entry.content !== left) continue;
        entries.delete(key);
        stale.set(key, entry);
      }
    },
    beginQuery() {
      openQueries.push(++read);
      const began = read;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        openQueries.splice(openQueries.indexOf(began), 1);
      };
    },
    get(key) {
      const entry = lookup(key);
      if (entry === undefined) {
        observe?.({ outcome: "miss", retainedBytes: used });
        return undefined;
      }
      observe?.({ outcome: "hit", entryBytes: entry.size, retainedBytes: used });
      return entry.value as SnapshotData;
    },
    put(key, data) {
      if (holderOf(key) !== undefined) release(key);
      if (!floor && cap === 0) return undefined;
      const lowerBound = charge(Buffer.byteLength(key) + data.sources.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0));
      if (!floor && lowerBound > cap) {
        observe?.({ outcome: "oversize-skipped", entryBytes: lowerBound, retainedBytes: used });
        return undefined;
      }
      const json = JSON.stringify(data);
      const size = charge(Buffer.byteLength(key) + Buffer.byteLength(json));
      if (!floor && size > cap) {
        observe?.({ outcome: "oversize-skipped", entryBytes: size, retainedBytes: used });
        return undefined;
      }
      const value = frozenValue(json) as SnapshotData;
      admit(key, value, size, false);
      observe?.({ outcome: "admitted", entryBytes: size, retainedBytes: used });
      return value;
    },
    getFact: (key) => lookup(key)?.value,
    putFact(key, json) {
      if (holderOf(key) !== undefined) release(key);
      const value = frozenValue(json);
      const size = charge(Buffer.byteLength(key) + Buffer.byteLength(json));
      if (!floor && size > cap) return { admitted: false, entryBytes: size, evicted: 0, value };
      return { admitted: true, entryBytes: size, evicted: admit(key, value, size, true), value };
    },
    usage: () => ({ factBytes, retainedBytes: used, floorBytes: limit() }),
  };
}
