import type { LineRange } from "./diff-reader.ts";
import type { Token, TokenReading } from "./source-tokens.ts";

/** The 1-based lines `reading` holds no token on, out of the `lineCount` lines of its content. */
export function triviaLinesOf(reading: TokenReading, lineCount: number): ReadonlySet<number> {
  const touched = new Set<number>();
  for (const token of reading.tokens) for (let line = token.start; line <= token.end; line += 1) touched.add(line);
  return new Set(Array.from({ length: lineCount }, (_, index) => index + 1).filter((line) => !touched.has(line)));
}

/** The tokens of `range`, a token that merely intersects it counted whole, in source order. */
export function tokensIn(reading: TokenReading, range: LineRange): readonly Token[] {
  return reading.tokens.filter((token) => token.start <= range.end && range.start <= token.end);
}

/** One entry per import declaration: its own tokens in source order, so members never move between declarations unnoticed. */
export function importDeclarationsOf(reading: TokenReading): readonly (readonly Token[])[] {
  return reading.imports.map((declaration) => reading.tokens.filter((token) => within(token, declaration)));
}

/** The declarations as sorted keys, each key its token sequence in order: an order-free multiset of whole declarations. */
export function importDeclarationMultiset(reading: TokenReading): readonly string[] {
  return importDeclarationsOf(reading).map((tokens) => tokenTexts(tokens).join("\u0000")).toSorted();
}

/** `tokensIn(reading, range)` restricted to the tokens inside an import declaration's syntactic span. */
export function tokensInImports(reading: TokenReading, range: LineRange): readonly Token[] {
  return tokensIn(reading, range).filter((token) => reading.imports.some((declaration) => within(token, declaration)));
}

/** The tokens of `range` outside every import declaration's syntactic span, in source order. */
export function tokensOutsideImports(reading: TokenReading, range: LineRange): readonly Token[] {
  return tokensIn(reading, range).filter((token) => !reading.imports.some((declaration) => within(token, declaration)));
}

/** `tokens`' spellings in source order: what a hunk comparison compares, because order is a token. */
export function tokenTexts(tokens: readonly Token[]): readonly string[] {
  return tokens.map(({ text }) => text);
}

function within(token: Token, declaration: { start: number; end: number }): boolean {
  return token.startOffset >= declaration.start && token.endOffset <= declaration.end;
}
