import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import type { SeedBasis } from "../change/seeds.ts";
import type { SettledReason } from "../change/hunk-settling.ts";
import type { WalkBounds } from "../shared/fact.ts";
import type { Asserted } from "../shared/question.ts";
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

/**
 * Who established a dependence: ye-ast's own source proof (`proven`), the type checker over the declared build outputs
 * (`typed`, ADR-0037), the index, through a binding or a structure ye-ast
 * accepts (`resolved`), or the index by a name alone (`name-match`): a heuristic edge, or a call on a value receiver no
 * source proof binds to the callee's class (ADR-0029 decision 11). A name match may be no dependence at all.
 */
export type DependenceDerivation = "proven" | "typed" | "resolved" | "name-match";

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
   * The dependence that first reached the symbol: `lines` are the places inside this symbol's own file, or inside
   * `resource` when present (the template of a component), where it depends on `via`, in line order, and `basis` says
   * what that dependence is and `derivation` who established it. `substitutes` are the classes a provider may inject
   * instead of the receiver the call was proven on, each with the provider's site.
   */
  via?: { file: string; symbol: string; resource?: string; lines?: readonly number[]; basis: DependenceBasis; derivation?: DependenceDerivation; substitutes?: readonly ReceiverSubstitute[] };
}

export interface ReceiverSubstitute {
  file: string;
  symbol: string;
  line: number;
  at: { file: string; line: number };
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
  /**
   * The hunks that changed no token, each with why (ADR-0043 decisions 1 and 5): present when not empty, sorted by file
   * and by the hunk's first line. `basis: "hunk"` separates them from a settled requested range (`basis: "range"`).
   */
  settled?: readonly SettledChange[];
  symbols: readonly ImpactedSymbol[];
  entrypoints: readonly ReachedEntrypoint[];
  modules?: ModuleImpactValue;
  /** The symbols whose callers the walk followed; `0` when the answer needed no walk. */
  cost: { expansionsUsed: number };
}

/** A hunk a change set aside because no token of it changed (ADR-0043 decision 5). */
export interface SettledHunkChange {
  basis: "hunk";
  file: string;
  /** The hunk's base-side lines; absent where it only added lines. */
  base?: { start: number; end: number };
  /** The hunk's head-side lines; absent where it only removed lines. */
  head?: { start: number; end: number };
  reason: SettledReason;
}

/** One shape the field takes; a settled requested range is the other (ADR-0043 decision 3, U4). */
export type SettledChange = SettledHunkChange;

export { withCuts as impactFact } from "../shared/question.ts";

/** What an impact answer asserts: a walk over the asked files and every file its value reached (ADR-0042 decision 3). */
export function impactWalk(asked: readonly string[], value: ImpactValue): Asserted {
  const files = new Set(asked);
  for (const seed of value.seeds) files.add(seed.file);
  for (const { file, via } of value.symbols) for (const reached of [file, via?.file, via?.resource]) if (reached !== undefined) files.add(reached);
  for (const { handler } of value.entrypoints) files.add(handler.path);
  for (const { file } of value.modules?.origins ?? []) files.add(file);
  for (const { file, via } of value.modules?.modules ?? []) for (const reached of [file, via?.file]) if (reached !== undefined) files.add(reached);
  return { kind: "walk", files: [...files] };
}
