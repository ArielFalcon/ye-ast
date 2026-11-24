import { renderSourceContext } from "./presentation-context.ts";
import type { EvidenceSelection, EvidenceSelectionResult } from "./select-evidence.ts";

export type EvidencePage = { limit: number; offset: number; returned: number; total: number; nextCursor?: string };

export function renderEvidenceSelection(input: {
  select: EvidenceSelection;
  records: EvidenceSelectionResult;
  page?: EvidencePage;
}): string {
  const { select, records, page } = input;
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
