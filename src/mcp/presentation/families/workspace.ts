import type { Fact } from "../../../core/domain/shared/fact.ts";
import { canonicalJson } from "../../../core/domain/shared/canonical-json.ts";
import { inheritedCallerCount, compareUnresolvedCallSites } from "../../../core/domain/topology/call-site.ts";
import type { WorkspaceValue } from "../../../core/ports/workspace-queries.port.ts";
import { renderFactNarrowing, renderFactStatus } from "../../presentation-context.ts";
import { dependencyDiagnosticText } from "../../presentation.ts";
import type { Presentation, Row, Section } from "../model.ts";
import { callSiteRow, cutSection, nameRow, linkRow, qualifiedEvidence, repositorySourceLine } from "../rows.ts";

type Value = Omit<WorkspaceValue, "repositories">;
function candidateRow(candidate: Value["candidates"][number], value: Value): Row {
  const links = [["links", value.links], ["inside links", value.internalLinks]] as const;
  const serving = links.map(([name, items]) => ({ name, items: items.flatMap((link, index) => link.to.repo === candidate.repo && candidate.evidence.some(place => place.repo === link.from.repo && place.path === link.from.file && place.line === link.from.line) ? [{ link, index }] : []) }));
  const references = candidate.basis === "link" && candidate.evidence.length > 0 && candidate.evidence.every(place => place.via === undefined && place.confidence === undefined && place.endLine === undefined && serving.some(group => group.items.some(({ link }) => place.repo === link.from.repo && place.path === link.from.file && place.line === link.from.line)));
  return {
    key: canonicalJson([candidate.name, candidate.repo, candidate.basis]), label: `${candidate.name} -> ${candidate.repo}`,
    qualifiers: [{ name: candidate.basis }, ...(references ? serving.filter(group => group.items.length > 0).map(group => ({ name: group.name, value: group.items.map(item => item.index).join(", ") })) : [])],
    evidence: references ? [] : candidate.evidence.map(place => qualifiedEvidence(place)),
  };
}

export function present(fact: Fact<Value>): Presentation {
  const value = fact.status === "unknown" ? undefined : fact.value;
  const undecided = value === undefined ? 0 : Object.values(value.sections).reduce((total, section) => total + (section.status === "unknown" ? 0 : section.value.unresolved.length + inheritedCallerCount(section.value.inherited ?? [])), 0);
  const sections: Section[] = [];
  if (value !== undefined) {
    sections.push({ id: "value.links", title: "links between the repositories read", role: "answer", layout: "by-file", primary: true, numbered: true, rows: value.links.map(linkRow) },
      { id: "value.internalLinks", title: "links inside one repository", role: "answer", layout: "by-file", numbered: true, rows: value.internalLinks.map(linkRow) },
      { id: "value.unlinked", title: "call sites the join reached without a link", role: "answer", layout: "by-file", rows: value.unlinked.map(site => callSiteRow(site)) });
    const available = new Map<string, { repo: string; index: number }>();
    for (const repo of value.workspace.repos) {
      const section = value.sections[repo];
      if (section === undefined || section.status === "unknown") continue;
      const snapshots = value.repositorySnapshots.filter(item => item.repo === repo);
      const valid = value.workspace.repos.filter(item => item === repo).length === 1 && section.snapshot.repo === repo && snapshots.length === 1 && snapshots[0]!.snapshot.repo === repo && canonicalJson(section.snapshot) === canonicalJson(snapshots[0]!.snapshot);
      const rows = section.value.names.map((name, index) => {
        const row = nameRow(name, repo);
        if (valid && name.evidence.length > 0) available.set(canonicalJson({ ...name, evidence: name.evidence.map(e => ({ ...e, repo })) }), { repo, index });
        return row;
      });
      sections.push({ id: `value.sections.${repo}.value.names`, title: `outward names in ${repo}`, role: "context", layout: "list", numbered: true, rows });
      sections.push({ id: `value.sections.${repo}.value.unresolved`, title: `unresolved call sites in ${repo}`, role: "context", layout: "by-file", rows: [...section.value.unresolved].sort(compareUnresolvedCallSites).map(site => callSiteRow(site, repo)) });
      const inherited: Row[] = (section.value.inherited ?? []).map(gap => ({
        key: canonicalJson([repo, gap.causePlace, gap.reason, gap.diagnostic, gap.transport, gap.via]), place: qualifiedEvidence(gap.causePlace, repo), label: `${gap.reason}/${gap.diagnostic.cause}`,
        qualifiers: [{ name: gap.transport }, ...(gap.via === undefined ? [] : [{ name: "through", value: gap.via }])],
        childrenAreAnswer: true, children: gap.callers.map(caller => callSiteRow({ ...caller, reason: gap.reason, transport: gap.transport, diagnostic: gap.diagnostic, evidence: caller.through ?? [] }, repo)),
      }));
      sections.push({ id: `value.sections.${repo}.value.inherited`, title: `inherited gaps in ${repo}`, role: "context", layout: "by-file", rows: inherited });
      if (section.status === "partial") {
        const cuts = cutSection(section.cuts, `value.sections.${repo}.cuts`, `cuts for repository ${repo}`);
        const dependencies = new Map(section.cuts.flatMap(cut => cut.dependency === undefined ? [] : [[cutSection([cut]).rows[0]!.key, dependencyDiagnosticText(cut.dependency)] as const]));
        sections.push({ ...cuts, rows: cuts.rows.map(row => dependencies.has(row.key) ? { ...row, label: `${row.label}: ${dependencies.get(row.key)}` } : row) });
      }
    }
    sections.push({ id: "value.candidates", title: "served by a local repository", role: "context", layout: "list", rows: value.candidates.map(candidate => candidateRow(candidate, value)) },
      { id: "value.unserved", title: "no local repository serves", role: "context", layout: "list", rows: value.unserved.map(name => {
        const ref = available.get(canonicalJson(name));
        return ref === undefined ? { ...nameRow(name), key: canonicalJson(name) } : { key: canonicalJson(name), label: `outward ${ref.repo}[${ref.index}]` };
      }) },
      { id: "value.undecidedBase", title: "names whose base is undecided", role: "context", layout: "list", rows: (value.undecidedBase ?? []).map(name => nameRow(name)) });
  }
  sections.push(cutSection(fact.status === "partial" ? fact.cuts : []));
  return { status: [...renderFactStatus(fact, "", { undecided }), ...Object.entries(value?.sections ?? {}).flatMap(([repo, section]) => section.status === "unknown" ? [`${repo}: unknown (${section.reason})`] : [])], snapshots: value === undefined || value.repositorySnapshots.length === 0 ? [fact.snapshot] : value.repositorySnapshots.map(item => item.snapshot), narrowing: [...renderFactNarrowing(fact), ...(value === undefined ? [] : [repositorySourceLine(value.workspace.source)])], sections };
}
