import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import type { SeedBasis } from "../change/seeds.ts";
import { compareText } from "../shared/code-node.ts";
import type { CompleteFact, Cut, FactBase, PartialFact, WalkBounds } from "../shared/fact.ts";
import type { ChangedEntrypoint } from "./changed-entrypoints.ts";

/** Optional bounds on the walk; none has a default, and each one that stops the walk becomes a cut. */
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
  symbols: readonly ImpactedSymbol[];
  entrypoints: readonly ReachedEntrypoint[];
  /** The symbols whose callers the walk followed; `0` when the answer needed no walk. */
  cost: { expansionsUsed: number };
}

const CUT_RANK: Record<Cut["kind"], number> = {
  depth: 0,
  hub: 1,
  "caller-budget": 2,
  "node-cap": 3,
  deadline: 4,
  "unresolved-link": 5,
  "no-extractor": 6,
  "not-exported": 7,
  section: 8,
};

/** Complete only when nothing cut the answer; otherwise partial with the cuts in kind order, each once. */
export function impactFact<T>(base: FactBase, value: T, cuts: readonly Cut[]): CompleteFact<T> | PartialFact<T> {
  const [first, ...rest] = [...new Map(cuts.map((cut) => [JSON.stringify(cut), cut])).values()].sort(
    (a, b) => CUT_RANK[a.kind] - CUT_RANK[b.kind] || compareText(a.at.join("\0"), b.at.join("\0")),
  );
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}
