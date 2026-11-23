import type { SourceFile } from "./source-file.port.ts";

/**
 * Where the syntax trees parsed from one snapshot read's sources live until the read ends (ADR-0040). A reader that
 * parses a source a hold kept gets the tree the hold parsed once; any other parse is the reader's own to free.
 */
export interface ParseHolds {
  open(): ParseHold;
}

export interface ParseHold {
  /**
   * The sources as this hold's own copies: the objects readers parse once while the hold is open. With a residence, a
   * tree parsed for or reused by a copy is also kept resident there (ADR-0155); a copy of a copy carries its residence.
   */
  keep(sources: readonly SourceFile[], residence?: TreeResidence): SourceFile[];
  /** Whether the hold is still open: `release` closes it, and a closed hold owns no tree. */
  open(): boolean;
  /** Gives up this hold's ownership of every tree it was handed; a source it kept parses as one no hold kept from then on. */
  release(): void;
}

/** Where a read keeps the trees of its sources resident after it ends, charged to the content it reads (ADR-0155). */
export interface TreeResidence {
  /**
   * Keeps `key` resident with a charge of `bytes`: a key already kept is marked used by this read and keeps its first
   * `evicted`; otherwise it is admitted with `evicted`, called once when the residence lets it go. Answers whether the
   * key is kept after the call.
   */
  reside(key: string, bytes: number, evicted: () => void): boolean;
}
