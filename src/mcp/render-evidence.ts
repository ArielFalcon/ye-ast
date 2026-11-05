import type { EvidenceSelection, EvidenceSelectionResult, SourceSummary } from "./select-evidence.ts";
import type { Recovery } from "./recovery.ts";
import type { ResponseMode } from "./presentation.ts";

export type EvidencePage = { limit: number; offset: number; returned: number; total: number; nextCursor?: string };

function renderSourceContext(source: SourceSummary): string[] {
  const context = (read: Pick<SourceSummary, "snapshot" | "inputs">) => ({ snapshot: read.snapshot, trust: read.inputs.trust, declaredScope: read.inputs.declaredScope, declaredConfig: read.inputs.declaredConfig });
  const root = context(source);
  const lines = [`Source context: ${JSON.stringify({ ...root, analysis: source.analysis })}`];
  if (source.reads.length > 0) {
    lines.push("Reads inherit source snapshot/trust/scope/config unless explicitly overridden:");
    for (const read of source.reads) {
      const own = context(read);
      const differences = Object.fromEntries(Object.entries(own).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(root[key as keyof typeof root])));
      lines.push(`  Read: ${JSON.stringify({ owner: read.owner, analysis: read.analysis, ...differences })}`);
    }
  }
  if (source.limits.length > 0) lines.push(`Source limits: ${JSON.stringify(source.limits)}`);
  lines.push("Provenance catalogs: structuredContent.source.");
  return lines;
}

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
