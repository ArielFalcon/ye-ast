/** Whether a language gives the order of its import declarations meaning (ADR-0043 decision 9). */
export type ImportOrder = "significant" | "insignificant";

/** One token of a source: its spelling, the 1-based lines it spans and the offsets it covers. */
export interface Token {
  start: number;
  end: number;
  /** The token's source text; a line-break token is `"\n"`. */
  text: string;
  /** The offsets into the source the token covers, so import membership never falls back to lines. */
  startOffset: number;
  endOffset: number;
}

/** An import declaration's syntactic span in the source, as offsets. */
export interface ImportDeclarationRange {
  start: number;
  end: number;
}

/** The token reading of one source, plain data a cache can retain (no tree, no node). */
export interface TokenReading {
  status: "read";
  /** The profile's language, so a retained reading is keyed by its pack and never re-read under another. */
  language: "typescript" | "java";
  /** Every token in source order: leaves except trivia, plus the comment tokens and line breaks decisions 2 keeps. */
  tokens: readonly Token[];
  /** The import declarations' syntactic spans, so code beside one on the same line stays outside it. */
  imports: readonly ImportDeclarationRange[];
  importOrder: ImportOrder;
}

/** What a source no pack tokenizes, or one that does not parse cleanly, answers (ADR-0043 decision 4). */
export interface UnreadTokens {
  status: "unread";
  /** `no-language`: no pack reads the path; `capability-absent`: its pack declares `tokens` absent; `unparsed`: its parse failed. */
  reason: "no-language" | "capability-absent" | "unparsed";
}

export type SourceReading = TokenReading | UnreadTokens;

/**
 * The line coordinates git hunks and requested ranges use: only LF starts a new line, so a parser's own line map (which
 * may also count a lone CR or U+2028) never moves a token off its hunk.
 */
export function lfLineIndex(content: string): (offset: number) => number {
  const starts = [0];
  for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) starts.push(at + 1);
  return (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}
