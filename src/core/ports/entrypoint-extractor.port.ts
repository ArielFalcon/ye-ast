import type { LibrarySource } from "../domain/topology/library-source.ts";
import type { Entrypoint } from "../domain/entrypoints/entrypoint.ts";
import type { Cut, Finding } from "../domain/shared/fact.ts";
import type { DerivedFacts } from "./derived-facts.port.ts";
import type { ParseHold } from "./parse-holds.port.ts";
import type { SourceFile } from "./source-file.port.ts";

export type { SourceFile };

export interface EntrypointExtraction {
  findings: readonly Finding<Entrypoint>[];
  /**
   * The places where the reading stopped: a reference the sources do not let the reader cross. A cut is never an item; the
   * map carries it as a cut of its section. Empty when the reading stopped nowhere.
   */
  readingCuts: readonly Cut[];
}

/** What the snapshot read the sources belong to holds for the extractor: the parse hold that owns their trees and the facts it keeps by content. */
export interface EntrypointReading {
  hold?: ParseHold;
  facts?: DerivedFacts;
}

export interface EntrypointExtractor {
  /**
   * Reads the entrypoints the in-scope sources declare: HTTP routes, UI routes, listeners, jobs and callbacks. An entrypoint is a `complete`
   * finding; a construct the sources name but cannot resolve is an `unknown` finding with its location. Findings are
   * sorted by evidence location, then by kind and name, so the same sources give the same output.
   * `libraries` are the sources of repositories the files depend on: a listener the files inherit from a class they
   * declare is read, and no entrypoint is reported from the libraries themselves. `reading` is the snapshot read the
   * `files` are the hold's own copies of: the extractor reads over the trees the hold parsed once and may keep what it
   * derives by what it read; the findings are the same with or without it.
   */
  extract(files: readonly SourceFile[], libraries?: readonly LibrarySource[], reading?: EntrypointReading): Promise<EntrypointExtraction>;
}
