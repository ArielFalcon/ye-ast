import type { DeclaredBuildOutput, StaleInstall } from "../domain/shared/build-outputs.ts";
import type { BuildOutputInput } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** The declaration a call's callee binds by type: one of the repository's (`line` is where its name stands), a package's, or the language's own libraries'. */
export type TypeTarget =
  | { kind: "repository"; file: string; line: number; name: string }
  | { kind: "external"; module: string; name: string }
  | { kind: "ambient"; name: string };

/**
 * A call or `new` the checker bound; `line` and `column` are where the call starts, 1-based, as the index places its
 * edges. Calls of a chain start at one place and are told apart by `name`; two of one name there are ambiguous.
 */
export interface TypeBinding {
  file: string;
  line: number;
  column: number;
  name: string;
  target: TypeTarget;
}

/** A source no configuration owns (`configurations` names the nearest one, if any), or that two own. */
export interface UnownedSource {
  file: string;
  configurations: readonly string[];
}

/** A declaration the snapshot's lockfile contradicts (ADR-0037 decision 5), with each package it states otherwise. */
export interface UnusedOutput {
  kind: DeclaredBuildOutput["kind"];
  at: string;
  stale: readonly StaleInstall[];
}

/**
 * `bound`: a call the checker leaves unbound is absent from `bindings`, and its syntactic settlement answers (ADR-0037
 * decision 9). `unused`: some declaration does not match the snapshot, so none is used and every call settles as before.
 */
export type TypeBindingsAnswer =
  | {
      status: "bound";
      bindings: readonly TypeBinding[];
      unowned: readonly UnownedSource[];
      /** Links under a declared directory that led out of it and of the repository, where they stand in the snapshot. */
      refused: readonly string[];
      /** Every declaration, used; a snapshot without a lockfile leaves it unverified. */
      outputs: readonly BuildOutputInput[];
    }
  | { status: "unused"; outputs: readonly UnusedOutput[] };

export interface TypeBindings {
  of(sources: readonly SourceFile[], outputs: readonly DeclaredBuildOutput[], signal?: AbortSignal): Promise<TypeBindingsAnswer>;
}
