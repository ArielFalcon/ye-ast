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
  const entries = new Map<string, { payload: Uint8Array; size: number }>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  let used = 0;

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) {
        observe?.({ outcome: "miss", retainedBytes: used });
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      observe?.({ outcome: "hit", entryBytes: entry.size, retainedBytes: used });
      return JSON.parse(decoder.decode(entry.payload)) as SnapshotData;
    },
    put(key, data) {
      const previous = entries.get(key);
      if (previous !== undefined) {
        used -= previous.size;
        entries.delete(key);
      }
      if (budget === 0) return;
      const lowerBound = encoder.encode(key).byteLength + data.sources.reduce((sum, source) => sum + utf8Length(source.content), 0);
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
      while (used + size > budget) {
        const oldest = entries.keys().next().value!;
        const evictedBytes = entries.get(oldest)!.size;
        used -= evictedBytes;
        entries.delete(oldest);
        observe?.({ outcome: "evicted", entryBytes: evictedBytes, retainedBytes: used });
      }
      entries.set(key, { payload, size });
      used += size;
      observe?.({ outcome: "admitted", entryBytes: size, retainedBytes: used });
    },
  };
}

/** The UTF-8 bytes of a string without encoding it: a lone surrogate counts as the three bytes of U+FFFD. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}
