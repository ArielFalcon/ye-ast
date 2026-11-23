import type { SourceFile } from "./source-file.port.ts";

/** What a view of derived facts did since its previous drain; `diskHits` are the `hits` the disk tier answered, `factBytes` and `retainedBytes` are what the cache holds now. */
export interface DerivedFactsTally {
  hits: number;
  misses: number;
  diskHits: number;
  admitted: number;
  admittedBytes: number;
  evicted: number;
  skipped: number;
  factBytes: number;
  retainedBytes: number;
}

/** What the questions of `DerivedFacts.ofReads` are asked of: one immutable set of answers. */
export interface RecordedAnswers {
  /** Equal for two sets of answers only when every question gets the same answer from both. */
  readonly fingerprint: string;
  answerIfKnown(question: string): string | undefined;
  /** What a kept derivation remembers of these answers, to ask `changedSince` of later ones (ADR-0145). */
  readonly version?: object;
  /** Whether a question may answer here otherwise than in the answers `earlier` is the version of; `undefined` when it cannot tell. */
  changedSince?(earlier: object): ((question: string) => boolean) | undefined;
}

/**
 * What a kept entry's key grows with: `content`, the snapshot read (its files, its index, a stage over them); `request`,
 * what one request asked of that content (a whole request, or the places of a file it asked about), so distinct requests
 * at one content add entries without bound. A `request` entry is not counted in the working-set floor (ADR-0147).
 */
export type KeyedBy = "content" | "request";

/**
 * Plain data a reader derives from its inputs alone, kept between requests by the content of those inputs (ADR-0035).
 * A value is kept only once its derivation completed; a hit and a miss answer the same JSON value. Never a syntax tree,
 * a node or any object that holds one.
 */
export interface DerivedFacts {
  /** What `derive` answers from the path and the content of `file` alone. */
  ofFile<T>(slot: string, file: SourceFile, derive: () => T): T;
  /** What `derive` answers from `inputs` alone; `inputs` names every input the value depends on. */
  ofInputs<T>(slot: string, inputs: object, derive: () => Promise<T>, keyedBy?: KeyedBy): Promise<T>;
  /**
   * What `derive` answers from `subject` and from the answers to the questions it records through `record`, in order; kept
   * until one of those answers differs. `answers` answers a question of the current snapshot, so a kept value is
   * reused when the same questions give the same answers; a question it cannot answer (`undefined`) is a difference.
   * A kept value last verified against answers with the same `fingerprint` is reused without asking (ADR-0128); against
   * other answers, it asks only the questions `changedSince` tells changed (ADR-0145).
   * A derivation that throws is kept for nobody.
   */
  ofReads<T>(slot: string, subject: object, answers: RecordedAnswers, derive: (record: (question: string, answer: string) => void) => Promise<T>, keyedBy?: KeyedBy): Promise<T>;
  /** A short name of `inputs`, equal for equal inputs, to name a large input in many `ofInputs` calls. */
  fingerprint(inputs: object): string;
  drain(): DerivedFactsTally;
}
