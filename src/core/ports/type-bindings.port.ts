import type { DeclaredBuildOutput } from "../domain/shared/build-outputs.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** The declaration a call's callee binds by type: one of the repository's, a package's, or the language's own libraries'. */
export type TypeTarget =
  | { kind: "repository"; file: string; line: number; name: string }
  | { kind: "external"; module: string; name: string }
  | { kind: "ambient"; name: string };

/** A call or `new` the checker bound; `line` and `column` are where the callee's name starts, 1-based. */
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

/** A call the checker leaves unbound is absent from `bindings`; its syntactic settlement answers (ADR-0037 decision 9). */
export interface TypeBindingsAnswer {
  bindings: readonly TypeBinding[];
  unowned: readonly UnownedSource[];
  /** Links under a declared directory that led out of it and of the repository, where they stand in the snapshot. */
  refused: readonly string[];
}

export interface TypeBindings {
  of(sources: readonly SourceFile[], outputs: readonly DeclaredBuildOutput[], signal?: AbortSignal): Promise<TypeBindingsAnswer>;
}
