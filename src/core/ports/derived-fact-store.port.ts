import type { IndexRetentionPolicy } from "./index-cache.port.ts";

/** How long a kept derived fact nobody read may stay, and the logical bytes all of them may occupy: a budget apart from the index cache's, of the same shape (ADR-0077 decision 9). */
export type DerivedFactRetentionPolicy = IndexRetentionPolicy;

/**
 * The disk tier of the derived facts ([ADR-0077](../../../docs/architecture/adr/0077-derived-facts-persist-by-content-in-ye-asts-own-store.md)):
 * JSON values kept by key across processes, in ye-ast's own cache directory and written only by ye-ast. Both calls are
 * synchronous because a derivation by file is.
 */
export interface DerivedFactStore {
  /** The JSON `write` kept under `key`. `undefined` when there is none or the entry does not verify against its key and its bytes; such an entry is removed. */
  read(key: string): string | undefined;
  /** Keeps `json` under `key`, whole or not at all. Never throws: an entry that cannot be written is simply not kept. */
  write(key: string, json: string): void;
}

/** The disk tier of one view of derived facts: the store, and the version of the reader that owns each slot it keeps, folded into every key. A slot with no version is never kept. */
export interface DerivedFactDisk {
  store: DerivedFactStore;
  versions: Readonly<Record<string, string>>;
}
