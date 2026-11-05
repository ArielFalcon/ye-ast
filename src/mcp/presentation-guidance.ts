import { validRecoveryControls } from "./evidence-schema.ts";
import type { EvidenceSelection } from "./select-evidence.ts";
import type { Recovery } from "./recovery.ts";

/** Families decide category membership and what each mode can recover. */
export function categoryRecovery(input: { details?: string; full?: string }): string {
  return [
    ...(input.details === undefined ? [] : [`mode "details" ${input.details}`]),
    ...(input.full === undefined ? [] : [`mode: "full" ${input.full}`]),
  ].join("; ");
}

export function recoveryReference(recovery: Recovery): string {
  return recovery.status === "available"
    ? "Recovery recipe and resultIdentity: structuredContent.recovery."
    : `Recovery unavailable (${recovery.reason}); see structuredContent.recovery.`;
}

/** A literal public selector; never abbreviate or infer its owner or coordinates. */
export function literalSelection(selection: EvidenceSelection): string {
  return JSON.stringify(selection);
}

/** Consult the schema authority with the actual response context, never a parallel capability map. */
export function canSelect(context: import("./presentation.ts").RenderContext, selection: EvidenceSelection, workspace: boolean): boolean {
  if (context.recovery?.status === "unavailable") return false;
  const tool = context.tool;
  if (tool !== "entrypoints" && tool !== "callers" && tool !== "impact") return false;
  return validRecoveryControls(tool, {select: selection, page: {limit: 1}, ...(workspace ? {workspace: {}} : {})});
}
