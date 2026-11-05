import type { EvidenceSelection, EvidenceSelectionResult } from "./select-evidence.ts";
import type { Recovery } from "./recovery.ts";

export type EvidencePage = { limit: number; offset: number; returned: number; total: number; nextCursor?: string };

export function renderEvidenceSelection(input: {
  select: EvidenceSelection;
  records: EvidenceSelectionResult;
  recovery: Recovery;
  page?: EvidencePage;
}): string {
  const { select, records, recovery, page } = input;
  const lines = [
    `Selection: ${JSON.stringify(select)}`,
    `Source analysis and provenance: ${JSON.stringify(records.source)}`,
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
