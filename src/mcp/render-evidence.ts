import { renderSourceContext } from "./presentation-context.ts";
import { recoveryReference } from "./presentation-guidance.ts";
import type { EvidenceSelection, EvidenceSelectionResult } from "./select-evidence.ts";
import type { Recovery } from "./recovery.ts";
import type { ResponseMode } from "./presentation.ts";

export type EvidencePage = { limit: number; offset: number; returned: number; total: number; nextCursor?: string };

export function renderEvidenceSelection(input: {
  select: EvidenceSelection;
  records: EvidenceSelectionResult;
  recovery: Recovery;
  mode?: ResponseMode;
  page?: EvidencePage;
}): string {
  const { select, records, recovery, page } = input;
  if (input.mode === "full") {
    const lines = [
      `Selection: ${JSON.stringify(select)}`,
      ...renderSourceContext(records.source),
      `Availability: ${records.availability}`,
    ];
    if (records.availability === "unavailable") lines.push(`Reason: ${records.reason}`, "Inspect evidence in the result JSON for the unavailable result's evidence.");
    else lines.push("Inspect context, items and page in the result JSON for the selected projection.");
    if (page) lines.push(...pageLines(page));
    lines.push(recoveryReference(recovery));
    return lines.join("\n");
  }
  const lines = [
    `Selection: ${JSON.stringify(select)}`,
    ...renderSourceContext(records.source),
    `Availability: ${records.availability}`,
  ];
  if (records.availability === "unavailable") {
    lines.push(`Reason: ${records.reason}`, `Evidence: ${JSON.stringify(records.evidence)}`);
  } else {
    lines.push(`Context: ${JSON.stringify(records.context)}`);
    if (page) lines.push(...pageLines(page));
    lines.push(`Records: ${JSON.stringify(records.items)}`);
  }
  lines.push(recoveryReference(recovery));
  return lines.join("\n");
}

/**
 * A page and, only when more records remain, how to fetch the next one: the original recipe, the same select and limit,
 * the cursor and the identity. A page without a cursor is the last of this selection, not of the analysis.
 */
function pageLines(page: EvidencePage): string[] {
  return [
    `Page: ${JSON.stringify(page)}`,
    ...(page.nextCursor === undefined ? [] : ["Next page: recovery.query with the same select and page.limit, page.cursor set to nextCursor, and expect set to recovery.resultIdentity."]),
  ];
}
