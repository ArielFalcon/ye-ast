import type { Hunk } from "./diff-reader.ts";
import type { SourceReading, Token } from "./source-tokens.ts";
import { importDeclarationMultiset, tokenTexts, tokensIn, tokensInImports, tokensOutsideImports } from "./token-lines.ts";

/** Why a hunk seeds nothing: the rule that set it aside, never the language (ADR-0043 decision 5). */
export type SettledReason = "no-token-change" | "import-order";

/** The outcome for one hunk when both of its sides are read. */
export type HunkOutcome = { settled: SettledReason } | { settled: undefined };

/**
 * Whether `hunk` changed no token, given both sides' readings of the same file (ADR-0043 decision 1). A side that is
 * `unread`, or a hunk with only one side, answers `{ settled: undefined }`: decision 4 keeps today's line rules there.
 */
export function settledOf(base: SourceReading, head: SourceReading, hunk: Hunk): HunkOutcome {
  if (base.status !== "read" || head.status !== "read" || hunk.base === undefined || hunk.head === undefined) return { settled: undefined };
  if (equalTexts(tokensIn(base, hunk.base), tokensIn(head, hunk.head))) return { settled: "no-token-change" };
  const importsLeave = base.importOrder === "insignificant" && head.importOrder === "insignificant" && same(importDeclarationMultiset(base), importDeclarationMultiset(head));
  const coversImports = tokensInImports(base, hunk.base).length > 0 || tokensInImports(head, hunk.head).length > 0;
  if (importsLeave && coversImports && equalTexts(tokensOutsideImports(base, hunk.base), tokensOutsideImports(head, hunk.head))) return { settled: "import-order" };
  return { settled: undefined };
}

function equalTexts(base: readonly Token[], head: readonly Token[]): boolean {
  return same(tokenTexts(base), tokenTexts(head));
}

function same(base: readonly string[], head: readonly string[]): boolean {
  return base.length === head.length && base.every((text, index) => text === head[index]);
}
