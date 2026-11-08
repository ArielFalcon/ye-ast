import type { SourceFile } from "./entrypoint-extractor.port.ts";

/**
 * Where the syntax trees parsed from one snapshot read's sources live until the read ends (ADR-0040). A reader that
 * parses a source a hold kept gets the tree the hold parsed once; any other parse is the reader's own to free.
 */
export interface ParseHolds {
  open(): ParseHold;
}

export interface ParseHold {
  /** The sources as this hold's own copies: the objects readers parse once while the hold is open. */
  keep(sources: readonly SourceFile[]): SourceFile[];
  /** Frees every tree parsed for the hold; a source it kept parses as one no hold kept from then on. */
  release(): void;
}
