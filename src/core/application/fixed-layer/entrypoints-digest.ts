import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { EntrypointMapFact } from "../../domain/map/entrypoint-map.ts";
import type { Cut, Evidence, Fact, SnapshotRef } from "../../domain/shared/fact.ts";

/** The Markdown an agent reads before the JSON: what the fact is about, how complete it is, and where each entrypoint is. */
export function renderEntrypointsDigest(fact: EntrypointMapFact): string {
  const section = fact.value.entrypoints;
  const sectionCuts = section.status === "partial" ? section.cuts : [];
  const cuts = [...(fact.status === "partial" ? fact.cuts : []), ...sectionCuts];
  const { declaredScope } = fact.inputs;
  const lines = [
    "# Entrypoints",
    "",
    "Derived by ye-ast from the code and git. The complete fact is in `entrypoints.json`.",
    "",
    `- Snapshot: ${snapshot(fact.snapshot)}`,
    `- Producer: ${fact.producer.name} ${fact.producer.version}`,
    `- Schema: ${fact.schema}`,
    `- Trust: ${fact.inputs.trust}`,
    `- Declared scope: languages ${list(declaredScope.languages)}; frameworks ${list(declaredScope.frameworks)}; include ${list(declaredScope.include)}; exclude ${list(declaredScope.exclude)}`,
    `- Completeness: ${fact.status}`,
    "",
    "## Cuts",
    "",
    ...(cuts.length === 0 ? ["None: complete within the declared scope."] : cuts.map(cutLine)),
    "",
    "## Entrypoints",
    "",
    ...(section.status === "unknown" ? [`Unknown: ${section.reason}.`] : entrypointLines(section.value)),
  ];
  return `${lines.join("\n")}\n`;
}

function snapshot(ref: SnapshotRef): string {
  return ref.kind === "sha" ? `${ref.repo} at \`${ref.sha}\`` : `${ref.repo} live at \`${ref.head}\` (state \`${ref.stateId}\`)`;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function cutLine(cut: Cut): string {
  const [anchor, ...places] = cut.at;
  const limit = cut.limit === undefined ? "" : ` (limit ${cut.limit})`;
  return [`- \`${cut.kind}\` at \`${anchor ?? ""}\`${limit}`, ...places.map((place) => `  - \`${place}\``)].join("\n");
}

function entrypointLines(items: readonly Fact<Entrypoint>[]): string[] {
  if (items.length === 0) return ["None found within the declared scope."];
  return items.map((item) => `- ${label(item)} at ${locations(item.evidence)}`);
}

function label(item: Fact<Entrypoint>): string {
  return item.status === "unknown" ? `unknown (${item.reason})` : `\`${item.value.kind} ${item.value.name}\``;
}

function locations(evidence: readonly Evidence[]): string {
  return evidence.length === 0 ? "no location" : evidence.map((entry) => `\`${entry.path}:${entry.line}\``).join(", ");
}
