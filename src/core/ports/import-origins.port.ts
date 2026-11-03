import type { ImportOrigin } from "../domain/relations/resolved-reference.ts";
import type { Finding } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** One place a file uses a name, as the index reports it: repository-relative and 1-based. */
export interface ImportOriginSite {
  file: string;
  line: number;
  /** The identifier the name is rooted at: `a.b()` is rooted at `a`, and `this.svc.get` at `this`. */
  name: string;
}

/**
 * Where the names a file uses come from, read from the file's own imports. Declared by its consumer,
 * `core/application/impact`: a reference whose rooted name is imported from outside the repository cannot name the
 * declaration a cut attributes to it, so the cut is false and stops being emitted (`RFC-0016` gap A).
 *
 * It is a different proof from type resolution and needs no type root: it reads the specifiers the file already writes
 * and the module configuration the snapshot already carries.
 */
export interface ImportOrigins {
  /**
   * One entry per site, in the order received. `unknown` when no import of the file names it, when the specifier
   * resolves nowhere, or when the file declares that name itself: an import a local declaration may shadow proves
   * nothing, and a hidden dependence is worse than a false cut.
   */
  origins(sites: readonly ImportOriginSite[]): Promise<readonly Finding<ImportOrigin>[]>;
}

/** Reads the import bindings of one snapshot; composition supplies it, so no use case imports a parser. */
export type ImportOriginsReader = (sources: readonly SourceFile[]) => ImportOrigins;
