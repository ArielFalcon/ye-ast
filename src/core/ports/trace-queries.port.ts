import type { Fact, WalkBounds } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { TraceValue } from "../domain/trace/trace-fact.ts";
import type { CallersTarget, UnknownSymbolFault } from "./impact-queries.port.ts";
import type { LiveFault, LiveSelector } from "./live-queries.port.ts";
import type { VcsFault } from "./vcs.port.ts";

/** Bounds on the walk; the hub bound counts callers and has no outbound meaning. Without one the walk runs to its end. */
export type TraceBudget = Pick<WalkBounds, "depth" | "expansions">;

interface TraceBase {
  /** Path of the root of a git repository to read. */
  repo: string;
  /** Stable name of the repository in the snapshot of every fact; never a path. */
  repoId: string;
  targets: readonly CallersTarget[];
  budget?: TraceBudget;
  scope?: ScopeRequest;
  /** Aborting stops the work, removes every temporary directory and answers an `aborted` fault. */
  signal?: AbortSignal;
}

export type TraceRequest = TraceBase & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

export type TraceFault = VcsFault | LiveFault | UnknownSymbolFault;

export interface TraceQueries {
  /**
   * What the requested declarations execute, in the order their bodies call it: every declaration a target selects is a
   * root, each declaration is expanded once, and a call no rule settles is an `unresolved-link` cut with its candidates.
   * A target outside the declared scope is `unknown`; a symbol that names no declaration an `unknown-symbol` fault.
   */
  walk(request: TraceRequest): Promise<Result<Fact<TraceValue>, TraceFault>>;
}
