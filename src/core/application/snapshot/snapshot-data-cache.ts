import type { SnapshotData, SnapshotDataCache } from "./read-snapshot.ts";

/**
 * What one lookup or one `put` decided. `entryBytes` is the charge of the entry concerned (absent on a miss);
 * `retainedBytes` is what the cache holds after the decision. For `oversize-skipped`, `entryBytes` is the key plus the
 * UTF-8 bytes of the sources' contents when that alone exceeds the budget (the entry is then never serialized), the
 * exact charge otherwise.
 */
export interface SnapshotCacheEvent {
  outcome: "hit" | "miss" | "admitted" | "evicted" | "oversize-skipped";
  entryBytes?: number;
  retainedBytes: number;
}

export function createSnapshotDataCache(maxBytes: number, observe?: (event: SnapshotCacheEvent) => void): SnapshotDataCache {
  const entries = new Map<string, { payload: Uint8Array; size: number; fact: boolean }>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  let used = 0;
  let factBytes = 0;
  const release = (key: string): number => {
    const entry = entries.get(key)!;
    entries.delete(key);
    used -= entry.size;
    if (entry.fact) factBytes -= entry.size;
    return entry.size;
  };
  const lookup = (key: string): Uint8Array | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    entries.delete(key);
    entries.set(key, entry);
    return entry.payload;
  };
  /** Evicts least recently used entries until `size` fits, then holds the entry; answers how many entries it evicted. */
  const admit = (key: string, payload: Uint8Array, size: number, fact: boolean): number => {
    let evicted = 0;
    while (used + size > budget) {
      const evictedBytes = release(entries.keys().next().value!);
      evicted++;
      observe?.({ outcome: "evicted", entryBytes: evictedBytes, retainedBytes: used });
    }
    entries.set(key, { payload, size, fact });
    used += size;
    if (fact) factBytes += size;
    return evicted;
  };
  return {
    get(key) {
      const payload = lookup(key);
      if (payload === undefined) {
        observe?.({ outcome: "miss", retainedBytes: used });
        return undefined;
      }
      observe?.({ outcome: "hit", entryBytes: entries.get(key)!.size, retainedBytes: used });
      return JSON.parse(decoder.decode(payload)) as SnapshotData;
    },
    put(key, data) {
      if (entries.has(key)) release(key);
      if (budget === 0) return;
      const lowerBound = encoder.encode(key).byteLength + data.sources.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0);
      if (lowerBound > budget) {
        observe?.({ outcome: "oversize-skipped", entryBytes: lowerBound, retainedBytes: used });
        return;
      }
      const payload = encoder.encode(JSON.stringify(data));
      const size = encoder.encode(key).byteLength + payload.byteLength;
      if (size > budget) {
        observe?.({ outcome: "oversize-skipped", entryBytes: size, retainedBytes: used });
        return;
      }
      admit(key, payload, size, false);
      observe?.({ outcome: "admitted", entryBytes: size, retainedBytes: used });
    },
    getFact(key) {
      const payload = lookup(key);
      return payload === undefined ? undefined : JSON.parse(decoder.decode(payload));
    },
    putFact(key, json) {
      if (entries.has(key)) release(key);
      const payload = encoder.encode(json);
      const size = encoder.encode(key).byteLength + payload.byteLength;
      if (size > budget) return { admitted: false, entryBytes: size, evicted: 0 };
      return { admitted: true, entryBytes: size, evicted: admit(key, payload, size, true) };
    },
    usage: () => ({ factBytes, retainedBytes: used }),
  };
}
