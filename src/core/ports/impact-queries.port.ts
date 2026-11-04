import type { ImpactBudget, ImpactValue } from "../domain/impact/impact-fact.ts";
import type { ImportersValue } from "../domain/impact/importers-fact.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { Fact } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { LiveFault, LiveSelector } from "./live-queries.port.ts";
import type { VcsFault } from "./vcs.port.ts";

/** The head of a change: a revision, or `live` for the working tree. */
type AtHead = { head: string; live?: undefined } | ({ head?: undefined } & LiveSelector);
type AtRevision = { revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector);

export type ImpactOfChangeRequest = ImpactOfChangeBase & AtHead;

interface ImpactOfChangeBase {
  /** Path of the root of the git repository to read. */
  repo: string;
  /** Stable name of the repository in the snapshot of every fact; never a path. */
  repoId: string;
  /** The revision the change is read against: the change starts at its merge base with `head`. */
  base: string;
  /**
   * Globs over the changed paths: only the change's paths they select seed the walk. The repository is still read whole,
   * so callers outside the selection are known. Without it the whole change seeds.
   */
  changed?: readonly string[];
  scope?: ScopeRequest;
  /** Bounds on the walk; without one the walk runs to its end. */
  budget?: ImpactBudget;
  /** Aborting stops the work, removes every temporary directory and answers an `aborted` fault. */
  signal?: AbortSignal;
}

/** A declaration asked for by name, or the 1-based lines of a file, inclusive. */
export type CallersTarget = { file: string; symbol: string } | { file: string; start: number; end: number };

export type ImpactCallersRequest = ImpactCallersBase & AtRevision;

interface ImpactCallersBase {
  repo: string;
  /** Snapshot read location when it differs from the declared clone whose trust applies. */
  source?: string;
  repoId: string;
  targets: readonly CallersTarget[];
  scope?: ScopeRequest;
  budget?: ImpactBudget;
  signal?: AbortSignal;
}

export type ImpactImportersRequest = ImpactImportersBase & AtRevision;

interface ImpactImportersBase {
  repo: string;
  repoId: string;
  /** Repo-relative paths. */
  files: readonly string[];
  scope?: ScopeRequest;
  signal?: AbortSignal;
}

/** A requested symbol that names no node at the revision; `entries` lists every one that does not. */
export interface UnknownSymbolFault {
  kind: "unknown-symbol";
  detail: string;
  entries: readonly {
    file: string;
    symbol: string;
    /** The seedable declarations of the file, sorted and once each; empty when it declares none or is not indexed. */
    candidates: readonly string[];
  }[];
}

/** A `changed` glob that selected none of the paths the change touches; `globs` lists every one that did not. */
export interface UnknownChangePathFault {
  kind: "unknown-change-path";
  detail: string;
  /** The globs that selected no changed path, sorted and once each. */
  globs: readonly string[];
}

export type OfChangeFault = VcsFault | LiveFault | UnknownChangePathFault;
export type ImpactFault = OfChangeFault | UnknownSymbolFault;

export interface ImpactQueries {
  /**
   * What depends on the change from the merge base of `base` and `head` to `head`, read under `untrusted` from exports
   * of the commits, or with `live` to the working tree of a `trusted` repository (`live-requires-trusted` otherwise): the symbols that reach it, the entrypoints they serve and those the change adds, removes or
   * alters. `unknown` when the index cannot be built or the diff cannot be read; an unresolvable revision is a fault.
   */
  ofChange(request: ImpactOfChangeRequest): Promise<Result<Fact<ImpactValue>, OfChangeFault>>;
  /**
   * What depends on the requested symbols and line ranges at `revision`, walked and cut as `ofChange` does; the value
   * has no merge base and no changed entrypoints. A requested symbol that names no node is an `unknown-symbol` fault.
   */
  callers(request: ImpactCallersRequest): Promise<Result<Fact<ImpactValue>, ImpactFault>>;
  /**
   * Per requested file, the files that import it, use it and name it in a reference the index could not resolve. A
   * requested file outside the declared scope or that the index holds nothing of is a cut, never an empty entry.
   */
  importers(request: ImpactImportersRequest): Promise<Result<Fact<ImportersValue>, OfChangeFault>>;
}
