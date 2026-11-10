import type { LibrarySource } from "../domain/topology/library-source.ts";
import type { Entrypoint } from "../domain/entrypoints/entrypoint.ts";
import type { Cut, Finding } from "../domain/shared/fact.ts";

export interface SourceFile {
  path: string;
  content: string;
}

export interface EntrypointExtraction {
  findings: readonly Finding<Entrypoint>[];
  /**
   * The places where the reading stopped: a reference the sources do not let the reader cross. A cut is never an item; the
   * map carries it as a cut of its section. Empty when the reading stopped nowhere.
   */
  readingCuts: readonly Cut[];
}

export interface EntrypointExtractor {
  /**
   * Reads the entrypoints the in-scope sources declare: HTTP routes, UI routes, listeners and jobs. An entrypoint is a `complete`
   * finding; a construct the sources name but cannot resolve is an `unknown` finding with its location. Findings are
   * sorted by evidence location, then by kind and name, so the same sources give the same output.
   * `libraries` are the sources of repositories the files depend on: a listener the files inherit from a class they
   * declare is read, and no entrypoint is reported from the libraries themselves.
   */
  extract(files: readonly SourceFile[], libraries?: readonly LibrarySource[]): Promise<EntrypointExtraction>;
}
