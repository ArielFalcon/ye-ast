import type { BasePath } from "../../../core/domain/entrypoints/http-route.ts";
import type { EntrypointMap } from "../../../core/domain/map/entrypoint-map.ts";
import { canonicalJson } from "../../../core/domain/shared/canonical-json.ts";
import type { Fact, Finding } from "../../../core/domain/shared/fact.ts";
import { renderFactNarrowing, renderFactStatus, undecidedOf } from "../../presentation-context.ts";
import type { Entrypoint } from "../../../core/domain/entrypoints/entrypoint.ts";
import type { Place, Presentation, Qualifier, Row, Section } from "../model.ts";
import { cutSection, entrypointRow, evidencePlace } from "../rows.ts";

/** The `answer.json` members the sections of this family come from. */
export const ENTRYPOINTS_SECTION = "value.entrypoints.value";
export const BASE_PATHS_SECTION = "value.entrypoints.value[].value.basePath";

type BaseFinding = Finding<BasePath>;

const baseOf = (finding: Finding<Entrypoint>): BaseFinding | undefined =>
  finding.status === "complete" && finding.value.kind === "http-route" ? finding.value.basePath : undefined;

function baseRow(base: BaseFinding, routes: number): Row {
  const evidence: Place[] = base.evidence.map(evidencePlace);
  const qualifiers: Qualifier[] = [{ name: "routes", value: String(routes) }];
  const key = ["base-path", canonicalJson(base)].join("\0");
  if (base.status === "unknown") return { key, label: `base path unknown (${base.reason})`, qualifiers, ...(evidence.length === 0 ? {} : { evidence }) };
  const profiles = Object.keys(base.value.profiles).length;
  return {
    key,
    label: `base path defaults ${JSON.stringify(base.value.default)}`,
    qualifiers: [...qualifiers, ...(profiles === 0 ? [] : [{ name: `${profiles} profile-specific settings` }])],
    ...(evidence.length === 0 ? {} : { evidence }),
  };
}

/** Each distinct base path once, with the routes that share it; a route points at its base by the base's row number. */
function basePaths(findings: readonly Finding<Entrypoint>[]): { section: Section; positions: ReadonlyMap<string, number> } {
  const bases = findings.flatMap((finding) => baseOf(finding) ?? []);
  const groups = [...Map.groupBy(bases, canonicalJson)];
  const positions = new Map(groups.map(([key], position) => [key, position] as const));
  return {
    section: { id: BASE_PATHS_SECTION, title: "base paths", role: "context", layout: "list", numbered: true, rows: groups.map(([, ofBase]) => baseRow(ofBase[0]!, ofBase.length)) },
    positions,
  };
}

/** The entrypoints of a snapshot as rows: one numbered row per finding, in the fact's order. */
export function present(fact: Fact<EntrypointMap>): Presentation {
  const section = fact.status === "unknown" ? undefined : fact.value.entrypoints;
  const findings = section === undefined || section.status === "unknown" ? [] : section.value;
  const unknownSection = section?.status === "unknown" ? section : undefined;
  const status = renderFactStatus(fact, "", { undecided: undecidedOf(findings), unknownSection: (name) => (name === "entrypoints" ? unknownSection?.reason : undefined) });
  const { section: base, positions } = basePaths(findings);
  const rows = findings.map((finding) => {
    const row = entrypointRow(finding);
    const reference = baseOf(finding);
    return reference === undefined ? row : { ...row, children: [...(row.children ?? []), { key: `${row.key}\0base`, label: `base ${positions.get(canonicalJson(reference))}` }] };
  });
  const cuts = [...(fact.status === "partial" ? fact.cuts : []), ...(section?.status === "partial" ? section.cuts : [])].filter((cut) => cut.kind !== "section");
  return {
    status: [...status, ...(unknownSection === undefined ? [] : renderFactStatus(unknownSection).slice(1))],
    snapshots: [fact.snapshot],
    narrowing: renderFactNarrowing(fact),
    sections: [
      { id: ENTRYPOINTS_SECTION, title: "entrypoints", role: "answer", layout: "by-file", numbered: true, primary: true, rows },
      base,
      cutSection(cuts),
    ],
  };
}
