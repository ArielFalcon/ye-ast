import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** What a view of derived facts did since its previous drain; `factBytes` and `retainedBytes` are what the cache holds now. */
export interface DerivedFactsTally {
  hits: number;
  misses: number;
  admitted: number;
  admittedBytes: number;
  evicted: number;
  skipped: number;
  factBytes: number;
  retainedBytes: number;
}

/**
 * Plain data a reader derives from its inputs alone, kept between requests by the content of those inputs (ADR-0035).
 * A value is kept only once its derivation completed; a hit and a miss answer the same JSON value. Never a syntax tree,
 * a node or any object that holds one.
 */
export interface DerivedFacts {
  /** What `derive` answers from the path and the content of `file` alone. */
  ofFile<T>(slot: string, file: SourceFile, derive: () => T): T;
  /** What `derive` answers from `inputs` alone; `inputs` names every input the value depends on. */
  ofInputs<T>(slot: string, inputs: object, derive: () => Promise<T>): Promise<T>;
  /** A short name of `inputs`, equal for equal inputs, to name a large input in many `ofInputs` calls. */
  fingerprint(inputs: object): string;
  drain(): DerivedFactsTally;
}
