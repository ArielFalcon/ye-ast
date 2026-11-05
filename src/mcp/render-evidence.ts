import { renderSourceContext } from "./presentation-context.ts";
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
      records.availability === "available"
        ? "Inspect structuredContent.source for provenance and structuredContent.context, items and page for the complete selected projection."
        : "Inspect structuredContent.source for provenance.",
    ];
    if (records.availability === "unavailable") lines.push(`Reason: ${records.reason}`, "Inspect structuredContent.evidence for the unavailable result's evidence.");
    if (page) lines.push(`Page: ${JSON.stringify(page)}`);
    lines.push(`Recovery: ${JSON.stringify(recovery)}`);
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
    if (page) lines.push(`Page: ${JSON.stringify(page)}`);
    lines.push(`Records: ${JSON.stringify(records.items)}`);
  }
  lines.push(`Recovery: ${JSON.stringify(recovery)}`);
  return lines.join("\n");
}
