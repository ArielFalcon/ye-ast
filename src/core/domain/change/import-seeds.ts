import type { FileChange, LineRange, Removal } from "./diff-reader.ts";
import type { TokenReading } from "./source-tokens.ts";
import { importDeclarationsOf, tokenTexts, tokensIn } from "./token-lines.ts";

/** What the tokens stage read of a changed file: the head always, the base when it exists and parses. */
export interface FileTokens {
  base?: TokenReading;
  head: TokenReading;
}

/** The parts of a change that only move import declarations (ADR-0097). */
export interface ImportHunks {
  /** The head lines of the hunks made of import declarations on every side they have. */
  heads: LineRange[];
  removals: ReadonlySet<Removal>;
}

export function importHunksOf(change: FileChange, tokens: FileTokens): ImportHunks {
  const holds = (reading: TokenReading | undefined, range: LineRange | undefined): boolean => range === undefined || (reading !== undefined && holdsOnlyImports(reading, range));
  return {
    heads: change.hunks.filter((hunk) => holds(tokens.head, hunk.head) && holds(tokens.base, hunk.base)).flatMap((hunk) => hunk.head ?? []),
    removals: new Set(change.removals.filter((removal) => removal.base !== undefined && holds(tokens.base, removal.base))),
  };
}

/**
 * The names the file's imports bind differently at the head than at the base: each name whose set of sources is not the
 * same on both sides. Without a base, the names the head's declarations on `heads` bind. `undefined` when the name rule
 * cannot bound the change: a declaration that binds no listable name is added or removed, no name changed, or the order
 * of imports that carries meaning moved.
 */
export function reboundNames(tokens: FileTokens, heads: readonly LineRange[]): ReadonlySet<string> | undefined {
  const { base, head } = tokens;
  return base === undefined ? namesOnLines(head, heads) : namesRebound(base, head);
}

/** Whether any token of `reading` inside `ranges` is spelled as one of `names`. */
export function writesAny(reading: TokenReading, ranges: readonly LineRange[], names: ReadonlySet<string>): boolean {
  return reading.tokens.some((token) => names.has(token.text) && ranges.some((range) => token.start <= range.end && range.start <= token.end));
}

/** Whether a token spelled as one of `names` stands outside every import declaration and every one of `spans`. */
export function writesOutside(reading: TokenReading, spans: readonly LineRange[], names: ReadonlySet<string>): boolean {
  return reading.tokens.some((token) => names.has(token.text) && !inImports(reading, token) && !spans.some((span) => token.start <= span.end && span.start <= token.end));
}

/** Whether the lines of `range` hold a token and every token they hold lies inside an import declaration. */
function holdsOnlyImports(reading: TokenReading, range: LineRange): boolean {
  const code = tokensIn(reading, range).filter(({ text }) => text !== "\n");
  return code.length > 0 && code.every((token) => inImports(reading, token));
}

function inImports(reading: TokenReading, token: { startOffset: number; endOffset: number }): boolean {
  return reading.imports.some((declaration) => token.startOffset >= declaration.start && token.endOffset <= declaration.end);
}

function namesOnLines(head: TokenReading, ranges: readonly LineRange[]): Set<string> | undefined {
  const names = new Set<string>();
  const tokens = importDeclarationsOf(head);
  for (const [index, declaration] of head.imports.entries()) {
    const own = tokens[index]!;
    if (own.length === 0 || !ranges.some((range) => own[0]!.start <= range.end && range.start <= own.at(-1)!.end)) continue;
    if (declaration.binds === undefined) return undefined;
    for (const { name } of declaration.binds) names.add(name);
  }
  return names;
}

function namesRebound(base: TokenReading, head: TokenReading): Set<string> | undefined {
  const keys = { base: keysOf(base), head: keysOf(head) };
  if (!sameSequence(sortedOpen(base), sortedOpen(head))) return undefined;
  if (head.importOrder === "significant") {
    const common = new Set(keys.base.filter((key) => keys.head.includes(key)));
    if (!sameSequence(keys.base.filter((key) => common.has(key)), keys.head.filter((key) => common.has(key)))) return undefined;
  }
  const before = sourcesByName(base);
  const after = sourcesByName(head);
  return new Set([...before.keys(), ...after.keys()].filter((name) => before.get(name) !== after.get(name)));
}

/** One key per import declaration, in source order: its tokens. */
function keysOf(reading: TokenReading): string[] {
  return importDeclarationsOf(reading).map((tokens) => tokenTexts(tokens).join("\u0000"));
}

function sortedOpen(reading: TokenReading): string[] {
  const keys = keysOf(reading);
  return reading.imports.flatMap((declaration, index) => (declaration.binds === undefined ? [keys[index]!] : [])).toSorted();
}

function sourcesByName(reading: TokenReading): Map<string, string> {
  const sources = new Map<string, string[]>();
  for (const { binds = [] } of reading.imports) for (const { name, source } of binds) sources.set(name, [...(sources.get(name) ?? []), source]);
  return new Map([...sources].map(([name, found]) => [name, found.toSorted().join("\u0000")]));
}

function sameSequence(base: readonly string[], head: readonly string[]): boolean {
  return base.length === head.length && base.every((key, index) => key === head[index]);
}
