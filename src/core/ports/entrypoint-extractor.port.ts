import type { Entrypoint } from "../domain/entrypoints/entrypoint.ts";
import type { Finding } from "../domain/shared/fact.ts";

export interface SourceFile {
  path: string;
  content: string;
}

export interface EntrypointExtractor {
  /**
   * Reads the entrypoints the in-scope sources declare: HTTP routes, UI routes, listeners and jobs. An entrypoint is a `complete`
   * finding; a construct the sources name but cannot resolve is an `unknown` finding with its location. Findings are
   * sorted by evidence location, then by kind and name, so the same sources give the same output.
   */
  extract(files: readonly SourceFile[]): Promise<readonly Finding<Entrypoint>[]>;
}
