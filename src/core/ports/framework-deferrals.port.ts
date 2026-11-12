import type { SourceSpan } from "../domain/shared/owning-body.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";
import type { CellFactory } from "./framework-cells.port.ts";

/** The closed vocabulary of one library's combinators that run a function value they are given later, if at all. */
export interface FrameworkDeferrals {
  /** The index of the argument whose function the export runs later; undefined for an export the vocabulary does not list. */
  runOf(factory: CellFactory): { readonly argument: number } | undefined;
}

/** The function values of a file that a listed combinator takes, each whole. */
export interface DeferredValues {
  of(file: string): Promise<readonly SourceSpan[]>;
}

/** Reads, over the sources of one snapshot, the function values the vocabularies list. */
export type DeferredValueReader = (sources: readonly SourceFile[]) => DeferredValues;
