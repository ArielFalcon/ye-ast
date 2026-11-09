import type { SourceReading } from "../domain/change/source-tokens.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

/** Reads, with a language's own tokenizer, the B11 tokens of one source and the facts the change rules derive from them. */
export interface SourceTokens {
  tokensOf(file: SourceFile): Promise<SourceReading>;
}
