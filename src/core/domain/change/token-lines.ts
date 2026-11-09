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

/** Every token whose lines an import declaration covers, in source order. */
export function importTokensOf(reading: TokenReading): readonly Token[] {
  return reading.tokens.filter((token) => reading.imports.some((range) => intersects(token, range)));
}

/** `tokensIn(reading, range)` restricted to the import declarations' lines, in source order. */
export function tokensInImports(reading: TokenReading, range: LineRange): readonly Token[] {
  return tokensIn(reading, range).filter((token) => reading.imports.some((imported) => intersects(token, imported)));
}

/** The tokens of `range` whose lines no import declaration covers, in source order. */
export function tokensOutsideImports(reading: TokenReading, range: LineRange): readonly Token[] {
  return tokensIn(reading, range).filter((token) => !reading.imports.some((imported) => intersects(token, imported)));
}

/** `tokens`' spellings, sorted, so two sets of import tokens compare equal regardless of order. */
export function tokenMultiset(tokens: readonly Token[]): readonly string[] {
  return tokens.map(({ text }) => text).toSorted();
}

/** `tokens`' spellings in source order: what a hunk comparison compares, because order is a token. */
export function tokenTexts(tokens: readonly Token[]): readonly string[] {
  return tokens.map(({ text }) => text);
}

function intersects(token: Token, range: LineRange): boolean {
  return token.start <= range.end && range.start <= token.end;
}
