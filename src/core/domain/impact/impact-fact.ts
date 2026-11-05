import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import type { SeedBasis } from "../change/seeds.ts";
import type { WalkBounds } from "../shared/fact.ts";
import type { ChangedContract } from "./changed-contracts.ts";
import type { ChangedEntrypoint } from "./changed-entrypoints.ts";
import type { ModuleImpactValue } from "./module-dependency.ts";

/** Bounds apply independently to symbol and module walks, each with its own expansion cost. */
export type ImpactBudget = WalkBounds;

/**
 * What a dependence the walk followed is: a call or an instantiation, a use that only names the symbol, or one of the
 * structural dependences (containment, dispatch, a declared relation, an import).
 */
export type DependenceBasis = "call" | "reference" | "contains" | "dispatch" | "relation" | "import";

export interface Seed {
  file: string;
  symbol: string;
  /** The declaration's first line. */
  line: number;
  /** The declaration's last line; absent when the declaration spans one line. */
  endLine?: number;
  basis: SeedBasis;
}

export interface ImpactedSymbol {
  file: string;
  symbol: string;
  kind: string;
  line: number;
  /** The declaration's last line; absent when the declaration spans one line. */
  endLine?: number;
  depth: number;
  confidence: number;
  /** The callers that call or instantiate the symbol, whether or not the walk followed them; the hub bound counts the same. */
  fanIn: number;
  /**
   * The dependence that first reached the symbol: `lines` are the places inside this symbol's own file where it depends
   * on `via`, in line order, and `basis` says what that dependence is.
   */
  via?: { file: string; symbol: string; lines?: readonly number[]; basis: DependenceBasis };
}

export interface ReachedEntrypoint {
  /** `unknown` for a reached declaration the extractor reported as an entrypoint it could not read whole; then `name` is absent. */
  kind: Entrypoint["kind"] | "unknown";
  name?: string;
  handler: Handler;
  depth: number;
  confidence: number;
  seeds: readonly number[];
}

export interface ImpactValue {
  /** Present only when the seeds come from a change; `impact.callers` has no merge base. */
  mergeBase?: string;
  seeds: readonly Seed[];
  /** Present only when the seeds come from a change. */
  changedEntrypoints?: readonly ChangedEntrypoint[];
  /** Present only when the change added, removed or altered an operation a contract declares. */
  changedContracts?: readonly ChangedContract[];
  symbols: readonly ImpactedSymbol[];
  entrypoints: readonly ReachedEntrypoint[];
  modules?: ModuleImpactValue;
  /** The symbols whose callers the walk followed; `0` when the answer needed no walk. */
  cost: { expansionsUsed: number };
}

export { withCuts as impactFact } from "../shared/fact.ts";
