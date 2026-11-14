import type { Fact } from "../core/domain/shared/fact.ts";
import type { RenderContext, ResponseMode, ResponseRenderer } from "./presentation.ts";

/**
 * The most items of one kind a summary names one by one before it counts them and points to the mode that lists them. A
 * presentation bound of the driving adapter, never read by the core: it exceeds the largest importer answer of the
 * evaluation corpus (21 related files), so those answers are read in one call.
 */
export const LISTED_ITEMS = 25;

export interface AnswerBound { readonly bytes: number }
export type BoundedText =
  | { kind: "text"; text: string }
  | { kind: "refused"; bound: number; mode: ResponseMode; status: string; narrow: readonly string[] };

const narrowing: Record<RenderContext["tool"], readonly string[]> = {
  entrypoints: ["scope", "mode: summary"], impact: ["scope", "changed", "mode: summary"],
  callers: ["scope", "targets", "mode: summary"], importers: ["files", "mode: summary"],
  outline: ["files", "focus", "mode: summary"], trace: ["targets", "mode: summary"],
  workspace: ["scope", "mode: summary"], decisions: ["scope", "mode: summary"],
  contract_consequences: ["scope", "mode: summary"],
};

export function boundedText<V>(render: ResponseRenderer<V>, fact: Fact<V>, mode: ResponseMode, context: RenderContext, bound: AnswerBound | undefined): BoundedText {
  return boundedProjection((candidate) => render(fact, candidate, context), mode, fact.status, narrowing[context.tool], bound);
}

export function boundedProjection(render: (mode: ResponseMode) => string, mode: ResponseMode, status: string, narrow: readonly string[], bound: AnswerBound | undefined): BoundedText {
  const requested = render(mode);
  if (bound === undefined || Buffer.byteLength(requested) <= bound.bytes) return { kind: "text", text: requested };
  const note = `\nPresentation shortened from ${mode} to summary to fit ${bound.bytes} bytes; status ${status} is unchanged.`;
  const summary = render("summary") + note;
  if (Buffer.byteLength(summary) <= bound.bytes) return { kind: "text", text: summary };
  return { kind: "refused", bound: bound.bytes, mode, status, narrow };
}
