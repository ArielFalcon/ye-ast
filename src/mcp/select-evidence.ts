import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../core/domain/entrypoints/http-route.ts";
import type { ImpactValue, Seed } from "../core/domain/impact/impact-fact.ts";
import type { ModuleOrigin, ReachedModule } from "../core/domain/impact/module-dependency.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { Cut, Evidence, Fact, FactInputs, FactProvenance, ScopeSelection, Producer, SchemaVersion, SnapshotRef, UnknownReason } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { ImpactedLink, Link } from "../core/domain/topology/link.ts";
import { isFullObjectId } from "../core/domain/shared/revision.ts";
import type { WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import { analysis, type Analysis, type CutOwner } from "../core/domain/composition/source-read.ts";

export type ImpactOwner = { kind: "local" } | { kind: "section"; repo: string };
export type EvidenceSelection =
  | { kind: "handler-origins"; owner: ImpactOwner; handler: Pick<Handler, "path" | "symbol" | "line"> }
  | { kind: "module-origins"; owner: ImpactOwner; module: { file: string; snapshot: "base" | "head" } }
  | { kind: "entrypoint-evidence"; findingIndex: number }
  | { kind: "cut-places"; owner: CutOwner; cutIndex: number }
  | { kind: "workspace-link-evidence"; linkId: string };
export type EvidenceSource = { kind: "entrypoints"; fact: Fact<EntrypointMap> } | { kind: "local"; fact: Fact<ImpactValue> } | { kind: "workspace"; fact: Fact<WorkspaceImpactValue> };
export type SourceRead = { owner: CutOwner; schema: SchemaVersion; snapshot: SnapshotRef; producer: Producer; inputs: FactInputs; scopeSelection?: ScopeSelection; analysis: Analysis };
export type SourceSummary = Omit<SourceRead, "owner"> & { reads: readonly SourceRead[]; limits: readonly { owner: CutOwner; kind: Cut["kind"]; cuts: number; places: number; limit?: number }[] };
export type EntrypointEvidenceIdentity = Pick<Extract<Entrypoint, { kind: "http-route" }>, "kind" | "name" | "method" | "path" | "version" | "handler"> | Pick<Extract<Entrypoint, { kind: "ui-route" }>, "kind" | "name" | "path" | "outlet" | "component"> | Pick<Extract<Entrypoint, { kind: "listener" }>, "kind" | "name" | "protocol" | "destination" | "handler"> | Pick<Extract<Entrypoint, { kind: "job" }>, "kind" | "name" | "trigger" | "handler"> | Pick<Extract<Entrypoint, { kind: "callback" }>, "kind" | "name" | "contract" | "handler">;
export type HandlerOriginsContext = { owner: ImpactOwner; snapshot: SnapshotRef; handler: Handler; matchedEntrypointCount: number; interpretation: "recorded-origin-union" };
export type ModuleOriginsContext = { owner: ImpactOwner; snapshot: SnapshotRef; module: Omit<ReachedModule, "origins">; originCount: number };
export type EntrypointEvidenceContext = { findingIndex: number; section: Analysis; finding: { status: "complete"; identity: EntrypointEvidenceIdentity } | { status: "unknown"; reason: UnknownReason } };
export type CutPlacesContext = { owner: CutOwner; snapshot: SnapshotRef; analysis: Analysis; cutIndex: number; kind: Cut["kind"]; reason: Cut["reason"]; subReason?: NonNullable<Cut["subReason"]>; dependency?: NonNullable<Cut["dependency"]>; anchor: string; limit?: number };
export type LinkEvidenceContext = { link: Link; direction: ImpactedLink["direction"]; reachCount: number; endpoints: { from: { snapshot: SnapshotRef; analysis: Analysis }; to: { snapshot: SnapshotRef; analysis: Analysis } } };
export type HandlerOriginItem = { seedIndex: number; seed: Seed };
export type ModuleOriginItem = { originIndex: number; origin: ModuleOrigin };
export type EntrypointEvidenceItem = { evidenceIndex: number; evidence: Evidence };
export type CutPlaceItem = { atIndex: number; place: string };
export type LinkEvidenceItem = { position: number; linkId: string } & ({ link: Link } | { unavailable: true });
type Available = { availability: "available" } & (
  | { kind: "handler-origins"; context: HandlerOriginsContext; items: readonly HandlerOriginItem[] }
  | { kind: "module-origins"; context: ModuleOriginsContext; items: readonly ModuleOriginItem[] }
  | { kind: "entrypoint-evidence"; context: EntrypointEvidenceContext; items: readonly EntrypointEvidenceItem[] }
  | { kind: "cut-places"; context: CutPlacesContext; items: readonly CutPlaceItem[] }
  | { kind: "workspace-link-evidence"; context: LinkEvidenceContext; items: readonly LinkEvidenceItem[] }
);
export type EvidenceSelectionResult = { source: SourceSummary } & (Available | { availability: "unavailable"; reason: UnknownReason; evidence: readonly Evidence[] });
export type SelectionFault = { code: "selection-not-found" | "ambiguous-selection" };

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
function summary(source: EvidenceSource): SourceSummary {
  const reads: SourceRead[] = [];
  const limits: { owner: CutOwner; kind: Cut["kind"]; cuts: number; places: number; limit?: number }[] = [];
  function add(fact: FactProvenance, owner: CutOwner, includeRead: boolean): void {
    if (includeRead) reads.push({ owner, schema: fact.schema, snapshot: fact.snapshot, producer: fact.producer, inputs: fact.inputs, ...(fact.scopeSelection === undefined ? {} : { scopeSelection: fact.scopeSelection }), analysis: analysis(fact) });
    if (fact.status !== "partial") return;
    for (const cut of fact.cuts) {
      const existing = limits.find((item) => JSON.stringify(item.owner) === JSON.stringify(owner) && item.kind === cut.kind && item.limit === cut.limit);
      if (existing) { existing.cuts++; existing.places += Math.max(0, cut.at.length - 1); }
      else limits.push({ owner, kind: cut.kind, cuts: 1, places: Math.max(0, cut.at.length - 1), ...(cut.limit === undefined ? {} : { limit: cut.limit }) });
    }
  }
  const root = source.fact;
  add(root, { kind: "fact" }, false);
  if (source.kind === "entrypoints" && source.fact.status !== "unknown") add(source.fact.value.entrypoints, { kind: "entrypoints" }, true);
  if (source.kind === "workspace" && source.fact.status !== "unknown") {
    for (const repo of Object.keys(source.fact.value.sections).sort()) {
      const section = own(source.fact.value.sections, repo);
      if (!section) continue;
      add(section, { kind: "section", repo }, true);
      if (section.status !== "unknown") section.value.reads.forEach((read, index) => add(read.fact, { kind: "read", repo, index }, true));
    }
  }
  return { schema: root.schema, snapshot: root.snapshot, producer: root.producer, inputs: root.inputs, ...(root.scopeSelection === undefined ? {} : { scopeSelection: root.scopeSelection }), analysis: analysis(root), reads, limits };
}
function identity(entry: Entrypoint): EntrypointEvidenceIdentity {
  switch (entry.kind) {
    case "http-route": return { kind: entry.kind, name: entry.name, method: entry.method, path: entry.path, ...(entry.version === undefined ? {} : { version: entry.version }), handler: entry.handler };
    case "ui-route": return { kind: entry.kind, name: entry.name, path: entry.path, ...(entry.outlet === undefined ? {} : { outlet: entry.outlet }), component: entry.component };
    case "listener": return { kind: entry.kind, name: entry.name, protocol: entry.protocol, destination: entry.destination, handler: entry.handler };
    case "job": return { kind: entry.kind, name: entry.name, trigger: entry.trigger, handler: entry.handler };
    case "callback": return { kind: entry.kind, name: entry.name, contract: entry.contract, handler: entry.handler };
  }
}
function validIndex(index: number): boolean { return Number.isSafeInteger(index) && index >= 0; }
function validSnapshot(snapshot: SnapshotRef | undefined): snapshot is SnapshotRef {
  return snapshot !== undefined && typeof snapshot.repo === "string" && snapshot.repo.length > 0 && (snapshot.kind === "sha" ? typeof snapshot.sha === "string" && snapshot.sha.length > 0 : snapshot.kind === "live" && typeof snapshot.head === "string" && snapshot.head.length > 0 && typeof snapshot.stateId === "string" && snapshot.stateId.length > 0);
}

export function selectEvidence(source: EvidenceSource, selection: EvidenceSelection): Result<EvidenceSelectionResult, SelectionFault> {
  const sourceSummary = summary(source);
  const missing = (): Result<EvidenceSelectionResult, SelectionFault> => ({ ok: false, fault: { code: "selection-not-found" } });
  const ambiguous = (): Result<EvidenceSelectionResult, SelectionFault> => ({ ok: false, fault: { code: "ambiguous-selection" } });
  const unavailable = (fact: FactProvenance, reason: UnknownReason = fact.status === "unknown" ? fact.reason : "unresolved"): Result<EvidenceSelectionResult, SelectionFault> => ({ ok: true, value: { source: sourceSummary, availability: "unavailable", reason, evidence: fact.evidence } });
  const available = (value: Available): Result<EvidenceSelectionResult, SelectionFault> => ({ ok: true, value: { source: sourceSummary, ...value } });
  if (source.fact.status === "unknown") return unavailable(source.fact);
  if (!validSnapshot(source.fact.snapshot)) return unavailable(source.fact);
  if (selection.kind === "handler-origins" || selection.kind === "module-origins") {
    let impact: ImpactValue;
    let ownerFact: FactProvenance;
    if (source.kind === "local" && selection.owner.kind === "local") { impact = source.fact.value; ownerFact = source.fact; }
    else if (source.kind === "workspace" && selection.owner.kind === "section") {
      const section = own(source.fact.value.sections, selection.owner.repo);
      if (!section) return missing();
      if (section.status === "unknown") return unavailable(section);
      if (!section.value.impact) return missing();
      impact = section.value.impact; ownerFact = section;
    } else return missing();
    if (!validSnapshot(ownerFact.snapshot)) return unavailable(ownerFact);
    if (selection.kind === "handler-origins") {
      const h = selection.handler;
      const matched = impact.entrypoints.filter((e) => e.handler.path === h.path && e.handler.symbol === h.symbol && e.handler.line === h.line);
      if (!matched.length) return missing();
      const indexes = [...new Set(matched.flatMap((e) => e.seeds))].sort((a, b) => a - b);
      const items: HandlerOriginItem[] = [];
      for (const seedIndex of indexes) { const seed = impact.seeds[seedIndex]; if (!validIndex(seedIndex) || !seed) return unavailable(ownerFact); items.push({ seedIndex, seed }); }
      return available({ availability: "available", kind: selection.kind, context: { owner: selection.owner, snapshot: ownerFact.snapshot, handler: matched[0]!.handler, matchedEntrypointCount: matched.length, interpretation: "recorded-origin-union" }, items });
    }
    if (!impact.modules) return missing();
    const matches = impact.modules.modules.filter((m) => m.file === selection.module.file && m.snapshot === selection.module.snapshot);
    if (!matches.length) return missing();
    if (matches.length > 1) return ambiguous();
    const { origins, ...module } = matches[0]!;
    let snapshot = ownerFact.snapshot;
    if (module.snapshot === "base") {
      const base = impact.mergeBase ?? (source.kind === "workspace" && selection.owner.kind === "section" && selection.owner.repo === source.fact.value.trigger.repo ? source.fact.value.trigger.mergeBase : undefined);
      if (typeof base !== "string" || !isFullObjectId(base)) return unavailable(ownerFact);
      snapshot = { repo: snapshot.repo, kind: "sha", sha: base };
    }
    const items: ModuleOriginItem[] = [];
    for (const originIndex of [...new Set(origins)].sort((a, b) => a - b)) { const origin = impact.modules.origins[originIndex]; if (!validIndex(originIndex) || !origin) return unavailable(ownerFact); items.push({ originIndex, origin }); }
    return available({ availability: "available", kind: selection.kind, context: { owner: selection.owner, snapshot, module, originCount: origins.length }, items });
  }
  if (selection.kind === "entrypoint-evidence") {
    if (source.kind !== "entrypoints") return missing();
    const section = source.fact.value.entrypoints;
    if (section.status === "unknown") return unavailable(section);
    if (!validSnapshot(section.snapshot)) return unavailable(section);
    const finding = validIndex(selection.findingIndex) ? section.value[selection.findingIndex] : undefined;
    if (!finding) return missing();
    return available({ availability: "available", kind: selection.kind, context: { findingIndex: selection.findingIndex, section: analysis(section), finding: finding.status === "unknown" ? { status: "unknown", reason: finding.reason } : { status: "complete", identity: identity(finding.value) } }, items: finding.evidence.map((evidence, evidenceIndex) => ({ evidenceIndex, evidence })) });
  }
  if (selection.kind === "cut-places") {
    let owner: FactProvenance | undefined;
    if (selection.owner.kind === "fact") owner = source.fact;
    else if (selection.owner.kind === "entrypoints" && source.kind === "entrypoints") owner = source.fact.value.entrypoints;
    else if ((selection.owner.kind === "section" || selection.owner.kind === "read") && source.kind === "workspace") {
      const section = own(source.fact.value.sections, selection.owner.repo);
      if (!section) return missing();
      if (section.status === "unknown") return unavailable(section);
      owner = selection.owner.kind === "section" ? section : validIndex(selection.owner.index) ? section.value.reads[selection.owner.index]?.fact : undefined;
    }
    if (!owner) return missing();
    if (owner.status === "unknown") return unavailable(owner);
    if (!validSnapshot(owner.snapshot)) return unavailable(owner);
    const cut = owner.status === "partial" && validIndex(selection.cutIndex) ? owner.cuts[selection.cutIndex] : undefined;
    if (!cut) return missing();
    const anchor = cut.at[0];
    if (typeof anchor !== "string" || !anchor.length) return unavailable(owner);
    return available({ availability: "available", kind: selection.kind, context: { owner: selection.owner, snapshot: owner.snapshot, analysis: analysis(owner), cutIndex: selection.cutIndex, kind: cut.kind, reason: cut.reason, ...(cut.subReason === undefined ? {} : { subReason: cut.subReason }), ...(cut.dependency === undefined ? {} : { dependency: cut.dependency }), anchor, ...(cut.limit === undefined ? {} : { limit: cut.limit }) }, items: cut.at.slice(1).map((place, index) => ({ atIndex: index + 1, place })) });
  }
  if (source.kind !== "workspace") return missing();
  const value = source.fact.value;
  const matches = value.links.filter((item) => item.link.id === selection.linkId);
  if (!matches.length) return missing();
  if (matches.length > 1) return ambiguous();
  const selected = matches[0]!;
  const from = own(value.sections, selected.link.from.repo);
  const to = own(value.sections, selected.link.to.repo);
  if (!from || !to) return unavailable(source.fact);
  if (!validSnapshot(from.snapshot)) return unavailable(from);
  if (!validSnapshot(to.snapshot)) return unavailable(to);
  const items: LinkEvidenceItem[] = [];
  for (const [position, linkId] of selected.reach.entries()) {
    const found = value.links.filter((item) => item.link.id === linkId);
    if (found.length > 1) return ambiguous();
    items.push(found[0] ? { position, linkId, link: found[0].link } : { position, linkId, unavailable: true });
  }
  return available({ availability: "available", kind: selection.kind, context: { link: selected.link, direction: selected.direction, reachCount: selected.reach.length, endpoints: { from: { snapshot: from.snapshot, analysis: analysis(from) }, to: { snapshot: to.snapshot, analysis: analysis(to) } } }, items });
}
