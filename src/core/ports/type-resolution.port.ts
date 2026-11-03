import type { ReferenceSite, ResolvedTarget } from "../domain/relations/resolved-reference.ts";
import type { Finding } from "../domain/shared/fact.ts";

/**
 * Settles the references a walk could not: which declaration a name refers to, or that it names a module outside the
 * repository. Synchronous because its consumer is (ADR-0018 decision 9): a walk that returns values cannot await, and
 * the bytes a Program needs are already materialized.
 */
export interface TypeResolution {
  /**
   * One entry per site, in the order received. A site it cannot settle is `unknown` with its reason, never absent.
   * A site names a declaration: a caller filters out the kinds that name a module specifier instead (`imports`), which
   * module resolution settles.
   */
  resolve(sites: readonly ReferenceSite[]): readonly Finding<ResolvedTarget>[];
}
