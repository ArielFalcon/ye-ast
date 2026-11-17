import type { ExportStop, SkippedEntry } from "../../ports/vcs.port.ts";

/** One accepted regular file of a commit: where it is and which blob it holds. */
export interface ListedBlob {
  readonly path: string;
  readonly blob: string;
}

/**
 * What `git ls-tree` says about one commit, before any plan: every accepted file in git's order, every skipped entry,
 * and where the entry budget stopped it. None of it depends on the plan, so every plan over the commit is decided from it.
 */
export interface CommitTree {
  readonly files: readonly ListedBlob[];
  readonly skipped: readonly SkippedEntry[];
  readonly stop: ExportStop | undefined;
}

/** What the memo keeps for one commit and one entry budget: its tree and the byte length of the blobs a plan has selected so far. */
export interface KeptListing {
  readonly tree: CommitTree;
  readonly sizes: ReadonlyMap<string, number>;
}

/** The commit listings kept in memory, by repository, sha and entry budget, under a byte charge (ADR-0123). */
export interface ListingMemo {
  get(repo: string, sha: string, maxEntries: number): KeptListing | undefined;
  /** Keeps `tree` and every size of `sizes`, joining the sizes the entry already holds; an entry that does not fit the bound is left out. */
  admit(repo: string, sha: string, maxEntries: number, tree: CommitTree, sizes: ReadonlyMap<string, number>): void;
}

/** What one entry of the memo counts beyond the text it holds: the record, the object and the map slot that carry it. */
const RECORD_OVERHEAD_BYTES = 96;
const BLOB_ID_BYTES = 40;

const keyOf = (repo: string, sha: string, maxEntries: number): string => `${maxEntries}\0${sha}\0${repo}`;

/** The bytes a kept listing of `tree` charges, with `sizes` blob sizes learned. */
export function listingCharge(tree: CommitTree, sizes: number): number {
  return chargeOfTree(tree) + sizes * chargeOfSize();
}

function chargeOfTree({ files, skipped, stop }: CommitTree): number {
  let bytes = RECORD_OVERHEAD_BYTES + (stop === undefined ? 0 : Buffer.byteLength(stop.at));
  for (const file of files) bytes += RECORD_OVERHEAD_BYTES + BLOB_ID_BYTES + Buffer.byteLength(file.path);
  for (const entry of skipped) bytes += RECORD_OVERHEAD_BYTES + Buffer.byteLength(entry.path);
  return bytes;
}

const chargeOfSize = (): number => RECORD_OVERHEAD_BYTES + BLOB_ID_BYTES;

/**
 * Least recently used first. The key names the commit by its full sha, whose tree is immutable, the repository it was
 * read from and the entry budget the listing stopped at; a listing is admitted only after git answered it whole, so
 * nothing cut by an abort or a fault is kept. Trust is no part of the key: the listing reads the object store alone.
 * What is admitted is copied and frozen, and what is returned is never the memo's own object.
 */
export function createListingMemo(maxBytes: number): ListingMemo {
  const kept = new Map<string, { listing: KeptListing; bytes: number }>();
  let retained = 0;

  function evictUntilFits(room: number, keep: string): void {
    for (const [key, entry] of kept) {
      if (retained <= room) return;
      if (key === keep) continue;
      kept.delete(key);
      retained -= entry.bytes;
    }
  }

  return {
    get(repo, sha, maxEntries) {
      const key = keyOf(repo, sha, maxEntries);
      const entry = kept.get(key);
      if (entry === undefined) return undefined;
      kept.delete(key);
      kept.set(key, entry);
      return entry.listing;
    },
    admit(repo, sha, maxEntries, tree, sizes) {
      const key = keyOf(repo, sha, maxEntries);
      const previous = kept.get(key);
      const merged = new Map(previous?.listing.sizes);
      for (const [blob, size] of sizes) merged.set(blob, size);
      const listing: KeptListing = previous === undefined ? { tree: frozenTree(tree), sizes: merged } : { tree: previous.listing.tree, sizes: merged };
      const bytes = listingCharge(listing.tree, merged.size);
      if (previous !== undefined) {
        kept.delete(key);
        retained -= previous.bytes;
      }
      if (bytes > maxBytes) return;
      kept.set(key, { listing, bytes });
      retained += bytes;
      evictUntilFits(maxBytes, key);
    },
  };
}

function frozenTree({ files, skipped, stop }: CommitTree): CommitTree {
  return Object.freeze({
    files: Object.freeze(files.map(({ path, blob }) => Object.freeze({ path, blob }))),
    skipped: Object.freeze(skipped.map(({ path, reason }) => Object.freeze({ path, reason }))),
    stop: stop === undefined ? undefined : Object.freeze({ at: stop.at, limit: stop.limit }),
  });
}
