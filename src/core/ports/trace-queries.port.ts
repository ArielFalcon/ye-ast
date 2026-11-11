import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";
import type { Entrypoint } from "../domain/entrypoints/entrypoint.ts";
import type { Fact, WalkBounds } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { TraceValue } from "../domain/trace/trace-fact.ts";
import type { CallersTarget, UnknownSymbolFault } from "./impact-queries.port.ts";
import type { LiveSelector } from "./live-queries.port.ts";

/** The walk bounds a trace takes: the hub bound counts callers and has no outbound meaning. */
export const TRACE_BOUND_FIELDS = ["depth", "expansions"] as const;

/** Bounds on the walk; without one the walk runs to its end. */
export type TraceBudget = Pick<WalkBounds, (typeof TRACE_BOUND_FIELDS)[number]>;

/** Every kind of entrypoint the map reads, in the map's own spelling. */
export const ENTRYPOINT_KINDS = ["http-route", "ui-route", "listener", "job", "callback"] as const satisfies readonly Entrypoint["kind"][];

/** An entrypoint of the map, by its kind and its name as the map spells it (`POST /orders`, `/orders/:id`). */
export interface EntrypointTarget {
  kind: Entrypoint["kind"];
  name: string;
}

/** A declaration, a line range, or an entrypoint of the map at the same snapshot. */
export type TraceTarget = CallersTarget | EntrypointTarget;

/** A trace starts from declarations or from entrypoints, never both: a request that mixes them is refused before any work. */
export function mixesTargetKinds(targets: readonly TraceTarget[]): boolean {
  return new Set(targets.map((target) => "kind" in target)).size > 1;
}

/** No entrypoint of the map has a requested kind and name; each entry lists the names the map holds of that kind. */
export interface UnknownEntrypointFault {
  kind: "unknown-entrypoint";
  detail: string;
  entries: readonly (EntrypointTarget & { candidates: readonly string[] })[];
}

interface TraceBase {
  /** Omitted reads only this repository; {} uses eligible workspace defaults. */
  workspace?: Pick<WorkspaceRequest, "repos" | "gateways">;
  offline?: boolean;
  /** Internal committed source selected by workspace snapshot preparation. */
  source?: string;
  /** Path of the root of a git repository to read. */
  repo: string;
  /** Stable name of the repository in the snapshot of every fact; never a path. */
  repoId: string;
  targets: readonly TraceTarget[];
  budget?: TraceBudget;
  scope?: ScopeRequest;
  /** Aborting stops the work, removes every temporary directory and answers an `aborted` fault. */
  signal?: AbortSignal;
}

export type TraceRequest = TraceBase & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

export type TraceFault = WorkspaceFault | UnknownSymbolFault | UnknownEntrypointFault;

export interface TraceQueries {
  /**
   * What the requested declarations execute, in the order their bodies call it: every declaration a target selects is a
   * root, each declaration is expanded once, and a call no rule settles is an `unresolved-link` cut with its candidates.
   * An entrypoint target roots at the handler of every entrypoint of the map with its kind and name, a UI route at its
   * component. A target outside the declared scope is `unknown`; a symbol that names no declaration an `unknown-symbol`
   * fault; an entrypoint the map does not hold an `unknown-entrypoint` fault.
   */
  walk(request: TraceRequest): Promise<Result<Fact<TraceValue>, TraceFault>>;
}
