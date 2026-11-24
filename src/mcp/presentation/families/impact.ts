import type { ImpactedSymbol, ImpactValue, SettledChange } from "../../../core/domain/impact/impact-fact.ts";
import type { ReachedModule } from "../../../core/domain/impact/module-dependency.ts";
import type { Fact } from "../../../core/domain/shared/fact.ts";
import type { WorkspaceImpactValue } from "../../../core/ports/workspace-impact-queries.port.ts";
import type { ImpactOwner } from "../../select-evidence.ts";
import { literalSelection } from "../../presentation-guidance.ts";
import { renderFactNarrowing, renderFactStatus } from "../../presentation-context.ts";
import type { Presentation, Row, Section } from "../model.ts";
import { cutSection, declarationRow, entrypointRow } from "../rows.ts";

function impactedRow(symbol: ImpactedSymbol, repo?: string): Row {
  const row = declarationRow(symbol.file, symbol, repo);
  const via = symbol.via;
  const tier = Math.max(0, symbol.depth - 1);
  if (via === undefined) return { ...row, tier };
  const dependency = `${via.file === symbol.file ? "" : `${via.file}:`}${via.symbol}`;
  const places = via.lines?.length ? ` at ${via.resource === undefined ? "" : `${via.resource} `}${via.lines.join(", ")}` : "";
  return {
    ...row, tier,
    qualifiers: [...(row.qualifiers ?? []), { name: "via", value: `${dependency}${places} (${via.basis})` }],
    children: (via.substitutes ?? []).map((substitute) => ({
      key: `${row.key}\0${substitute.file}\0${substitute.symbol}\0${substitute.line}`,
      label: `may be replaced by ${substitute.file}:${substitute.symbol}`,
      place: { path: substitute.at.file, line: substitute.at.line },
    })),
  };
}

function moduleRow(module: ReachedModule, repo?: string): Row {
  return {
    key: [repo ?? "", module.snapshot, module.file].join("\0"),
    place: { ...(repo === undefined ? {} : { repo }), path: module.file },
    label: module.snapshot,
    qualifiers: [
      { name: "depth", value: String(module.depth) },
      ...(module.origins.length === 0 ? [] : [{ name: "origins", value: module.origins.join(", ") }]),
      ...(module.via === undefined ? [] : [{ name: "via", value: `${module.via.kind} ${module.via.file} at line ${module.via.line} in this module${module.via.typeOnly ? " (type-only)" : ""}` }]),
    ],
    tier: Math.max(0, module.depth - 1),
  };
}

function settledRow(change: SettledChange): Row {
  const base = change.basis === "hunk" && change.base !== undefined ? `base ${change.base.start}-${change.base.end}` : undefined;
  const head = change.basis === "hunk" && change.head !== undefined ? `head ${change.head.start}-${change.head.end}` : undefined;
  return {
    key: JSON.stringify(change), place: { path: change.file },
    label: `${change.basis === "range" ? `${change.start}-${change.end}` : [base, head].filter((side) => side !== undefined).join(" -> ")} (${change.reason})`,
  };
}

export function sections(value: ImpactValue, prefix = "value", repo?: string, owner: ImpactOwner = { kind: "local" }, literalHandlers = false): Section[] {
  const section = (member: string, title: string, rows: readonly Row[], role: Section["role"] = "answer", layout: Section["layout"] = "by-file"): Section => ({ id: `${prefix}.${member}`, title: `${title} (${rows.length})`, role, layout, rows });
  const symbols = value.symbols.map((symbol) => impactedRow(symbol, repo));
  return [
    { ...section("symbols", "impacted symbols", symbols), primary: true },
    section("entrypoints", "reached entrypoints", value.entrypoints.map((entrypoint) => entrypointRow(entrypoint, repo, { seeds: value.seeds, ...(literalHandlers ? { handlerSelector: literalSelection({ kind: "handler-origins", owner, handler: { path: entrypoint.handler.path, symbol: entrypoint.handler.symbol, line: entrypoint.handler.line } }) } : {}) }))),
    section("modules.modules", "module dependencies (not symbol or entrypoint impact)", (value.modules?.modules ?? []).map((module) => moduleRow(module, repo)), "answer", "list"),
    section("modules.origins", "module origins", (value.modules?.origins ?? []).map((origin) => ({ key: [repo ?? "", origin.file, origin.change].join("\0"), place: { path: origin.file }, label: origin.change })), "context", "list"),
    { ...section("seeds", "seeds", value.seeds.map((seed) => declarationRow(seed.file, seed, repo)), "context"), numbered: true },
    section("changedPaths", "changed paths", (value.changedPaths ?? []).map((path) => ({ key: [repo ?? "", path.path].join("\0"), place: { path: path.path }, label: `${path.disposition}${path.deleted === true ? ", deleted" : ""}${path.removed === undefined ? "" : `; removed ${path.removed.join(", ")}`}` })), "context", "list"),
    section("changedEntrypoints", "changed entrypoints", (value.changedEntrypoints ?? []).map((change) => ({ ...entrypointRow({ ...change, seeds: [], depth: 0, confidence: 1 }, repo), qualifiers: [{ name: change.change }] }))),
    section("changedContracts", "changed contracts", (value.changedContracts ?? []).map((change) => ({ key: [change.document, change.line, change.method, change.path].join("\0"), place: { path: change.document, line: change.line }, label: `${change.change} ${change.method} ${change.path}${change.operationId === undefined ? "" : ` (${change.operationId})`}${change.parts === undefined ? "" : ` ${change.parts.join(" and ")}`}` }))),
    section("settled", "settled changes", (value.settled ?? []).map(settledRow), "context", "list"),
  ];
}

export function present(fact: Fact<ImpactValue>, literalHandlers = false): Presentation {
  return {
    status: [...renderFactStatus(fact), ...(fact.status !== "unknown" && !fact.value.symbols.some((symbol) => symbol.via?.basis !== "contains" && symbol.via?.basis !== "dispatch") ? ["no dependent recorded"] : [])], snapshots: [fact.snapshot],
    narrowing: [...renderFactNarrowing(fact), ...(fact.status === "unknown" || fact.value.mergeBase === undefined ? [] : [`merge base: ${fact.value.mergeBase}`])],
    sections: [...(fact.status === "unknown" ? [] : sections(fact.value, "value", undefined, { kind: "local" }, literalHandlers)), cutSection(fact.status === "partial" ? fact.cuts : [])],
  };
}

export function presentWorkspace(fact: Fact<WorkspaceImpactValue>, literalOwners: ReadonlySet<string> = new Set()): Presentation {
  if (fact.status === "unknown") return { status: renderFactStatus(fact), snapshots: [fact.snapshot], narrowing: renderFactNarrowing(fact), sections: [] };
  const mapped: Section[] = [];
  const narrowing = renderFactNarrowing(fact);
  for (const repo of fact.value.workspace.repos) {
    const section = fact.value.sections[repo];
    if (section === undefined || section.status === "unknown") continue;
    const value = section.value.impact;
    if (value !== undefined) {
      if (value.mergeBase !== undefined) narrowing.push(`merge base ${repo}: ${value.mergeBase}`);
      for (const part of sections(value, `value.sections.${repo}.value.impact`, repo, { kind: "section", repo }, literalOwners.has(repo))) {
        const { primary: _primary, ...rest } = part;
        mapped.push({ ...rest, title: `${repo} ${part.title}`, ...(part.primary === true && repo === fact.value.trigger.repo ? { primary: true } : {}) });
      }
    }
    if (section.status === "partial") mapped.push(cutSection(section.cuts, `value.sections.${repo}.cuts`, `cuts for repository ${repo}`));
  }
  mapped.push(cutSection(fact.status === "partial" ? fact.cuts : []));
  return {
    status: renderFactStatus(fact, "", { unknownSection: (repo) => { const section = fact.value.sections[repo]; return section?.status === "unknown" ? section.reason : undefined; } }),
    snapshots: [fact.snapshot], narrowing, sections: mapped,
  };
}
