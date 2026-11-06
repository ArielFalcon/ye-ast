import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** Reads, with a language's own tokenizer, which lines of a source hold nothing but whitespace and comments. */
export interface SourceTrivia {
  /** 1-based lines; a file of a language the reader does not tokenize, or one that does not parse, has none. */
  triviaLines(file: SourceFile): Promise<ReadonlySet<number>>;
}
