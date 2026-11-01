import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** A call that loads a module at run time: where it sits, and the module it names when its specifier is a literal. */
export interface DynamicLoad {
  /** Repo-relative path of the source that holds the call. */
  file: string;
  /** 1-based line of the call. */
  line: number;
  /** The specifier when it is a string literal, which names its module; absent when the load computes it. */
  specifier?: string;
}

/**
 * Reads the dynamic loads of the sources it is given, for the languages it knows. A file it cannot parse and a
 * language it has no reader for are absent from the answer, so the consumer keeps the cut it raised before.
 */
export interface DynamicLoadReader {
  extract(files: readonly SourceFile[]): Promise<readonly DynamicLoad[]>;
}
