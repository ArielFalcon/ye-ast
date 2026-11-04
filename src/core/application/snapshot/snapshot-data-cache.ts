import type { SnapshotData, SnapshotDataCache } from "./read-snapshot.ts";

export function createSnapshotDataCache(maxBytes: number): SnapshotDataCache {
  const entries = new Map<string, { payload: Uint8Array; size: number }>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  let used = 0;

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return JSON.parse(decoder.decode(entry.payload)) as SnapshotData;
    },
    put(key, data) {
      const previous = entries.get(key);
      if (previous !== undefined) {
        used -= previous.size;
        entries.delete(key);
      }
      if (budget === 0) return;
      const payload = encoder.encode(JSON.stringify(data));
      const size = encoder.encode(key).byteLength + payload.byteLength;
      if (size > budget) return;
      while (used + size > budget) {
        const oldest = entries.keys().next().value!;
        used -= entries.get(oldest)!.size;
        entries.delete(oldest);
      }
      entries.set(key, { payload, size });
      used += size;
    },
  };
}
