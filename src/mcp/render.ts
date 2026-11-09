import { dependencyDiagnosticText, effectText, unresolvedLabel } from "./presentation.ts";
import { canSelect, categoryRecovery, literalSelection, sharedLookup } from "./presentation-guidance.ts";
import type { ImpactOwner, EvidenceSelection } from "./select-evidence.ts";
import type { CutOwner } from "../core/domain/composition/source-read.ts";
import { renderFactHeader as headerLines, renderFactStatus as statusLines, evidenceText, cutsByKind, cutCounts, cutReasonText, cutRowLabel, completeText, undecidedOf, type StatusContext } from "./presentation-context.ts";
import type { ResponseMode, RenderContext } from "./presentation.ts";
import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../core/domain/entrypoints/http-route.ts";
import type { ChangedContract } from "../core/domain/impact/changed-contracts.ts";
import type { ChangedEntrypoint } from "../core/domain/impact/changed-entrypoints.ts";
import type { ImpactedSymbol, ImpactValue, ReachedEntrypoint, Seed } from "../core/domain/impact/impact-fact.ts";
import type { ModuleImpactValue } from "../core/domain/impact/module-dependency.ts";
import type { ImportedFile, ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { OutlineBinding, OutlineDeclaration, OutlineImport, OutlineUse, OutlineValue } from "../core/domain/outline/outline-fact.ts";
import { hasUnprovedUses } from "../core/domain/outline/outline-uses.ts";
import type { ExternalCalls, TraceStep, TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { Decision, DecisionKind, DecisionOption } from "../core/domain/decisions/decision.ts";
import type { ChangeFrontier, ClassifiedDifference, ConsequenceFinding, ConsequencesValue, HypothesisAnswer, ProducerConsequence, UseConsequence } from "../core/domain/contracts/consequence-fact.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { Cut, Fact, Finding, SnapshotRef, WalkBounds } from "../core/domain/shared/fact.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { NameCandidate, OutwardKind, OutwardName, RepositoryOutwardName } from "../core/domain/topology/outward-name.ts";
import type { RepositoryEvidence } from "../core/domain/shared/repository-evidence.ts";
import type { WorkspaceRefresh, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import { compareUnresolvedCallSites, type CallSite, type UnresolvedCallSite } from "../core/domain/topology/call-site.ts";
import type { ImpactedLink, Link, UnlinkedCallSite } from "../core/domain/topology/link.ts";
import type { RepositoryResolution } from "../core/domain/topology/remote-snapshot.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { WorkspaceSource } from "../core/ports/workspace-repos.port.ts";
import { FIXED_LAYER_DIRECTORY } from "../core/ports/fixed-layer-store.port.ts";
import { WORKSPACE_MANIFEST_FILE } from "../core/ports/workspace-defaults.port.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { blockBytes as size, preferShorterText, shareExactContext } from "./presentation-sharing.ts";

const NONE = "  (none)";
const DECISIONS_HINT = "ye_ast_decisions lists the declarations that would resolve these gaps, with evidence-backed options.";
const CUTS = "cuts:";
const NO_PROVEN_USE = "uses nothing proven outside its body; its unresolved-link cuts list the uses not proven";

/** What each source of the repositories in force is called in the text; `none` says what the answer then covers. */
const SOURCE_TEXT: Readonly<Record<WorkspaceSource, string>> = {
  request: "the request",
  persisted: `${FIXED_LAYER_DIRECTORY}/${WORKSPACE_MANIFEST_FILE}`,
  none: "nothing: this answer covers the bound repository alone",
};

/** The line that says where the repositories the answer worked over came from, so one repository is never read as all of them. */
function sourceLine(source: WorkspaceSource, reposArgument: "repos" | "workspace.repos" = "workspace.repos"): string {
  const recovery = source === "none" ? ` (pass ${reposArgument}, or persist a declaration with ye-ast init --workspace)` : "";
  return `repositories declared by: ${SOURCE_TEXT[source]}${recovery}`;
}

/** A place: its line, and the last line when the declaration spans more than one. */
function spanText(line: number, endLine?: number): string {
  return endLine === undefined ? `${line}` : `${line}-${endLine}`;
}

function placeText(path: string, line: number, endLine?: number): string {
  return `${path}:${spanText(line, endLine)}`;
}

function cutsOf(fact: Fact<unknown>): readonly Cut[] {
  return fact.status === "partial" ? fact.cuts : [];
}

/** The reason of the repository section a name holds when that section is unknown. */
function unknownSectionIn(sections: Readonly<Record<string, Fact<unknown>>>): NonNullable<StatusContext["unknownSection"]> {
  return (name) => {
    const section = Object.hasOwn(sections, name) ? sections[name] : undefined;
    return section?.status === "unknown" ? section.reason : undefined;
  };
}

/** The first `:<line>` followed by a space or the end closes the path, as `placeAt` builds the place; the rest is its reason. */
const PLACE = /^(.*?):(\d+)(?: (.*))?$/s;

/** A `Cut.at` place read back into its parts; an entry that is no place is a file with no line and no reason. */
function placeOf(place: string): { file: string; line: string; reason: string } {
  const [, file = place, line = "", reason = ""] = PLACE.exec(place) ?? [];
  return { file, line, reason };
}

/** A place after its file: the line, and the reason it could not be read when it carries one. */
function placeRest({ line, reason }: ReturnType<typeof placeOf>): string {
  return reason === "" ? line : `${line} (${reason})`;
}

/** The places of an `unresolved-link` cut: the ones in the anchor's own file as line numbers, the rest as path:line. */
function cutPlaces(cut: Cut): string {
  const [anchor, ...places] = cut.at;
  if (cut.kind !== "unresolved-link" || anchor === undefined || places.length === 0) return cut.at.join(", ");
  const file = anchor.includes("::") ? anchor.slice(0, anchor.indexOf("::")) : anchor;
  const here = places.map(placeOf).filter((place) => place.file === file && place.line !== "").map(placeRest);
  const elsewhere = places.filter((place) => { const parsed = placeOf(place); return parsed.file !== file || parsed.line === ""; });
  const lines = here.length === 0 ? [] : [`${here.length === 1 ? "line" : "lines"} ${here.join(", ")}`];
  return `${anchor}: ${[...lines, ...groupedPlaces(elsewhere)].join(", ")}`;
}

/** The places grouped under their file, so a path repeated by every place is printed once and no place is dropped. */
function groupedPlaces(places: readonly string[]): string[] {
  const byFile = new Map<string, string[]>();
  for (const place of places) {
    const { file, line, reason } = placeOf(place);
    const key = reason === "" ? file : `${file} (${reason})`;
    byFile.set(key, [...(byFile.get(key) ?? []), line].filter((part) => part !== ""));
  }
  return [...byFile].map(([head, lines]) => (lines.length === 0 ? head : lines.length === 1 ? `${head}:${lines[0]}` : `${head}: ${lines.join(", ")}`));
}

/** One cut row; details name why the cut exists. */
function cutLine(cut: Cut, detail: ResponseMode): string {
  return `  ${detail === "details" ? cutRowLabel(cut) : cut.kind} at ${cutPlaces(cut)}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`;
}

/** The single-path cuts of one kind on one line: their limit only when all of them share it. */
function singlePathLine(kind: string, cuts: readonly Cut[]): string {
  const sorted = [...cuts].toSorted((a, b) => compareText(a.at[0] ?? "", b.at[0] ?? "") || (a.limit ?? 0) - (b.limit ?? 0));
  const limits = new Set(cuts.map((cut) => cut.limit));
  const [shared] = limits;
  const listed =
    limits.size === 1
      ? `${sorted.map((cut) => cut.at[0]).join(", ")}${shared === undefined ? "" : ` (limit ${shared})`}`
      : sorted.map((cut) => `${cut.at[0]}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`).join(", ");
  return `  ${kind} (${cuts.length}): ${listed}`;
}

/** The files the places of a cut sit in, without their lines: a place is `path:line`, a reason following a space. */
function placeFiles(cut: Cut): string {
  const files = new Set<string>();
  for (const place of cut.at.slice(1)) files.add(placeOf(place).file);
  return [...files].sort(compareText).join(", ");
}

/** The references a file-led cut could not settle, as written, sorted and deduplicated: the reader settles each one by
 * reading it, without opening the file. */
function placeReasons(cut: Cut): string[] {
  const reasons = new Set<string>();
  for (const place of cut.at.slice(1)) {
    const { reason } = placeOf(place);
    if (reason !== "") reasons.add(reason);
  }
  return [...reasons].sort(compareText);
}

/** The declarations an unresolved reference could not be settled to, under the file that holds them, each with the files
 * its references sit in. A file that leads a cut of its own names the references it holds, and a declaration whose places
 * are exactly those of another points at it instead of printing them a second time. */
function unresolvedDeclarations(cuts: readonly Cut[]): string[] {
  const whole = new Map<string, string[]>();
  const entries: { file: string; name: string; files: string; places: string }[] = [];
  for (const cut of cuts) {
    const anchor = cut.at[0] ?? "";
    const settled = anchor.indexOf("::");
    if (settled === -1) whole.set(anchor, [...new Set([...(whole.get(anchor) ?? []), ...placeReasons(cut)])]);
    else entries.push({ file: anchor.slice(0, settled), name: anchor.slice(settled + 2), files: placeFiles(cut), places: JSON.stringify([...new Set(cut.at.slice(1))].sort(compareText)) });
  }
  entries.sort((a, b) => compareText(a.file, b.file) || compareText(a.name, b.name));
  const canonical = new Map<string, { file: string; name: string }>();
  for (const entry of entries) if (entry.files !== "" && !canonical.has(entry.places)) canonical.set(entry.places, { file: entry.file, name: entry.name });
  const byFile = new Map<string, string[]>();
  for (const entry of entries) {
    const first = canonical.get(entry.places);
    const same = first !== undefined && (first.file !== entry.file || first.name !== entry.name);
    const line =
      entry.files === "" ? entry.name
      : !same ? `${entry.name}: ${entry.files}`
      : `${entry.name} (same places as ${first.file === entry.file ? first.name : `${first.file}::${first.name}`})`;
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), line]);
  }
  const references = cuts.reduce((total, cut) => total + Math.max(0, cut.at.length - 1), 0);
  const files = [...new Set([...whole.keys(), ...byFile.keys()])].sort(compareText);
  const named = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  const settled = [whole.size === 0 ? undefined : named(whole.size, "file", "files"), entries.length === 0 ? undefined : named(entries.length, "declaration", "declarations")].filter((part) => part !== undefined);
  return [
    `  unresolved-link (${settled.join(", ")}, ${named(references, "reference", "references")}; mode "details" lists every place):`,
    ...files.flatMap((file) => {
      const named = whole.get(file);
      return [
        named === undefined || named.length === 0 ? `    ${file}` : `    ${file}: ${named.join(", ")}`,
        ...(named !== undefined && named.length === 0 ? ["      (the file itself)"] : []),
        ...(byFile.get(file) ?? []).map((line) => `      ${line}`),
      ];
    }),
  ];
}

/** Every cut once: those that name a single path grouped per kind with every path listed, the rest one line each. Under
 * a summary, an unresolved link keeps only what it could not settle to. */
function dependencyCutLines(cuts: readonly Cut[], detail: ResponseMode): string[] {
  return cuts.flatMap((cut) => cut.dependency === undefined ? [] : [`  ${dependencyDiagnosticText(cut.dependency)}${detail === "details" ? ` at ${cutPlaces(cut)}` : ""}`]);
}

/** Cuts, grouped once by kind; a single-path kind puts all its paths on one line (many skipped files are one fact). In
 * a summary, an unresolved link keeps only what it could not settle to. */
function cutLines(cuts: readonly Cut[], detail: ResponseMode): string[] {
  const dependencies = dependencyCutLines(cuts, detail);
  if (dependencies.length > 0) return [...dependencies, ...cutLines(cuts.filter((cut) => cut.dependency === undefined), detail)];
  return cutsByKind(cuts).flatMap(([kind, ofKind]) => {
    if (kind === "unresolved-link" && detail !== "details") return unresolvedDeclarations(ofKind);
    const single = ofKind.filter((cut) => cut.at.length === 1);
    const rest = ofKind.filter((cut) => cut.at.length > 1).toSorted((a, b) => compareText(a.at.join("\0"), b.at.join("\0")));
    const singles = detail === "details" ? [...Map.groupBy(single, cutRowLabel)].toSorted(([a], [b]) => compareText(a, b)) : single.length === 0 ? [] : [[kind, single] as const];
    return [...singles.map(([label, cuts]) => singlePathLine(label, cuts)), ...rest.map((cut) => cutLine(cut, detail))];
  });
}

/** One selector template per cut owner; row indices always refer to the original array. */
function cutContextLine(owner: CutOwner, cutIndex: number, context?: RenderContext): string {
  const example = { kind: "cut-places", owner, cutIndex } as const;
  const selectable = context === undefined || canSelect(context, example, owner.kind === "section" || owner.kind === "read");
  return selectable
    ? sharedLookup("Cut", "cutIndex <n>", "cutIndex", example)
    : `  Recorded cut context: ${JSON.stringify({ kind: "cut-places", owner })}; each row supplies its cutIndex.`;
}

function cutCoordinates(cuts: readonly Cut[], owner: CutOwner, detail: ResponseMode, context?: RenderContext): string[] {
  if (cuts.length === 0) return [];
  const shown = new Set<Cut["kind"]>();
  const rows = cuts.flatMap((cut, cutIndex) => {
    if (detail === "summary" && shown.has(cut.kind)) return [];
    shown.add(cut.kind);
    return [{ cutIndex, anchor: detail === "summary" ? "" : ` (anchor ${JSON.stringify(cut.at[0])})` }];
  });
  const first = rows[0]!;
  const example = { kind: "cut-places", owner, cutIndex: first.cutIndex } as const;
  const selectable = context === undefined || canSelect(context, example, owner.kind === "section" || owner.kind === "read");
  const literal = rows.map(({ cutIndex, anchor }) => `  ${!selectable ? "recorded coordinates" : "lookup example"}: ${literalSelection({ kind: "cut-places", owner, cutIndex })}${anchor}`);
  const shared = [
    cutContextLine(owner, first.cutIndex, context),
    ...rows.map(({ cutIndex, anchor }) => `  cutIndex ${cutIndex}${anchor}`),
  ];
  return size(shared) < size(literal) ? shared : literal;
}

function cutsBlock(cuts: readonly Cut[], detail: ResponseMode = "summary"): string[] {
  return cuts.length === 0 ? [] : [CUTS, ...cutLines(cuts, detail)];
}

function list(lines: readonly string[]): string[] {
  return lines.length === 0 ? [NONE] : [...lines];
}

function counted(label: string, items: readonly string[]): string {
  return items.length === 0 ? `${label} (0):` : `${label} (${items.length}): ${items.join(", ")}`;
}

function handlerText(handler: Handler): string {
  return `${placeText(handler.path, handler.line, handler.endLine)} ${handler.symbol}`;
}

/** The dependence that reached a symbol: where it depends on it, and what that dependence is. */
function viaText(via: NonNullable<ImpactedSymbol["via"]>, file: string): string {
  const where = via.file === file ? via.symbol : `${via.file}:${via.symbol}`;
  const marker = via.substitutes === undefined ? "" : ` ${SUBSTITUTION_MARKER}`;
  if (via.lines === undefined || via.lines.length === 0) return `${where} (${via.basis})${marker}`;
  const at = `at ${via.resource === undefined ? "" : `${via.resource} `}${via.lines.join(", ")}`;
  return `${via.basis === "call" ? `${where} ${at}` : `${where} ${at} (${via.basis})`}${marker}`;
}

const SUBSTITUTION_MARKER = "†";

/** One legend line per provider substitution the shown dependences carry. */
function substitutionLegend(symbols: readonly ImpactedSymbol[]): string[] {
  const lines = symbols.flatMap((symbol) => (symbol.via?.substitutes ?? []).map((substitute) => `  ${SUBSTITUTION_MARKER} may be replaced by ${substitute.file}:${substitute.symbol} at ${substitute.at.file}:${substitute.at.line}`));
  return [...new Set(lines)].sort(compareText);
}

function entrypointLocation(entrypoint: Entrypoint): string {
  return entrypoint.kind === "ui-route" ? (entrypoint.component === "unknown" ? "component unknown" : handlerText(entrypoint.component)) : handlerText(entrypoint.handler);
}

function entrypointLine(entrypoint: Entrypoint): string {
  const served = entrypointLocation(entrypoint);
  return `  - ${entrypoint.kind} ${entrypoint.name} -> ${served}`;
}

function itemLine(item: Finding<Entrypoint>): string {
  return item.status === "unknown" ? `  - unknown (${item.reason}) ${item.evidence.map(evidenceText).join(", ")}`.trimEnd() : entrypointLine(item.value);
}

function entrypointContext(entrypoint: Entrypoint): string[] {
  if (entrypoint.kind === "ui-route") {
    return entrypoint.guards.length === 0 ? ["    no own guards recorded"] : [
      `    own guards (${entrypoint.guards.length}):`,
      ...entrypoint.guards.map((guard) => `      - ${guard.name}${guard.path === undefined ? "" : ` (${guard.path})`}${guard.external === true ? " (external)" : ""}`),
    ];
  }
  if (entrypoint.kind !== "http-route") return [];
  const base = entrypoint.basePath;
  if (base.status === "unknown") return [`    base path unknown (${base.reason})${base.evidence.length === 0 ? "" : `: ${base.evidence.map(evidenceText).join(", ")}`}`];
  const profiles = Object.keys(base.value.profiles).length;
  return [`    base path defaults: ${JSON.stringify(base.value.default)}${profiles === 0 ? "" : `; ${profiles} profile-specific settings, ${categoryRecovery({ full: "includes them" })}`}`];
}

function unknownFindingRun(items: readonly Finding<Entrypoint>[], start: number): { end: number; lines: string[] } {
  const first = items[start]!;
  if (first.status !== "unknown" || first.evidence.length !== 1) return { end: start + 1, lines: [`${itemLine(first)} [findingIndex ${start}]`] };
  const evidence = first.evidence[0]!;
  const { line: _line, endLine: _endLine, ...sharedEvidence } = evidence;
  let end = start + 1;
  while (end < items.length) {
    const next = items[end]!;
    if (next.status !== "unknown" || next.reason !== first.reason || next.evidence.length !== 1) break;
    const { line: _nextLine, endLine: _nextEndLine, ...rest } = next.evidence[0]!;
    if (JSON.stringify(rest) !== JSON.stringify(sharedEvidence)) break;
    end++;
  }
  const literal = items.slice(start, end).map((item, offset) => `${itemLine(item)} [findingIndex ${start + offset}]`);
  const shared = [`  - unknown (${first.reason}) ${evidence.path}:`, ...items.slice(start, end).map((item, offset) => {
    const place = item.evidence[0]!;
    return `    findingIndex ${start + offset}: ${spanText(place.line, place.endLine)}`;
  })];
  return { end, lines: size(shared) < size(literal) ? shared : literal };
}

/** Repeated extraction evidence can support several findings without repeating the same coordinates. */
function entrypointItems(items: readonly Finding<Entrypoint>[], detail: ResponseMode, sharedBase?: ReadonlyMap<string, number>, sharedEvidence?: ReadonlyMap<string, number>): string[] {
  if (sharedBase === undefined || sharedEvidence === undefined) {
    const evidence = shareExactContext(items.flatMap((item) => item.status === "unknown" && item.evidence.length !== 1 ? item.evidence : []), (place) => place);
    const evidenceCounts = new Map<number, number>();
    for (const row of evidence.rows) evidenceCounts.set(row.contextIndex, (evidenceCounts.get(row.contextIndex) ?? 0) + 1);
    const evidenceIndices = new Map<string, number>();
    const evidenceDefinitions: string[] = [];
    evidence.contexts.forEach((place, index) => {
      if ((evidenceCounts.get(index) ?? 0) > 1) {
        const reference = evidenceIndices.size;
        evidenceIndices.set(canonicalJson(place), reference);
        evidenceDefinitions.push(`  evidence ${reference}: ${JSON.stringify(place)}`);
      }
    });
    if (evidenceDefinitions.length > 0) evidenceDefinitions.unshift("  Evidence references are indices; each row lists evidence in its original order, including repeats.");
    const routes = detail === "details" ? items.flatMap((item) => item.status === "complete" && item.value.kind === "http-route" ? [item.value] : []) : [];
    const bases = shareExactContext(routes, (route) => route.basePath);
    const baseCounts = new Map<number, number>();
    for (const row of bases.rows) baseCounts.set(row.contextIndex, (baseCounts.get(row.contextIndex) ?? 0) + 1);
    const baseIndices = new Map<string, number>();
    const baseDefinitions: string[] = [];
    bases.contexts.forEach((base, index) => {
      if ((baseCounts.get(index) ?? 0) > 1) {
        const reference = baseIndices.size;
        baseIndices.set(canonicalJson(base), reference);
        const description = base.status === "unknown" ? `base path unknown (${base.reason})` : "base path";
        baseDefinitions.push(`  base context ${reference}: ${description} ${JSON.stringify(base)}`);
      }
    });
    const empty = new Map<string, number>();
    let best = entrypointItems(items, detail, empty, empty);
    for (const [baseMap, baseLines] of [[empty, []], [baseIndices, baseDefinitions]] as const) {
      for (const [evidenceMap, evidenceLines] of [[empty, []], [evidenceIndices, evidenceDefinitions]] as const) {
        const candidate = [...baseLines, ...evidenceLines, ...entrypointItems(items, detail, baseMap, evidenceMap)];
        if (preferShorterText(best.join("\n"), candidate.join("\n")) === candidate.join("\n")) best = candidate;
      }
    }
    return best;
  }
  const contextOf = (entrypoint: Entrypoint): string[] => {
    if (entrypoint.kind === "http-route") {
      const index = sharedBase?.get(canonicalJson(entrypoint.basePath));
      if (index !== undefined) return [`    base context ${index}`];
    }
    return entrypointContext(entrypoint);
  };
  if (detail !== "details") {
    const lines: string[] = [];
    for (let index = 0; index < items.length;) {
      const first = items[index]!;
      if (first.status === "unknown") {
        if (first.evidence.length !== 1 && first.evidence.some((place) => sharedEvidence.has(canonicalJson(place)))) {
          const references = first.evidence.map((place) => sharedEvidence.get(canonicalJson(place)) ?? place);
          lines.push(`  - unknown (${first.reason}) [findingIndex ${index}] evidence: ${JSON.stringify(references)}`);
          index++;
        } else { const run = unknownFindingRun(items, index); lines.push(...run.lines); index = run.end; }
        continue;
      }
      const location = entrypointLocation(first.value);
      let end = index + 1;
      while (end < items.length) {
        const next = items[end]!;
        if (next.status === "unknown" || entrypointLocation(next.value) !== location) break;
        end++;
      }
      const group = items.slice(index, end);
      const listing = group.map((item, offset) => `${itemLine(item)} [findingIndex ${index + offset}]`);
      const shared = [`  served by ${location}`, ...group.map((item, offset) => item.status === "complete" ? `    - ${item.value.kind} ${item.value.name} [findingIndex ${index + offset}]` : itemLine(item))];
      lines.push(...(group.length > 1 && size(shared) < size(listing) ? shared : listing));
      index = end;
    }
    return list(lines);
  }
  const lines: string[] = [];
  for (let index = 0; index < items.length;) {
    const first = items[index]!;
    if (first.status === "unknown") {
      if (first.evidence.length !== 1 && first.evidence.some((place) => sharedEvidence.has(canonicalJson(place)))) {
        const references = first.evidence.map((place) => sharedEvidence.get(canonicalJson(place)) ?? place);
        lines.push(`  - unknown (${first.reason}) [findingIndex ${index}] evidence: ${JSON.stringify(references)}`);
        index++;
      } else { const run = unknownFindingRun(items, index); lines.push(...run.lines); index = run.end; }
      continue;
    }
    if (first.evidence.length === 0) {
      lines.push(`${itemLine(first)} [findingIndex ${index}]`, ...(first.status === "complete" ? contextOf(first.value) : []));
      index++;
      continue;
    }
    const key = JSON.stringify(first.evidence);
    let end = index + 1;
    while (end < items.length && items[end]!.status === "complete" && JSON.stringify(items[end]!.evidence) === key) end++;
    const evidence = first.evidence.map((place) => `${evidenceText(place)}${place.via === undefined ? "" : ` via ${place.via}`}${place.confidence === undefined ? "" : ` confidence ${place.confidence}`}`).join(", ");
    const findings = items.slice(index, end).map((item, offset) => `${itemLine(item)} [findingIndex ${index + offset}]`);
    const separate = findings.flatMap((line) => [line, `    evidence: ${evidence}`]);
    const shared = [`  evidence shared by ${findings.length} findings: ${evidence}`, ...findings];
    lines.push(...(findings.length > 1 && size(shared) < size(separate) ? shared : separate));
    const contexts = items.slice(index, end).flatMap((item) => item.status === "complete" ? [contextOf(item.value)] : []);
    const contextKeys = new Set(contexts.map((context) => JSON.stringify(context)));
    if (contextKeys.size === 1) {
      if (findings.length > 1 && (contexts[0]?.length ?? 0) > 0) lines.push("  The following context applies to all findings above:");
      lines.push(...(contexts[0] ?? []));
    }
    else for (const item of items.slice(index, end)) if (item.status === "complete") lines.push(`  ${item.value.kind} ${item.value.name}:`, ...contextOf(item.value));
    index = end;
  }
  return list(lines);
}

export function renderEntrypointMap(fact: Fact<EntrypointMap>, detail: ResponseMode = "summary", context?: RenderContext): string {
  if (detail === "full") {
    if (fact.status === "unknown") return "Inspect reason and evidence; the result has no value.";
    const section = fact.value.entrypoints;
    return section.status === "unknown"
      ? "Check value.entrypoints.status, reason and evidence; this section has no value."
      : `${context?.recovery?.status === "unavailable" ? `Recovery unavailable (${context.recovery.reason}); recorded coordinates` : "Selection lookup"}: findingIndex is the zero-based position in value.entrypoints.value. Check value.entrypoints.status and value.entrypoints.value; match each complete finding in value.entrypoints.value[].value by kind/name and handler or component coordinates. Inspect basePath status and evidence for HTTP routes; unknown findings carry reason and evidence, and partial sections carry cuts.${section.value.some((item) => item.status === "complete" && item.value.kind === "ui-route") ? " For UI routes, match kind and name, then inspect value.entrypoints.value[].value.guards; these are each route's own guards, not inherited or runtime restrictions." : ""}`;
  }
  const undecided = fact.status === "unknown" || fact.value.entrypoints.status === "unknown" ? 0 : undecidedOf(fact.value.entrypoints.value);
  const lines = headerLines(fact, { undecided });
  if (fact.status === "unknown") return lines.join("\n");
  const section = fact.value.entrypoints;
  lines.push("entrypoints:", ...statusLines(section, "  ", { undecided }));
  if (section.status !== "unknown") {
    const known = section.value.filter((item) => item.status === "complete").length;
    const unknown = section.value.length - known;
    const unknownBases = section.value.filter((item) => item.status === "complete" && item.value.kind === "http-route" && item.value.basePath.status === "unknown").length;
    const uiRoutes = section.value.flatMap((item) => item.status === "complete" && item.value.kind === "ui-route" ? [item.value] : []);
    const guardCount = uiRoutes.reduce((total, route) => total + route.guards.length, 0);
    const guardedRoutes = uiRoutes.filter((route) => route.guards.length > 0).length;
    const guardNote = uiRoutes.length === 0 ? [] : [
      ...(detail === "summary" && guardCount > 0 ? [`  ${guardCount} own guards across ${guardedRoutes} routes; ${categoryRecovery({ full: "locates them at value.entrypoints.value[].value.guards after matching route kind and name." })}`] : []),
      "  Only each route's own guards are recorded; inherited or runtime restrictions are not established here.",
    ];
    lines.push(`  findings: ${known} known, ${unknown} unknown`, ...(unknownBases === 0 ? [] : [`  base path unknown for ${unknownBases} ${unknownBases === 1 ? "route" : "routes"}`]), ...guardNote, ...entrypointItems(section.value, detail));
  }
  lines.push(...cutsBlock([...cutsOf(fact), ...cutsOf(section)], detail), ...cutCoordinates(cutsOf(fact), { kind: "fact" }, detail, context), ...cutCoordinates(cutsOf(section), { kind: "entrypoints" }, detail, context));
  return lines.join("\n");
}

function changedLine(change: ChangedEntrypoint): string {
  return `  - ${change.change} ${change.kind} ${change.name} -> ${handlerText(change.handler)}`;
}

function changedContractLine(change: ChangedContract): string {
  return `  - ${changedContractText(change)}`;
}

function changedContractText(change: Omit<ChangedContract, "handlers">): string {
  const name = change.operationId === undefined ? "" : ` (${change.operationId})`;
  const parts = change.parts === undefined ? "" : ` ${change.parts.join(" and ")}`;
  return `${change.change} ${change.method} ${change.path}${name}${parts} at ${change.document}:${change.line}`;
}

/** A compact row names its handler as `path:line[-endLine] symbol`; a literal row carries its complete selector. */
function reachedLines(reached: ReachedEntrypoint, seeds: readonly Seed[], detail: ResponseMode, owner: ImpactOwner, compact: boolean, sharedOrigin = false): string[] {
  const name = reached.name === undefined ? reached.kind : `${reached.kind} ${reached.name}`;
  const facts = [`depth ${reached.depth}`];
  if (reached.confidence < 1) facts.push(`confidence ${reached.confidence}`);
  if (!compact && reached.handler.endLine !== undefined) facts.push(`endLine ${reached.handler.endLine}`);
  if (detail === "summary" && reached.seeds.length > 0) facts.push(plural(reached.seeds.length, "origin"));
  const origin = seeds[reached.seeds[0] ?? -1];
  const others = reached.seeds.length - 1;
  const { path, symbol, line } = reached.handler;
  return [
    compact ? `  - ${name} -> ${handlerText(reached.handler)} (${facts.join(", ")})` : `  - ${name} (${facts.join(", ")}); lookup example: ${literalSelection({ kind: "handler-origins", owner, handler: { path, symbol, line } })}`,
    ...(detail === "summary" || origin === undefined || sharedOrigin ? [] : [`    one verified origin: ${placeText(origin.file, origin.line, origin.endLine)} ${origin.symbol} (${origin.basis})${others > 0 ? `; ${plural(others, "other origin")}` : ""}`]),
  ];
}

/** The symbol is the last word of a compact handler coordinate, so a symbol with whitespace keeps literal selectors. */
const HANDLER_ROW = "-> <path>:<line>[-<endLine>] <symbol>";

function reachedGroup(value: ImpactValue, detail: ResponseMode, owner: ImpactOwner, selectable = true): string[] {
  const support = shareExactContext(value.entrypoints, (entrypoint) => ({
    indices: entrypoint.seeds,
    support: entrypoint.seeds.map((index) => value.seeds[index]),
    confidence: entrypoint.confidence,
  }));
  const rows = (compact: boolean): string[] => {
    const output: string[] = [];
    for (let index = 0; index < value.entrypoints.length;) {
      const first = value.entrypoints[index]!;
      let end = index + 1;
      while (end < value.entrypoints.length) {
        if (support.rows[end]!.contextIndex !== support.rows[index]!.contextIndex) break;
        end++;
      }
      const run = value.entrypoints.slice(index, end);
      const literal = run.flatMap((entrypoint) => reachedLines(entrypoint, value.seeds, detail, owner, compact));
      const origin = value.seeds[first.seeds[0] ?? -1];
      if (detail === "details" && run.length > 1 && origin !== undefined) {
        const other = first.seeds.length - 1;
        const shared = [`  For the next ${run.length} handler rows, one verified origin: ${placeText(origin.file, origin.line, origin.endLine)} ${origin.symbol} (${origin.basis})${other > 0 ? `; ${plural(other, "other origin")}` : ""}`, ...run.flatMap((entrypoint) => reachedLines(entrypoint, value.seeds, detail, owner, compact, true))];
        output.push(...(size(shared) < size(literal) ? shared : literal));
      } else output.push(...literal);
      index = end;
    }
    return output;
  };
  if (!selectable) return rows(true);
  const literal = rows(false);
  const first = value.entrypoints[0];
  if (first === undefined || value.entrypoints.some((entrypoint) => /\s/.test(entrypoint.handler.symbol))) return literal;
  const { path, symbol, line } = first.handler;
  const shared = [
    sharedLookup("Handler", HANDLER_ROW, "handler path, line and symbol (not endLine)", { kind: "handler-origins", owner, handler: { path, symbol, line } }),
    ...rows(true),
  ];
  return preferShorterText(literal.join("\n"), shared.join("\n")) === shared.join("\n") ? shared : literal;
}

/** A seed is already listed, so a symbol reached at depth 0 that stands for one is not printed twice. */
function seedKeys(value: ImpactValue): Set<string> {
  return new Set(value.seeds.map((seed) => `${seed.file}\0${seed.symbol}\0${seed.line}`));
}

function symbolLine(symbol: ImpactedSymbol, file: string, includeVia = true): string {
  const facts = [`depth ${symbol.depth}`];
  if (symbol.confidence < 1) facts.push(`confidence ${symbol.confidence}`);
  if (symbol.via?.derivation === "name-match") facts.push("name match");
  if (symbol.via?.derivation === "typed") facts.push("typed");
  if (symbol.fanIn > 0) facts.push(`fan-in ${symbol.fanIn}`);
  if (includeVia && symbol.via !== undefined) facts.push(`via ${viaText(symbol.via, file)}`);
  return `    ${spanText(symbol.line, symbol.endLine)} ${symbol.symbol} [${symbol.kind}] (${facts.join(", ")})`;
}


function groupedLines(symbols: readonly ImpactedSymbol[]): string[] {
  return [...Map.groupBy(symbols, (symbol) => symbol.file)].flatMap(([file, inFile]) => {
    const lines = [`  ${file}`];
    for (let start = 0; start < inFile.length;) {
      const first = inFile[start]!;
      const via = first.via === undefined ? undefined : viaText(first.via, file);
      let end = start + 1;
      while (via !== undefined && end < inFile.length) {
        const next = inFile[end]!;
        if (next.via === undefined || viaText(next.via, file) !== via) break;
        end++;
      }
      const run = inFile.slice(start, end);
      const listing = run.map((symbol) => symbolLine(symbol, file));
      const grouped = [`    via ${via}`, ...run.map((symbol) => `  ${symbolLine(symbol, file, false)}`)];
      lines.push(...(via !== undefined && size(grouped) <= size(listing) ? grouped : listing));
      start = end;
    }
    return lines;
  });
}

function consequenceSymbols(value: ImpactValue): readonly ImpactedSymbol[] {
  const seeds = seedKeys(value);
  return value.symbols.filter((symbol) => symbol.depth !== 0 || !seeds.has(`${symbol.file}\0${symbol.symbol}\0${symbol.line}`));
}

/** A containment reaches the symbol that holds a reached one, and a dispatch the same member in a related type; only another basis reaches a symbol that depends on it. */
function isDependent(symbol: ImpactedSymbol): boolean {
  return symbol.via?.basis !== "contains" && symbol.via?.basis !== "dispatch";
}

function dependentLevel(symbols: readonly ImpactedSymbol[]): number {
  return symbols.reduce((depth, symbol) => isDependent(symbol) ? Math.min(depth, symbol.depth) : depth, Infinity);
}

/**
 * The nearest dependents and the reached handlers, with the rows that place them: the dispatch counterpart a shown row
 * depends through, and the containment of a shown row.
 */
function investigationSymbols(value: ImpactValue): readonly ImpactedSymbol[] {
  const symbols = consequenceSymbols(value);
  const level = dependentLevel(symbols);
  const shown = new Set(symbols.filter((symbol) => (isDependent(symbol) && symbol.depth === level) || value.entrypoints.some(({ handler }) => handler.path === symbol.file && handler.line === symbol.line && handler.symbol === symbol.symbol)));
  const context = symbols.filter((symbol) => !isDependent(symbol) && !shown.has(symbol));
  for (let added = true; added;) {
    const shownKeys = new Set([...shown].map((symbol) => symbolKey(symbol.file, symbol.symbol)));
    const dependedOn = new Set([...shown].flatMap(({ via }) => (via === undefined ? [] : [symbolKey(via.file, via.symbol)])));
    const placing = context.filter((symbol) => !shown.has(symbol) && (symbol.via?.basis === "contains" ? shownKeys.has(symbolKey(symbol.via.file, symbol.via.symbol)) : dependedOn.has(symbolKey(symbol.file, symbol.symbol))));
    for (const symbol of placing) shown.add(symbol);
    added = placing.length > 0;
  }
  return symbols.filter((symbol) => shown.has(symbol));
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const segmentsOf = (file: string) => file.split("/");
const symbolKey = (file: string, symbol: string) => `${file}\0${symbol}`;

/** A `changed` glob over changed files and the narrower areas inside it. */
interface ChangeArea {
  glob: string;
  files: readonly string[];
  children: readonly ChangeArea[];
}

/** The directories below the first `depth` shared segments, each collapsed to where its files diverge. */
function directoryAreas(files: readonly string[], depth: number): ChangeArea[] {
  const nested = files.filter((file) => segmentsOf(file).length > depth + 1);
  return [...Map.groupBy(nested, (file) => segmentsOf(file)[depth]!)].map(([, inside]) => {
    const first = segmentsOf(inside[0]!);
    let end = depth + 1;
    while (inside.every((file) => { const segments = segmentsOf(file); return segments.length > end + 1 && segments[end] === first[end]; })) end++;
    return { glob: `${first.slice(0, end).join("/")}/**`, files: inside, children: directoryAreas(inside, end) };
  }).toSorted((a, b) => compareText(a.glob, b.glob));
}

/**
 * The changed files as a tree of `changed` globs: below the directories every file shares, each file and each
 * directory, a directory broken down wherever its files diverge. Undefined when the tree has one root, since narrowing
 * to it repeats the request.
 */
function changeAreas(changed: readonly string[]): readonly ChangeArea[] | undefined {
  const files = [...new Set(changed)].toSorted(compareText);
  const first = segmentsOf(files[0] ?? "");
  let shared = 0;
  while (files.every((file) => { const segments = segmentsOf(file); return segments.length > shared + 1 && segments[shared] === first[shared]; })) shared++;
  const roots = [
    ...files.filter((file) => segmentsOf(file).length === shared + 1).map((file) => ({ glob: file, files: [file], children: [] })),
    ...directoryAreas(files, shared),
  ].toSorted((a, b) => compareText(a.glob, b.glob));
  return roots.length > 1 ? roots : undefined;
}

/** The seed file a symbol's recorded `via` chain starts at; undefined when the chain does not reach a seed. */
function seedFileOf(symbol: ImpactedSymbol, seedFiles: ReadonlyMap<string, string>, byKey: ReadonlyMap<string, ImpactedSymbol>): string | undefined {
  const visited = new Set<ImpactedSymbol>();
  for (let current: ImpactedSymbol | undefined = symbol; current?.via !== undefined && !visited.has(current);) {
    visited.add(current);
    const key = symbolKey(current.via.file, current.via.symbol);
    const file = seedFiles.get(key);
    if (file !== undefined) return file;
    current = byKey.get(key);
  }
  return undefined;
}

/** A change's impacted symbols and module dependencies counted per changed area, so a large change answers where to narrow. */
function areaLines(value: ImpactValue, areas: readonly ChangeArea[], symbols: readonly ImpactedSymbol[]): string[] {
  const seedFiles = new Map(value.seeds.map((seed) => [symbolKey(seed.file, seed.symbol), seed.file]));
  const byKey = new Map<string, ImpactedSymbol>();
  for (const symbol of symbols) {
    const key = symbolKey(symbol.file, symbol.symbol);
    if (!byKey.has(key)) byKey.set(key, symbol);
  }
  type Tally = { seeds: number; direct: number; deeper: number; entrypoints: Set<number>; modules: Set<number> };
  const tallies = new Map<string, Tally>();
  const tally = (file: string) => tallies.get(file) ?? tallies.set(file, { seeds: 0, direct: 0, deeper: 0, entrypoints: new Set(), modules: new Set() }).get(file)!;
  for (const seed of value.seeds) tally(seed.file).seeds++;
  let unrecorded = 0;
  for (const symbol of symbols) {
    const file = seedFileOf(symbol, seedFiles, byKey);
    if (file === undefined) unrecorded++;
    else if (symbol.depth === 1) tally(file).direct++;
    else tally(file).deeper++;
  }
  value.entrypoints.forEach((entrypoint, index) => { for (const seed of entrypoint.seeds) if (value.seeds[seed] !== undefined) tally(value.seeds[seed].file).entrypoints.add(index); });
  const modules = value.modules;
  modules?.modules.forEach((module, index) => { for (const origin of module.origins) if (modules.origins[origin] !== undefined) tally(modules.origins[origin].file).modules.add(index); });
  const row = (area: ChangeArea, level: number): string[] => {
    const parts = area.files.map((file) => tally(file));
    const sum = (count: (part: Tally) => number) => parts.reduce((total, part) => total + count(part), 0);
    const union = (members: (part: Tally) => Set<number>) => new Set(parts.flatMap((part) => [...members(part)])).size;
    const counts = [plural(sum((part) => part.seeds), "seed"), `${sum((part) => part.direct)} direct`, `${sum((part) => part.deeper)} deeper`, plural(union((part) => part.entrypoints), "entrypoint"), ...(modules === undefined ? [] : [plural(union((part) => part.modules), "module")])];
    return [`${"  ".repeat(level)}${area.glob}: ${counts.join(", ")}`, ...area.children.flatMap((child) => row(child, level + 1))];
  };
  return [
    `impacted symbols (${symbols.length}) by changed area (a symbol counts under the area its first recorded path starts in; indented areas break down the one above):`,
    ...areas.flatMap((area) => row(area, 1)),
    ...(unrecorded === 0 ? [] : [`  origin not recorded: ${plural(unrecorded, "symbol")}`]),
    `  repeat with changed ["<area>"] to walk one area's seeds; mode "details" shows investigation evidence; ${categoryRecovery({ full: "includes every symbol" })}`,
  ];
}

function impactedSymbols(value: ImpactValue, detail: ResponseMode): string[] {
  const symbols = consequenceSymbols(value);
  const header = `impacted symbols (${symbols.length}):`;
  if (symbols.length === 0) return [header];
  const literal = [header, ...groupedLines(symbols), ...substitutionLegend(symbols)];
  if (detail === "summary") {
    const direct = symbols.filter((symbol) => symbol.depth === 1);
    const deeper = [...Map.groupBy(symbols.filter((symbol) => symbol.depth !== 1), (symbol) => symbol.depth)].toSorted(([a], [b]) => a - b);
    const counts = deeper.length === 0 ? "" : `by depth: ${deeper.map(([depth, group]) => `${depth}: ${group.length}`).join(", ")}; `;
    const counted = [header, ...groupedLines(direct), `  ${counts}mode "details" shows investigation evidence; ${categoryRecovery({ full: "includes every symbol" })}`];
    return size(counted) <= size(literal) ? counted : literal;
  }
  const shown = investigationSymbols(value);
  const omitted = symbols.length - shown.length;
  const level = dependentLevel(shown);
  const view = level === Infinity
    ? `  evidence view: no dependent recorded${omitted === 0 ? "" : `; ${plural(omitted, "containment or dispatch row")}`}; ${categoryRecovery({ full: "includes all" })}`
    : `  evidence view: nearest dependent depth ${level} and reached handlers`;
  const evidence = [header, view, ...groupedLines(shown), ...substitutionLegend(shown), ...(level === Infinity || omitted === 0 ? [] : [`  ${omitted} other ${omitted === 1 ? "symbol" : "symbols"}; ${categoryRecovery({ full: "includes all" })}`])];
  return omitted > 0 && size(evidence) <= size(literal) ? evidence : literal;
}

/** What an impact answer says about its walk, without its header or its cuts. */
function impactBody(value: ImpactValue, detail: ResponseMode, owner: ImpactOwner, context?: RenderContext, narrowable = true): string[] {
  const selectable = (selection: EvidenceSelection) => context === undefined || canSelect(context, selection, owner.kind === "section");
  const handler = value.entrypoints[0]?.handler;
  const module = value.modules?.modules[0];
  return [
    ...(narrowable && context?.recovery?.status === "unavailable" ? [`  Recovery unavailable (${context.recovery.reason}); recorded coordinates do not establish an executable replay.`] : []),
    ...(value.mergeBase === undefined ? [] : [`merge base: ${value.mergeBase}`]),
    ...(value.changedEntrypoints === undefined ? [] : [`changed entrypoints (${value.changedEntrypoints.length}):`, ...value.changedEntrypoints.map(changedLine)]),
    ...(value.changedContracts === undefined ? [] : [`changed contracts (${value.changedContracts.length}):`, ...value.changedContracts.map(changedContractLine)]),
    `reached entrypoints (${value.entrypoints.length}):`,
    ...(detail === "details" && value.entrypoints.some((entrypoint) => entrypoint.seeds.length > 1) ? [value.entrypoints.length === 1
      ? `  ${categoryRecovery({ full: "has all origins." })}`
      : `  Origin counts and examples below: ${categoryRecovery({ full: "includes all" })} recorded associations for this owner.`] : []),
    ...(detail === "details" && value.entrypoints.some((entrypoint) => entrypoint.seeds.length > 0) ? ["  A recorded origin is an association, not a complete call chain."] : []),
    ...(detail === "summary" && value.entrypoints.some((entrypoint) => entrypoint.seeds.length > 0) ? [`  origin associations (${value.entrypoints.reduce((total, entrypoint) => total + entrypoint.seeds.length, 0)}): counted below; mode "details" shows one per entrypoint; ${categoryRecovery({ full: "includes all" })}`] : []),
    ...reachedGroup(value, detail, owner, handler === undefined || selectable({ kind: "handler-origins", owner, handler: { path: handler.path, symbol: handler.symbol, line: handler.line } })),
    ...consequenceLines(value, detail, owner, module === undefined || selectable({ kind: "module-origins", owner, module: { file: module.file, snapshot: module.snapshot } }), narrowable),
  ];
}

/**
 * Impacted symbols and module dependencies. A change's summary that the request can narrow with `changed` counts both
 * per changed area instead, when that is not longer.
 */
function consequenceLines(value: ImpactValue, detail: ResponseMode, owner: ImpactOwner, selectable: boolean, narrowable: boolean): string[] {
  const listed = [...impactedSymbols(value, detail), ...(value.modules === undefined ? [] : moduleLines(value.modules, detail, owner, selectable))];
  const symbols = consequenceSymbols(value);
  const areas = detail === "summary" && narrowable && value.mergeBase !== undefined && symbols.length > 0
    ? changeAreas([...value.seeds.map((seed) => seed.file), ...(value.modules?.origins.map((origin) => origin.file) ?? [])])
    : undefined;
  if (areas === undefined) return listed;
  const counted = [...areaLines(value, areas, symbols), ...(value.modules === undefined ? [] : moduleLines(value.modules, detail, owner, selectable, true))];
  return size(counted) <= size(listed) ? counted : listed;
}

function moduleLines(value: ModuleImpactValue, detail: ResponseMode, owner: ImpactOwner, selectable = true, countedByArea = false): string[] {
  const originListing = value.origins.map((origin) => `  ${origin.file} (${origin.change})`);
  const counts = [...Map.groupBy(value.origins, (origin) => origin.change)].map(([change, group]) => `${group.length} ${change}`).join(", ");
  const originCount = [`  ${value.origins.length} origins (${counts}); ${categoryRecovery({ full: "includes every origin" })}`];
  const origins = value.origins.length > 0 && size(originCount) < size(originListing) ? originCount : originListing;
  const nearest = value.modules.reduce((depth, module) => module.depth > 0 ? Math.min(depth, module.depth) : depth, Infinity);
  const shown = value.modules.filter((module) => module.depth === 0 || module.depth === nearest);
  type Module = ModuleImpactValue["modules"][number];
  const context = (module: Module): string => {
    const count = module.origins.length;
    const first = value.origins[module.origins[0] ?? -1];
    const example = detail === "details" && first !== undefined ? `; origin ${first.file} (${first.change})` : "";
    return `${count} origin ${count === 1 ? "association" : "associations"}${example}`;
  };
  const line = (module: Module, includeContext: boolean, compact: boolean): string =>
    `  ${compact ? `${module.snapshot} ${module.file}` : `[lookup example: ${literalSelection({ kind: "module-origins", owner, module: { file: module.file, snapshot: module.snapshot } })}]`} (depth ${module.depth}${includeContext ? `, ${context(module)}` : ""})${module.via === undefined ? "" : ` via ${module.via.kind} ${module.via.file} at line ${module.via.line} in this module${module.via.typeOnly ? " (type-only)" : ""}`}`;
  const grouped = (modules: readonly Module[], compact = !selectable): string[] => {
    const lines: string[] = [];
    for (let start = 0; start < modules.length;) {
      const first = modules[start]!;
      const key = JSON.stringify(first.origins);
      let end = start + 1;
      while (end < modules.length && JSON.stringify(modules[end]!.origins) === key) end++;
      const run = modules.slice(start, end);
      const separate = run.map((module) => line(module, true, compact));
      const shared = [`  shared ${context(first)}:`, ...run.map((module) => `  ${line(module, false, compact)}`)];
      lines.push(...(run.length > 1 && size(shared) < size(separate) ? shared : separate));
      start = end;
    }
    return lines;
  };
  const listing = grouped(value.modules);
  const omitted = value.modules.length - shown.length;
  const omittedNote = omitted === 0 ? [] : [`  ${omitted} deeper module dependencies not listed; mode: "full" includes their recorded evidence.`];
  const nearestListing = [...grouped(shown), ...omittedNote];
  const useNearest = omitted > 0 && size(nearestListing) < size(listing);
  const selectedModules = useNearest ? shown : value.modules;
  const selected = useNearest ? nearestListing : listing;
  const first = selectedModules[0];
  const lookupShared = first === undefined || !selectable ? selected : [
    sharedLookup("Module", "<snapshot> <file>", "module snapshot and file", { kind: "module-origins", owner, module: { file: first.file, snapshot: first.snapshot } }),
    ...grouped(selectedModules, true),
    ...(useNearest ? omittedNote : []),
  ];
  if (countedByArea) {
    return [
      `module origins (${value.origins.length}):`, ...origins,
      `module dependencies (${value.modules.length}, not symbol or entrypoint impact): counted per changed area above; ${categoryRecovery({ full: "includes every module" })}`,
      `module expansions: ${value.cost.expansionsUsed}`,
    ];
  }
  return [
    `module origins (${value.origins.length}):`, ...origins,
    `module dependencies (${value.modules.length}, not symbol or entrypoint impact):`,
    ...(value.modules.some((module) => module.origins.length > (detail === "details" ? 1 : 0)) ? [selectedModules.length === 1
      ? `  ${categoryRecovery({ full: "has all origins." })}`
      : `  Origin counts/examples below belong to each module; ${categoryRecovery({ full: "includes all" })} recorded associations for this owner.`] : []), ...(size(lookupShared) < size(selected) ? lookupShared : selected),
    `module expansions: ${value.cost.expansionsUsed}`,
  ];
}

function impactSeeds(value: ImpactValue, detail: ResponseMode): string[] {
  if (detail === "summary") return [`seeds (${value.seeds.length}):`, ...groupedSeeds(value.seeds)];
  const dependencies = new Set(investigationSymbols(value).flatMap((symbol) => symbol.via === undefined ? [] : [`${symbol.via.file}\0${symbol.via.symbol}`]));
  const shown: Seed[] = [];
  const omitted: Seed[] = [];
  for (const seed of value.seeds) {
    (seed.basis === "requested" || dependencies.has(`${seed.file}\0${seed.symbol}`) ? shown : omitted).push(seed);
  }
  const evidence = [...seedListing(shown), ...seedSummary(omitted)];
  const literal = seedListing(value.seeds);
  return [`seeds (${value.seeds.length}):`, ...(size(evidence) <= size(literal) ? evidence : literal)];
}

/** Keep file and consecutive basis context with the seeds it describes. */
function seedListing(seeds: readonly Seed[]): string[] {
  return [...Map.groupBy(seeds, (seed) => seed.file)].flatMap(([file, inFile]) => {
    const bases = new Set(inFile.map((seed) => seed.basis));
    const [shared] = bases;
    if (bases.size === 1 && shared !== undefined) return [`  ${file} (${shared})`, ...inFile.map((seed) => `    ${spanText(seed.line, seed.endLine)} ${seed.symbol}`)];
    const rows: string[] = [`  ${file}`];
    for (let start = 0; start < inFile.length;) {
      const first = inFile[start]!;
      let end = start + 1;
      while (end < inFile.length && inFile[end]!.basis === first.basis) end++;
      const run = inFile.slice(start, end);
      const literal = run.map((seed) => `    ${spanText(seed.line, seed.endLine)} ${seed.symbol} (${seed.basis})`);
      const grouped = [`    (${first.basis})`, ...run.map((seed) => `      ${spanText(seed.line, seed.endLine)} ${seed.symbol}`)];
      rows.push(...(size(grouped) < size(literal) ? grouped : literal));
      start = end;
    }
    return rows;
  });
}

/** Requested declarations remain explicit; the other origins are counted across the change, by selection basis. */
function seedSummary(seeds: readonly Seed[]): string[] {
  const requested = seeds.filter((seed) => seed.basis === "requested");
  const rest = seeds.filter((seed) => seed.basis !== "requested");
  const files = new Set(rest.map((seed) => seed.file));
  const bases = [...Map.groupBy(rest, (seed) => seed.basis)].toSorted(([a], [b]) => compareText(a, b)).map(([basis, group]) => `${basis} ${group.length}`);
  return [
    ...seedListing(requested),
    ...(rest.length === 0 ? [] : [`  change origins: ${rest.length} ${rest.length === 1 ? "declaration" : "declarations"} across ${files.size} ${files.size === 1 ? "file" : "files"} (${bases.join(", ")}); ${categoryRecovery({ full: "includes every seed" })}`]),
  ];
}

/** The seeds of a summary, or the full listing when counting them would cost more bytes than naming them. */
function groupedSeeds(seeds: readonly Seed[]): string[] {
  const listing = seedListing(seeds);
  const summary = seedSummary(seeds);
  return size(summary) <= size(listing) ? summary : listing;
}

function impactCuts(cuts: readonly Cut[], detail: ResponseMode): string[] {
  if (cuts.length === 0) return [];
  const dependencies = dependencyCutLines(cuts, detail);
  if (dependencies.length > 0) return [CUTS, ...dependencies, ...impactCuts(cuts.filter((cut) => cut.dependency === undefined), detail).slice(1)];
  const groups = cutsByKind(cuts);
  if (detail === "summary") return [CUTS, ...groups.map(([kind, group]) => {
    const limits = [...new Set(group.flatMap((cut) => cut.limit === undefined ? [] : [cut.limit]))].toSorted((a, b) => a - b);
    return `  ${kind} (${group.length})${limits.length === 0 ? "" : `; ${limits.length === 1 ? "limit" : "limits"} ${limits.join(", ")}`}`;
  }), '  cuts mark missing coverage; mode "details" locates their recorded anchors and mode: "full" lists every place; neither extends coverage'];
  return [CUTS, ...groups.flatMap(([kind, group]) => {
    if (kind !== "unresolved-link") return cutLines(group, "details");
    const byFile = Map.groupBy(group, (cut) => (cut.at[0] ?? "").split("::")[0] ?? "");
    return [`  ${kind} (${group.length}):`, ...[...byFile].toSorted(([a], [b]) => compareText(a, b)).flatMap(([file, inFile]) => [
      `    ${file}`,
      ...[...Map.groupBy(inFile, (cut) => cut.at[0] ?? "")].toSorted(([a], [b]) => compareText(a, b)).map(([anchor, records]) => {
        const name = anchor.includes("::") ? anchor.slice(anchor.indexOf("::") + 2) : "(the file itself)";
        const places = records.reduce((total, cut) => total + Math.max(0, cut.at.length - 1), 0);
        const reasons = anchor.includes("::") ? [] : [...new Set(records.flatMap(placeReasons))].sort(compareText);
        const limits = [...new Set(records.flatMap((cut) => cut.limit === undefined ? [] : [cut.limit]))].toSorted((a, b) => a - b);
        const why = [...new Set(records.map(cutReasonText))].sort(compareText).join(", ");
        return `      ${name}: ${records.length} ${records.length === 1 ? "cut" : "cuts"} (${why}), ${places} reference ${places === 1 ? "place" : "places"}${limits.length === 0 ? "" : `; limits ${limits.join(", ")}`}${reasons.length === 0 ? "" : `; ${reasons.join(", ")}`}`;
      }),
    ])];
  }), ...referencePlacesNote(cuts)];
}

/** Details list every place of the other kinds; only unresolved-link reference places are counted instead. */
function referencePlacesNote(cuts: readonly Cut[]): string[] {
  return cuts.some((cut) => cut.kind === "unresolved-link") ? ['  reference places counted; mode: "full" includes every place'] : [];
}

/**
 * The traversal bound a cut provably came from. Depth and hub cuts come only from symbol and module walks, and a walk
 * records its bounds in its own declared config, so a matching limit names the request's budget field. A caller-budget
 * cut may also come from an export, so it never names one; neither does any other kind.
 */
function walkBoundRemedies(cuts: readonly Cut[], walk: WalkBounds | undefined): string[] {
  return ([["depth", "depth"], ["hub", "hubFanIn"]] as const).flatMap(([kind, field]) => {
    const limit = walk?.[field];
    return limit !== undefined && cuts.some((cut) => cut.kind === kind && cut.limit === limit)
      ? [`  ${kind} cuts stopped at the walk bound budget.${field} ${limit}; a new query with a larger budget.${field} walks further at more cost; it does not filter this result.`]
      : [];
  });
}

/** Bind narrative and selection coordinates once, retaining original cut order and per-cut metadata. */
function impactCutBlock(cuts: readonly Cut[], detail: ResponseMode, owner: CutOwner, context?: RenderContext, walk?: WalkBounds): string[] {
  return [...impactCutLayout(cuts, detail, owner, context), ...walkBoundRemedies(cuts, walk)];
}

function impactCutLayout(cuts: readonly Cut[], detail: ResponseMode, owner: CutOwner, context?: RenderContext): string[] {
  const literal = [...impactCuts(cuts, detail), ...cutCoordinates(cuts, owner, detail, context)];
  if (detail !== "details" || cuts.length === 0) return literal;
  const shared = [CUTS, cutContextLine(owner, 0, context)];
  let previous: Cut | undefined;
  for (const [cutIndex, cut] of cuts.entries()) {
    if (cut.kind !== previous?.kind) shared.push(`  ${cut.kind}:`);
    const coordinate = `cutIndex ${cutIndex}`;
    if (cut.kind === "unresolved-link") {
      if (previous?.kind !== cut.kind || previous.at[0] !== cut.at[0]) shared.push(`    anchor ${JSON.stringify(cut.at[0])}:`);
      const places = Math.max(0, cut.at.length - 1);
      const reasons = placeReasons(cut);
      shared.push(`      ${coordinate}; ${cutReasonText(cut)}; ${places} reference ${places === 1 ? "place" : "places"}${cut.limit === undefined ? "" : `; limit ${cut.limit}`}${reasons.length === 0 ? "" : `; spellings ${JSON.stringify(reasons)}`}`);
    } else {
      shared.push(`    ${coordinate}; ${cutRowLabel(cut) === cut.kind ? "" : `${cutReasonText(cut)}; `}${cutPlaces(cut)}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`);
    }
    previous = cut;
  }
  shared.push(...referencePlacesNote(cuts));
  return size(shared) < size(literal) ? shared : literal;
}

function impactLookups(value: ImpactValue, path: string, context?: RenderContext): string[] {
  const lines: string[] = [];
  if (value.entrypoints.length > 0) lines.push(`  To inspect a reached entrypoint, select ${path}.entrypoints by kind/name and handler.path, handler.symbol, handler.line. Its seeds are zero-based indexes into ${path}.seeds; resolve those indexes to recover all associated origins, not a complete call chain.`);
  if (value.symbols.length > 0) lines.push(`  To inspect a dependency omitted from text, filter ${path}.symbols by file, symbol and line. Read via.file/symbol for its recorded dependency; via.lines are locations in that symbol's own file, or in via.resource when present, not in via.file. Preserve via.basis, via.derivation and confidence when interpreting it; a name-match derivation may be no dependence.`);
  if (value.seeds.length > 0 && value.entrypoints.length === 0) lines.push(`  To identify the walk origins, match ${path}.seeds by file, symbol and line; basis distinguishes requested targets from change-derived origins.`);
  if (value.modules !== undefined && (value.modules.origins.length > 0 || value.modules.modules.length > 0)) lines.push(`  Inspect ${path}.modules.origins and ${path}.modules.modules; each module origin index joins that origins array. Module dependencies are distinct from symbol impact.`);
  if ((value.changedEntrypoints?.length ?? 0) > 0) lines.push(`  To inspect entrypoints added, removed or altered by the diff, filter ${path}.changedEntrypoints by change, kind/name and handler identity; these are distinct from reached entrypoints.`);
  if (lines.length > 0 && context?.recovery?.status !== "unavailable") lines.unshift(`  Selection lookup: use handler path, symbol and line with owner ${path === "value" ? '{kind:"local"}' : '{kind:"section",repo:<repository key>}'}${context?.tool === "callers" || value.modules === undefined ? "." : "; module lookup uses file and snapshot (base or head) with the same owner."}`);
  return lines;
}

function impactCutLookup(cuts: readonly Cut[], path: string, context?: RenderContext, walk?: WalkBounds): string[] {
  if (cuts.length === 0) return [];
  const example = { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 } as const;
  return [
    ...(context !== undefined && canSelect(context, example, false) ? [`  lookup example: ${literalSelection(example)}`] : []),
    `  ${context?.recovery?.status === "unavailable" ? "Recorded coordinates" : "Selection lookup"}: cutIndex is the zero-based position in ${path}; owner identifies the fact, entrypoints section, repository section or indexed read.
  Before treating this result as exhaustive, inspect ${path}: filter by kind and the relevant anchor in at; a recorded limit explains where coverage stopped. Full JSON does not extend that coverage.`,
    ...(cuts.some((cut) => cut.kind === "unresolved-link") ? [`  For unresolved-link in ${path}, at[0] names the unresolved file/declaration anchor and the remaining at entries locate potential references; they are not verified calls.`] : []),
    ...walkBoundRemedies(cuts, walk),
  ];
}

function impactSnapshotGuide(snapshot: SnapshotRef, mergeBase?: string, context?: RenderContext, hasBaseModules = false): string {
  if (context?.tool === "callers" && snapshot.kind === "sha") return `  Repeat callers with repo ${JSON.stringify(snapshot.repo)} and revision ${JSON.stringify(snapshot.sha)}, retaining declared scope and symbol selection. Related outline/importers queries answer a new question.`;
  if (snapshot.kind === "live") return `  A fresh live query on repo ${JSON.stringify(snapshot.repo)} captures current state; compare its head and stateId with the earlier identity before treating evidence as the same. A past live state cannot be requested, and HEAD alone does not reproduce it.`;
  const selector = mergeBase === undefined ? `revision ${JSON.stringify(snapshot.sha)}` : `head ${JSON.stringify(snapshot.sha)} and base ${JSON.stringify(mergeBase)}`;
  return `  Keep repo ${JSON.stringify(snapshot.repo)} and the same snapshot when repeating this query: ${selector}; retain the declared scope and change selection. For a related callers/outline/importers query about head evidence use revision ${JSON.stringify(snapshot.sha)} instead of impact base/head${hasBaseModules ? "; base-side modules use their recorded merge-base revision" : ""}. It answers a new question, not a filter over this result.`;
}

function baseModuleGuides(value: ImpactValue, repo: string, mergeBase = value.mergeBase, path = "value", reuseLocalBase = false, full = false): string[] {
  const modules = (value.modules?.modules ?? []).filter((module) => module.snapshot === "base");
  if (modules.length === 0) return [];
  const literalCoordinate = mergeBase === undefined ? "revision unavailable" : `revision ${JSON.stringify(mergeBase)}`;
  const coordinate = reuseLocalBase && Buffer.byteLength("the base recorded below") < Buffer.byteLength(literalCoordinate) ? "the base recorded below" : literalCoordinate;
  const literal = modules.map((module) => `  Base module: repo ${JSON.stringify(repo)}, ${coordinate}, file ${JSON.stringify(module.file)}; use outline only at that recorded merge base.`);
  const shared = [`  Base modules: repo ${JSON.stringify(repo)}, ${coordinate}; inspect ${path}.modules.modules[] for each base module's file; use outline only at that recorded merge base.`];
  const listed = [`  Base modules (${modules.length}): repo ${JSON.stringify(repo)}, ${coordinate}; each base module's file is in the module dependencies above where listed, and mode: "full" lists every one; use outline only at that recorded merge base.`];
  const bounded = full ? shared : listed;
  return size(bounded) < size(literal) ? bounded : literal;
}

/**
 * An unknown impact has no value, and no mode adds the missing analysis. The text header already prints its reason and
 * evidence; only full mode carries them as result fields, so only full mode points there.
 */
function unknownImpactGuide(fact: Fact<unknown> & { status: "unknown" }, detail: ResponseMode, context?: RenderContext): string[] {
  const narrower = context?.tool === "callers" ? "fewer targets" : "a narrower changed selection";
  return [
    "Analysis is unknown, not a verified absence of impact; no mode adds the missing analysis.",
    ...(fact.reason === "deadline" ? [`  It hit its deadline: a narrower scope or ${narrower} may let a new query finish.`] : []),
    ...(detail === "full" ? ["  reason and evidence in the result JSON hold its diagnostic; there is no value."] : []),
  ];
}

function localImpactGuide(fact: Fact<ImpactValue> & { status: "complete" | "partial" }, context?: RenderContext): string[] {
  const lookups = impactLookups(fact.value, "value", context);
  if (lookups.length === 0 && fact.status === "complete") return ["There are no recorded consequences or walk origins within the declared scope and change selection."];
  return [
    "Investigation guide:",
    "  JSON navigation: paths below are relative to the result JSON.",
    ...lookups,
    ...(lookups.length === 0 ? ["  There are no recorded consequences or walk origins in this answer. Read inputs.declaredScope and inputs.declaredConfig before interpreting that scoped emptiness."] : []),
    ...impactCutLookup(cutsOf(fact), "cuts", context, fact.inputs.declaredConfig.walk),
    ...localQueryCoordinates(fact, context, "full"),
  ];
}

function localQueryCoordinates(fact: Fact<ImpactValue> & { status: "complete" | "partial" }, context: RenderContext | undefined, mode: ResponseMode): string[] {
  return [
    ...baseModuleGuides(fact.value, fact.snapshot.repo, fact.value.mergeBase, "value", fact.snapshot.kind === "sha" && fact.value.mergeBase !== undefined && context?.tool !== "callers", mode === "full"),
    impactSnapshotGuide(fact.snapshot, fact.value.mergeBase, context, fact.value.modules?.modules.some((module) => module.snapshot === "base")),
  ];
}

function workspaceImpactGuide(fact: Fact<WorkspaceImpactValue> & { status: "complete" | "partial" }, context?: RenderContext): string[] {
  const { value } = fact;
  const trigger = value.sections[value.trigger.repo];
  const originPath = `value.sections[${JSON.stringify(value.trigger.repo)}].value.impact`;
  const otherImpacts = Object.entries(value.sections).flatMap(([repo, section]) => repo === value.trigger.repo || section.status === "unknown" || section.value.impact === undefined ? [] : [section.value.impact]);
  return [
    "Investigation guide:",
    "  JSON navigation: paths below are relative to the result JSON.",
    ...(Object.keys(value.sections).length === 0 ? [] : ["  Select value.sections by the exact repository key, not a shared relative file path. Check section.status and, when present, section.reason/cuts and section.value.reads[].fact status/reason before using its evidence; an unknown section has no value."]),
    ...(trigger?.status !== "unknown" && trigger?.value.impact !== undefined ? [`  The originating repository's walk is at ${originPath}.`, ...impactLookups(trigger.value.impact, originPath, context)] : []),
    ...(otherImpacts.length === 0 ? [] : ["  Other repository walks are at value.sections[repo].value.impact only when that field exists. In each walk, entrypoints[].seeds indexes that same walk's seeds array; never join origins across repositories."]),
    ...(value.links.length === 0 ? [] : ["  To follow a cross-repository consequence, filter value.links by link.from (repo/file/symbol/line) or link.to (repo/name/handler). Each reach contains link IDs in recorded order: resolve them against value.links[].link.id, not the text's display numbers. Retain direction, basis and confidence; reach does not establish an unrecorded path inside a repository."]),
    ...(value.workspace.unserved.length === 0 ? [] : ["  For missing service coverage, inspect value.workspace.unserved, section.value.unmatched and section.value.external when present. Use ye_ast_workspace to investigate outward-name evidence and candidate local repositories; adding workspace.repos changes the query's coverage rather than filtering this fact."]),
    ...impactCutLookup(cutsOf(fact), "cuts", context, fact.inputs.declaredConfig.walk),
    ...(Object.values(value.sections).some((section) => section.status === "partial") ? ["  Repository-local limits remain in value.sections[repo].cuts; inspect contributing section.value.reads[].fact too. Do not treat a complete independent read as resolving an unknown contributing read."] : []),
    ...(crossRepository(value) ? [workspaceOwnerGuide("full")] : []),
    ...workspaceBaseModuleGuides(value, "full"),
    ...value.links.map(({ link }) => {
      const snapshot = value.repositorySnapshots.find((entry) => entry.repo === link.to.repo)?.snapshot;
      const coordinate = snapshot === undefined ? "snapshot unavailable" : snapshot.kind === "sha" ? `revision ${JSON.stringify(snapshot.sha)}` : `earlier live head ${JSON.stringify(snapshot.head)} stateId ${JSON.stringify(snapshot.stateId)}; a fresh live query must be compared`;
      return `  Destination: repo ${JSON.stringify(link.to.repo)}, ${coordinate}, file ${JSON.stringify(link.to.handler.path)}, symbol ${JSON.stringify(link.to.handler.symbol)}. Use outline or callers on the declared owner.`;
    }),
    workspaceSnapshotGuide(fact, context),
  ];
}

function workspaceOwnerGuide(mode: ResponseMode): string {
  const snapshots = mode === "full" ? "value.repositorySnapshots" : "the repositories line";
  return `  For a related callers or outline query about head evidence choose the recorded owner with repo and its own snapshot from ${snapshots}; base-side modules require their owning walk's recorded merge base instead. An undeclared owner requires a host registration update or an instance bound to that clone. A symbol name may match multiple declarations.`;
}

/** Evidence owned by a repository other than the bound one: only then does a follow-up query need to choose an owner. */
function crossRepository(value: WorkspaceImpactValue): boolean {
  return value.links.length > 0 || Object.entries(value.sections).some(([repo, section]) => repo !== value.trigger.repo && section.status !== "unknown" && section.value.impact !== undefined);
}

function impactHasRecords(value: ImpactValue): boolean {
  return value.seeds.length + value.symbols.length + value.entrypoints.length + (value.modules?.modules.length ?? 0) + (value.changedEntrypoints?.length ?? 0) > 0;
}

function workspaceBaseModuleGuides(value: WorkspaceImpactValue, mode: ResponseMode): string[] {
  return Object.entries(value.sections).flatMap(([repo, section]) => section.status === "unknown" || section.value.impact === undefined ? [] : baseModuleGuides(section.value.impact, repo, section.value.impact.mergeBase ?? (repo === value.trigger.repo ? value.trigger.mergeBase : undefined), `value.sections[${JSON.stringify(repo)}].value.impact`, false, mode === "full"));
}

function workspaceSnapshotGuide(fact: Fact<WorkspaceImpactValue> & { status: "complete" | "partial" }, context?: RenderContext): string {
  const { value } = fact;
  return impactSnapshotGuide(fact.snapshot, value.trigger.mergeBase, context, Object.values(value.sections).some((section) => section.status !== "unknown" && section.value.impact?.modules?.modules.some((module) => module.snapshot === "base")));
}

/**
 * Summary and details carry no fact JSON, so JSON paths belong to full mode, and each omitted category already names
 * the mode that recovers it; the text keeps only the coordinates a follow-up query needs.
 */
function textModeGuide(coordinates: readonly string[]): string[] {
  return ["Investigation guide:", ...coordinates];
}

export function renderImpact(fact: Fact<ImpactValue>, detail: ResponseMode = "summary", context?: RenderContext): string {
  if (detail === "full") return (fact.status === "unknown" ? unknownImpactGuide(fact, detail, context) : localImpactGuide(fact, context)).join("\n");
  const lines = headerLines(fact);
  if (fact.status === "unknown") return [...lines, ...unknownImpactGuide(fact, detail, context)].join("\n");
  const hasOmissions = fact.status === "partial" || fact.value.entrypoints.some((entrypoint) => entrypoint.seeds.length > 1) || consequenceSymbols(fact.value).length > investigationSymbols(fact.value).length || fact.value.modules !== undefined;
  lines.push(...impactBody(fact.value, detail, { kind: "local" }, context), ...impactSeeds(fact.value, detail), ...impactCutBlock(cutsOf(fact), detail, { kind: "fact" }, context, fact.inputs.declaredConfig.walk), ...(hasOmissions ? textModeGuide(localQueryCoordinates(fact, context, detail)) : []));
  return lines.join("\n");
}

/** Importer-specific wording; the shared policy supplies general mode conventions. */
function importerPathRecovery(): string {
  return '    File paths omitted; use mode: "details" to list them, or mode: "full" for the original structured fact.';
}

function importerFiles(entry: ImportedFile, detail: ResponseMode): { lines: string[]; omitted: boolean; listed: boolean } {
  const modules: readonly (readonly [string, readonly string[] | undefined])[] = [
    ["importers", entry.importers], ["reexporters", entry.reexporters], ["dynamic importers", entry.dynamicImporters], ["type importers", entry.typeImporters],
  ];
  const modulePaths = new Set(modules.flatMap(([, files]) => files ?? []));
  const memberships = new Map<string, string[]>();
  const add = (path: string, label: string, index: number): void => {
    const labels = memberships.get(path) ?? [];
    labels.push(`${label}[${index}]`);
    memberships.set(path, labels);
  };
  for (const [label, files] of modules) files?.forEach((path, index) => add(path, label, index));
  entry.users.forEach((path, index) => add(path, modulePaths.has(path) ? "users" : "additional users", index));
  entry.unresolvedNamers.forEach((path, index) => add(path, "unresolved name matches", index));
  const heading = `    related files (${memberships.size} distinct)`;
  const listing = [...memberships].map(([path, labels]) => `    ${JSON.stringify(path)}: ${labels.join(", ")}`);
  const counts = [
    ...modules.flatMap(([label, files]) => files === undefined ? [] : [`    ${label} (${files.length})`]),
    `    users (${entry.users.length}; ${entry.users.filter((path) => !modulePaths.has(path)).length} additional)`,
    `    unresolved name matches (${entry.unresolvedNamers.length})`,
  ];
  const notes = entry.unresolvedNamers.length === 0 ? [] : ["    Unresolved name matches do not establish additional dependencies."];
  const omitted = detail === "summary" && memberships.size > 0 && size([...counts, importerPathRecovery()]) <= size(["    Indices are zero-based positions in each original category; additional users have no module category.", ...listing]);
  return { lines: [heading, ...(omitted ? counts : listing), ...notes], omitted, listed: !omitted && memberships.size > 0 };
}

export function renderImporters(fact: Fact<ImportersValue>, detail: ResponseMode = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : "Select value.files by file; inspect importers and users for recorded links and unresolvedNamers for unconfirmed matches. These are paths only, with no relationship line locations; inspect cuts for partial results.";
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  let omitted = false;
  let explained = false;
  for (const entry of fact.value.files) {
    const block = importerFiles(entry, detail);
    if (block.listed && !explained) {
      lines.push("  Indices are zero-based positions in each original category; additional users have no module category.");
      explained = true;
    }
    lines.push(`  ${entry.file}`, ...block.lines);
    omitted ||= block.omitted;
  }
  if (omitted) lines.push(importerPathRecovery());
  if (fact.value.files.some((entry) => entry.importers.length + entry.users.length + entry.unresolvedNamers.length > 0)) lines.push("  These relationships are paths only; no relationship line locations were recorded.");
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}

/** Each declaration on its own line, its children under it one level deeper. */
function outlineLines(declarations: readonly OutlineDeclaration[], indent: string): string[] {
  return declarations.flatMap((declaration) => [`${indent}${spanText(declaration.line, declaration.endLine)} ${declaration.name} [${declaration.kind}]`, ...outlineLines(declaration.children ?? [], `${indent}  `)]);
}

/**
 * One line per target and statement form, its bindings after a colon: `name:line` when the declaration is in the target
 * file, `name:file:line` when a re-export leads elsewhere, the bare name when no declaration is proven.
 */
function importLines(imports: readonly OutlineImport[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const item of imports) {
    const key = `${importTarget(item)}${item.kind === "reexport" ? " re-export" : ""}${item.form === undefined ? "" : ` ${item.form}`}`;
    const names = groups.get(key) ?? new Set<string>();
    for (const binding of item.bindings) names.add(bindingText(binding, item.target.kind === "repository" ? item.target.file : undefined));
    groups.set(key, names);
  }
  return [...groups].toSorted(([a], [b]) => compareText(a, b)).map(([key, names]) => `      ${key}${names.size === 0 ? "" : `: ${[...names].toSorted(compareText).join(", ")}`}`);
}

/**
 * One line per use: `name → file:line` for a declaration, the package or the global otherwise, then relations and use
 * lines. No use is "nothing" only when no use is unproved.
 */
function useLines(uses: readonly OutlineUse[], unproved: boolean): string[] {
  if (uses.length === 0) return [unproved ? `    ${NO_PROVEN_USE}` : "    uses nothing outside its body"];
  return ["    uses:", ...uses.map((use) => {
    const target = "declaration" in use ? `${use.declaration.name} → ${use.declaration.file}:${use.declaration.line}` : "module" in use ? `${use.module} (package)` : `${use.global} (global)`;
    const at = use.at.length === 0 ? "" : `; at ${[...new Set(use.at.map(({ line }) => line))].join(", ")}`;
    return `      ${target} (${use.relations.join(", ")}${at})`;
  })];
}

function importTarget({ target, specifier }: OutlineImport): string {
  if (target.kind === "repository") return target.file;
  if (target.kind === "external") return `${target.module} (package)`;
  return `${specifier ?? "computed module"} (unresolved: ${target.reason})`;
}

function bindingText({ local, imported, typeOnly, declaration }: OutlineBinding, targetFile: string | undefined): string {
  const name = local === undefined ? imported : local === imported ? local : `${imported} as ${local}`;
  const place = declaration === undefined ? "" : declaration.file === targetFile ? `:${declaration.line}` : `:${declaration.file}:${declaration.line}`;
  return `${typeOnly ? "type " : ""}${name}${place}`;
}

export function renderOutline(fact: Fact<OutlineValue>, detail: ResponseMode = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : fact.value.focus !== undefined ? "Select value.focus: one entry per matched declaration with file, selector, path (a dotted path ye_ast_callers accepts verbatim), ancestors outermost first (kind, name, line, endLine), declaration (kind, name, line, endLine and children of the same shape), omitted, how many of the file's declarations were left out, and uses, what the declaration's own body uses outside itself in order of first use: a declaration (file, name, kind, line, endLine), a module (package) or a global, each with relations (edge kinds) and at (use lines and columns); a member on a local value is not a use. Imports are not listed. Inspect value.unheld for unavailable files and cuts when partial: an unresolved-link cut at[0] \"file::path\" names the focused declaration, then each place \"file:line spelling\" of a use no binding proves." : "Select value.files by file; declarations are the top-level ones and contain name, kind, line, endLine and, when a contains edge places declarations inside one, children of the same shape; imports list each module statement or runtime reference with line, endLine, specifier, kind, form, typeOnly, target (repository file, external module, or unresolved with reason) and bindings (local, imported, typeOnly, and the declaration reached with file, name, kind, line, endLine when proven). Inspect value.unheld for unavailable files and cuts when partial: an unresolved-link cut names a binding whose declaration is not proven.";
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  for (const match of fact.value.focus ?? []) {
    lines.push(`  ${match.file}:${match.selector} matches ${match.path} (${match.omitted} other declarations of the file omitted)`);
    match.ancestors.forEach((ancestor, depth) => lines.push(...outlineLines([ancestor], `    ${"  ".repeat(depth)}`)));
    lines.push(...outlineLines([match.declaration], `    ${"  ".repeat(match.ancestors.length)}`));
    if (match.uses !== undefined) lines.push(...useLines(match.uses, hasUnprovedUses(cutsOf(fact), match.file, match.path)));
  }
  for (const entry of fact.value.files ?? []) {
    lines.push(`  ${entry.file}`);
    lines.push(...(entry.declarations.length === 0 ? ["    declares nothing"] : outlineLines(entry.declarations, "    ")));
    if (entry.imports.length > 0) lines.push("    imports:", ...importLines(entry.imports));
  }
  if (fact.value.unheld.length > 0) lines.push(`unheld files (${fact.value.unheld.length}): ${fact.value.unheld.join(", ")}; their declarations are unknown.`);
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}

const TRACE_FULL_GUIDE = "Select value.steps in pre-order: id, parent, depth, file, symbol, kind, line, endLine, at (the call in the parent), via, deferred, seen (the id that expanded it), leaves (folded terminal declarations with file, start, end) and external (calls leaving the repository by module), alternatives (every body a body-less method may run, when proven; one expands below it via dispatch) and effects (each HTTP request, published message or data operation a declared client makes in its body: kind http with target method, path and base, kind message with target protocol and destination, or kind data with operation, access and optional proven target, at its line). value.roots lists the root step ids per target; value.readingPlan.ranges lists file, start, end and the step ids each range covers, with the total lines. When partial, an unresolved-link cut is at[0] \"file:line spelling\" followed by its candidates, each \"file::Owner.member\" by containment path.";

const TRACE_BRANCHES = "branches are not evaluated: every call in a body is listed, whichever branch makes it";

function traceRootLines(value: TraceValue): string[] {
  const byId = new Map(value.steps.map((step) => [step.id, step]));
  return [
    `roots (${value.steps.filter((step) => step.parent === undefined).length}):`,
    ...value.roots.map(({ target, steps }) => {
      const roots = steps.map((id) => byId.get(id)!).map((step) => `#${step.id} ${step.symbol} [${step.kind}] ${placeText(step.file, step.line, step.endLine)}`);
      return `  ${target} matches ${steps.length}: ${roots.join(", ")}`;
    }),
  ];
}

/** The ranges to open: one per line in details; in summary one line per file, files in their first appearance. */
function readingPlanLines(value: TraceValue, detail: ResponseMode): string[] {
  const { ranges, lines } = value.readingPlan;
  const span = (start: number, end: number): string => (end === start ? `${start}` : `${start}-${end}`);
  const listed = detail === "details"
    ? ranges.map(({ file, start, end }) => `  ${placeText(file, start, end === start ? undefined : end)}`)
    : [...Map.groupBy(ranges, ({ file }) => file)].map(([file, inFile]) => {
        const count = inFile.reduce((sum, { start, end }) => sum + end - start + 1, 0);
        return `  ${file}: ${inFile.map(({ start, end }) => span(start, end)).join(", ")} (${count} ${count === 1 ? "line" : "lines"})`;
      });
  return [`reading plan (${ranges.length} ${ranges.length === 1 ? "range" : "ranges"}, ${lines} lines):`, ...listed];
}

/** Every effect of the trace, in pre-order; a site whose target is undecided is among the cuts. */
function effectLines(steps: readonly TraceStep[]): string[] {
  const effects = steps.flatMap((step) => (step.effects ?? []).map((effect) => `${effectText(effect)} at ${placeText(step.file, effect.line)}`));
  return [`effects (${effects.length})${effects.length === 0 ? "" : `: ${effects.join(", ")}`}`];
}

function externalText(group: ExternalCalls): string {
  return `${group.kind === "import" ? group.module : group.kind}: ${group.names.join(", ")}`;
}

/** Each step on its own line under its parent: the call's line, then its span when its file is not its parent's. */
function traceTreeLines(steps: readonly TraceStep[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.flatMap((step) => {
    const indent = `  ${"  ".repeat(step.depth)}`;
    const parent = step.parent === undefined ? undefined : byId.get(step.parent);
    const span = parent?.file === step.file ? "" : ` (${placeText(step.file, step.line, step.endLine)})`;
    const notes = [step.via !== undefined && step.via !== "call" ? step.via : undefined, step.deferred ? "deferred" : undefined, step.seen === undefined ? undefined : `seen #${step.seen}`].filter((note) => note !== undefined);
    const leaves = step.leaves ?? [];
    return [
      `${indent}#${step.id} ${step.at?.line ?? step.line} ${step.symbol}${step.parent === undefined ? ` [${step.kind}]` : ""}${span}${notes.length === 0 ? "" : ` ${notes.join(", ")}`}`,
      ...(leaves.length === 0 ? [] : [`${indent}  leaves: ${leaves.map((leaf) => (leaf.deferred ? `${leaf.symbol} (deferred)` : leaf.symbol)).join(", ")}`]),
      ...(step.external === undefined ? [] : [`${indent}  external: ${step.external.map(externalText).join("; ")}`]),
      ...(step.effects === undefined ? [] : [`${indent}  effects: ${step.effects.map((effect) => `${effectText(effect)} at ${effect.line}`).join("; ")}`]),
      ...(step.alternatives === undefined ? [] : [`${indent}  dispatch alternatives (${step.alternatives.length}): ${step.alternatives.map((body) => placeText(body.file, body.start, body.end)).join(", ")}`]),
    ];
  });
}

/** An unresolved call of a trace: why it is cut, the place and spelling leading the cut, then its candidates. */
function tracePlaceOf(cut: Cut): { why: string; file: string; line: string; spelling: string; candidates: readonly string[] } {
  const [place = "", ...candidates] = cut.at;
  const { file, line, reason } = placeOf(place);
  return { why: cutReasonText(cut), file, line, spelling: reason, candidates };
}

type TracePlace = ReturnType<typeof tracePlaceOf>;

const TRACE_PLACES_OMITTED = '    Call places omitted; mode "details" lists them, mode "full" gives the structured fact.';

/** The name a call ends with, so calls of one member through different receivers share a line. */
function trailingName(spelling: string): string {
  return /[\w$]+$/.exec(spelling.trimEnd())?.[0] ?? spelling.trim();
}

/** Each unresolved call with every candidate. */
function tracePlaceLine(place: TracePlace): string {
  return `    ${place.why}: ${place.file}:${place.line} ${place.spelling}${place.candidates.length === 0 ? "" : ` (${place.candidates.join(", ")})`}`;
}

/** A candidate without its file: `src/a.ts::Store.get` reads `Store.get`. */
function candidatePath(candidate: string): string {
  const separator = candidate.indexOf("::");
  return separator === -1 ? candidate : candidate.slice(separator + 2);
}

/**
 * One line per reason, trailing name and candidate set, most calls first, then by name: why they are cut, its calls, its
 * files and its candidates by containment path, counted when that is shorter or when two candidates share a path.
 */
function traceCallGroupLines(places: readonly TracePlace[]): string[] {
  const groups = [...Map.groupBy(places, (place) => JSON.stringify([place.why, trailingName(place.spelling), place.candidates.toSorted(compareText)]))]
    .map(([key, inGroup]) => ({ key, why: inGroup[0]!.why, name: trailingName(inGroup[0]!.spelling), candidates: inGroup[0]!.candidates.toSorted(compareText), calls: inGroup.length, files: new Set(inGroup.map(({ file }) => file)).size }))
    .sort((a, b) => b.calls - a.calls || compareText(a.name, b.name) || compareText(a.key, b.key));
  return groups.map(({ why, name, candidates, calls, files }) => {
    const shown = [...new Set(candidates.map(candidatePath))].sort(compareText);
    const listed = shown.join(", ");
    const counted = `${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"}`;
    const listable = shown.length === candidates.length && preferShorterText(listed, counted) === listed;
    const could = candidates.length === 0 ? "" : listable ? ` → could be: ${listed}` : ` → ${counted}`;
    return `    ${why}: ${name} ×${calls} in ${files} ${files === 1 ? "file" : "files"}${could}`;
  });
}

/** The calls no rule settled: grouped by call in summary, then the modes that list each place; one per line with every candidate in details. */
function traceCutLines(cuts: readonly Cut[], detail: ResponseMode): string[] {
  const unresolved = cuts.filter((cut) => cut.kind === "unresolved-link").map(tracePlaceOf);
  const lines = cutLines(cuts.filter((cut) => cut.kind !== "unresolved-link"), detail);
  if (unresolved.length === 0) return lines.length === 0 ? [] : [CUTS, ...lines];
  const places = detail === "details" ? unresolved.map(tracePlaceLine) : [...traceCallGroupLines(unresolved), TRACE_PLACES_OMITTED];
  return [CUTS, ...lines, `  unresolved-link (${unresolved.length} ${unresolved.length === 1 ? "call" : "calls"}):`, ...places];
}

export function renderTrace(fact: Fact<TraceValue>, detail: ResponseMode = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : TRACE_FULL_GUIDE;
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  lines.push(...traceRootLines(fact.value), ...effectLines(fact.value.steps), TRACE_BRANCHES, ...readingPlanLines(fact.value, detail));
  if (detail === "details") lines.push("steps:", ...traceTreeLines(fact.value.steps));
  lines.push(...traceCutLines(cutsOf(fact), detail));
  return lines.join("\n");
}

/** One link as every answer lists it: its number, both ends, the basis and what the answer adds about how it was reached. */
function linkLine(link: Link, number: number | undefined, reached = ""): string {
  const confidence = link.confidence < 1 ? `, confidence ${link.confidence}` : "";
  const profiles = link.profiles === undefined ? "" : `, under ${link.profiles.join(", ")}`;
  return `  - ${number}. ${link.from.repo}:${placeText(link.from.file, link.from.line)} ${link.from.symbol} -> ${link.to.repo} ${link.to.name} -> ${handlerText(link.to.handler)} (${link.basis}${confidence}${profiles}${reached})`;
}

function impactedLinkLine({ link, direction, reach, operations }: ImpactedLink, indexes: ReadonlyMap<string, number>): string {
  const chain = reach.length === 0 ? "" : `; reach: ${reach.map((id) => indexes.get(id) ?? id).join(", ")}`;
  return `${linkLine(link, indexes.get(link.id), `, ${direction}${chain}`)}${(operations ?? []).map((operation) => `; calls the operation ${changedContractText(operation)}`).join("")} [linkId ${JSON.stringify(link.id)}]`;
}

/**
 * The links of a workspace map: each one in details; in summary the count per caller, callee and transport when that is
 * no longer than the list (RFC-0017), with the call sites the join reached without a link always listed.
 */
function linkMapLines(links: readonly Link[], unlinked: readonly UnlinkedCallSite[], detail: ResponseMode): string[] {
  const literal = links.map((link, index) => linkLine(link, index + 1));
  const pairs = new Map<string, number>();
  for (const { from, to, transport } of links) pairs.set(`${from.repo} -> ${to.repo} ${transport}`, (pairs.get(`${from.repo} -> ${to.repo} ${transport}`) ?? 0) + 1);
  const counted = [...[...pairs].map(([pair, count]) => `  - ${pair}: ${count}`), `  ${categoryRecovery({ details: "lists each link" })}`];
  const listed = detail === "details" || links.length === 0 || size(literal) < size(counted) ? literal : counted;
  return [
    `links between the repositories read (${links.length}):`, ...listed,
    ...(unlinked.length === 0 ? [] : [`call sites the join reached without a link (${unlinked.length}):`, ...unlinked.map(({ from, transport, outcome, name, repos, routes }) => `  - ${from.repo}:${placeText(from.file, from.line)} ${from.symbol} ${transport} ${name}: ${outcome}${repos === undefined ? "" : ` (${repos.join(", ")})`}${routes === undefined ? "" : ` routes ${routes.join(", ")}`}`)]),
  ];
}

function callSiteLine(site: CallSite): string {
  const { target } = site;
  const named = target.status !== "complete" ? "unknown" : "path" in target.value ? `${target.value.method} ${target.value.path}` : `${target.value.protocol} ${target.value.destination}`;
  return `      - ${placeText(site.file, site.line)} ${site.symbol} -> ${named}`;
}

function callSiteBlock(label: string, sites: readonly CallSite[]): string[] {
  return sites.length === 0 ? [] : [`    ${label} (${sites.length}):`, ...sites.map(callSiteLine)];
}

function repoImpactLines(repo: string, section: Fact<RepoImpact>, detail: ResponseMode, bound: string, context?: RenderContext): string[] {
  if (section.status === "unknown") return [`  ${repo}: unknown (${section.reason})`];
  const { value } = section;
  return [
    `  ${repo}: ${section.status}`,
    ...value.reads.flatMap(({ kind, fact }) => fact.status === "unknown" ? [`    ${kind}: unknown (${fact.reason})`] : []),
    ...callSiteBlock("call sites that land in what the walk reached", value.callSites),
    ...(value.impact === undefined || repo === bound ? [] : impactBody(value.impact, detail, { kind: "section", repo }, context, false).map((line) => `    ${line}`)),
    ...callSiteBlock("unmatched", value.unmatched),
    ...callSiteBlock("external", value.external),
    ...(value.unresolved.length === 0 ? [] : [`    unresolved call sites (${value.unresolved.length}):`, ...unresolvedListing(value.unresolved, detail).map((line) => `  ${line}`)]),
  ];
}

export function renderWorkspaceImpact(fact: Fact<WorkspaceImpactValue>, detail: ResponseMode = "summary", context?: RenderContext): string {
  if (detail === "full") return (fact.status === "unknown" ? unknownImpactGuide(fact, detail, context) : workspaceImpactGuide(fact, context)).join("\n");
  const lines = headerLines(fact, fact.status === "unknown" ? {} : { unknownSection: unknownSectionIn(fact.value.sections) });
  if (fact.status === "unknown") return [...lines, ...unknownImpactGuide(fact, detail, context)].join("\n");
  const { value } = fact;
  const trigger = value.sections[value.trigger.repo];
  lines.push(counted("repositories", value.repositorySnapshots.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  lines.push(sourceLine(value.workspace.source));
  lines.push(`bound repository: ${value.trigger.repo}`);
  lines.push(`gateway prefixes (${value.workspace.gateways.length}):`, ...value.workspace.gateways.map(({ prefix, repo, basis }) => `  - ${prefix} -> ${repo} (${basis})`));
  const stale = value.workspace.unmatchedGateways;
  if (stale.length > 0) lines.push(`declared gateways that matched nothing (${stale.length}):`, ...stale.map(({ prefix, repo }) => `  - ${prefix} -> ${repo}`));
  if (trigger !== undefined && trigger.status !== "unknown" && trigger.value.impact !== undefined) lines.push(...impactBody(trigger.value.impact, detail, { kind: "section", repo: value.trigger.repo }, context));
  const linkIndexes = new Map(value.links.map(({ link }, index) => [link.id, index + 1]));
  if (value.links.some(({ direction }) => direction === "downstream")) lines.push("Downstream links identify invoked destinations; a destination is not necessarily affected by the change.");
  lines.push(`links across repositories (${value.links.length}):${value.links.some(({ reach }) => reach.length > 0) ? " reach lists link numbers nearest to the change first" : ""}`, ...value.links.map((link) => impactedLinkLine(link, linkIndexes)));
  lines.push("per repository:", ...value.workspace.repos.flatMap((repo) => (value.sections[repo] === undefined ? [] : repoImpactLines(repo, value.sections[repo] as Fact<RepoImpact>, detail, value.trigger.repo, context))));
  const unserved = counted("no local repository serves", value.workspace.unserved);
  const unservedSummary = `no local repository serves (${value.workspace.unserved.length}): ${categoryRecovery({ full: "includes all" })} names`;
  lines.push(value.workspace.unserved.length > 0 && size([unservedSummary]) <= size([unserved]) ? unservedSummary : unserved);
  if (value.workspace.unserved.length > 0 || stale.length > 0) lines.push(DECISIONS_HINT);
  lines.push("walk origins:", ...value.workspace.repos.flatMap((repo) => {
    const section = value.sections[repo];
    if (section === undefined || section.status === "unknown" || section.value.impact === undefined) return [];
    return [`  ${repo}:`, ...impactSeeds(section.value.impact, detail).map((line) => `    ${line}`)];
  }));
  lines.push(...impactCutBlock(cutsOf(fact), detail, { kind: "fact" }, context, fact.inputs.declaredConfig.walk));
  for (const repo of value.workspace.repos) {
    const section = value.sections[repo];
    if (section === undefined || section.status === "unknown") continue;
    if (section.status === "partial") lines.push(`cuts for repository ${repo}:`, ...impactCutBlock(section.cuts, detail, { kind: "section", repo }, context, section.inputs.declaredConfig.walk).slice(1));
    section.value.reads.forEach(({ fact: read }, index) => {
      if (read.status === "partial") lines.push(`cuts for repository ${repo} read ${index}:`, ...impactCutBlock(read.cuts, detail, { kind: "read", repo, index }, context, read.inputs.declaredConfig.walk).slice(1));
    });
  }
  const recorded = value.links.length > 0 || Object.values(value.sections).some((section) => section.status !== "unknown" && section.value.impact !== undefined && impactHasRecords(section.value.impact));
  if (fact.status === "partial" || recorded) lines.push(...textModeGuide([...(crossRepository(value) ? [workspaceOwnerGuide(detail)] : []), ...workspaceBaseModuleGuides(value, detail), workspaceSnapshotGuide(fact, context)]));
  return lines.join("\n");
}

/** The line that opens the text of a live answer the working tree has moved past. */
export function renderStale(notice: LiveStaleNotice): string {
  return `stale: the working tree changed after this answer, which reflects state ${notice.stateId}: ${notice.changed.join(", ")}`;
}

/** A remote the query refreshed: whether it verified it, and why not. */
function remoteLine({ repo, url, freshness }: WorkspaceRefresh["freshness"][number]): string {
  if (freshness.status === "verified") return `remote: ${repo} ${url} verified`;
  const last = freshness.lastVerifiedAt === undefined ? "" : `, last verified ${freshness.lastVerifiedAt}`;
  return `remote: ${repo} ${url} unverified (${freshness.reason}${last})${freshness.detail === undefined ? "" : `: ${freshness.detail}`}`;
}

/** The sha a refreshed repository was read at, and the rule step that chose it. */
function pinnedLine({ repo, asked, step, consulted, tie, sha }: RepositoryResolution): string {
  const asking = asked === undefined ? "" : ` asked ${asked}`;
  const refs = consulted.length === 0 ? "" : ` (consulted ${consulted.map((ref) => (ref.sha === undefined ? ref.branch : `${ref.branch} ${ref.sha}`)).join(", ")})`;
  const tied = tie === undefined ? "" : ` (tie: ${tie.join(", ")})`;
  return `pinned: ${repo}${asking} by ${step} -> ${sha ?? "unpinned"}${refs}${tied}`;
}

/** The response-level lines a refreshed answer opens with, before the fact. */
export function renderRefresh(refresh: WorkspaceRefresh): string[] {
  return [...refresh.freshness.map(remoteLine), ...refresh.resolution.map(pinnedLine)];
}

function candidateLine(candidate: NameCandidate): string {
  return `  - ${candidate.name} -> ${candidate.repo} (${candidate.basis}${candidate.evidence.length === 0 ? "" : `; ${candidate.evidence.map(repositoryEvidenceText).join(", ")}`})`;
}

/** The order the text lists outward kinds in: what the repository calls first, what it consumes last. */
const OUTWARD_ORDER: Readonly<Record<OutwardKind, number>> = {
  "path-prefix": 0,
  "http-host": 1,
  "configuration-url": 2,
  destination: 3,
  registry: 4,
  remote: 5,
  dependency: 6,
};

/** The order the text lists decisions in: a form is filled top-down by what blocks the answer, then by what locates a clone. */
const DECISION_ORDER: Readonly<Record<DecisionKind, number>> = {
  trust: 0,
  gateway: 1,
  library: 2,
  repository: 3,
  membership: 4,
  remote: 5,
  revision: 6,
};

/** The items grouped by the rank their key holds in `order`, the groups in that order. */
function groupedByRank<T, K extends string>(items: readonly T[], keyOf: (item: T) => K, order: Readonly<Record<K, number>>): [K, T[]][] {
  return [...Map.groupBy(items, keyOf)].toSorted(([a], [b]) => order[a] - order[b]);
}

/** The names of one repository under their kind: a summary lists a dependency only when a repository given serves it,
 * and counts the rest, since a dependency is what the repository consumes and not what it calls. */
function namesBlock(names: readonly OutwardName[], served: ReadonlySet<string>, detail: ResponseMode, indexed: false | "complete" | "locations" = false): string[] {
  const entries = names.map((name, index) => ({ name, index }));
  return groupedByRank(entries, (entry) => entry.name.kind, OUTWARD_ORDER).flatMap(([kind, ofKind]) => {
    const listed = detail === "details" || kind !== "dependency" ? ofKind : ofKind.filter(({ name }) => served.has(name.name));
    const counted = ofKind.length - listed.length;
    const head =
      counted === 0 ? `    ${kind} (${ofKind.length}):`
      : counted === ofKind.length ? `    ${kind} (${ofKind.length}): no repository given serves them; ${categoryRecovery({ details: "lists them", full: "retains all recorded names" })}`
      : `    ${kind} (${ofKind.length}): ${counted} no repository given serves; ${categoryRecovery({ details: "lists them", full: "retains all recorded names" })}`;
    const line = ({ name, index }: { name: OutwardName; index: number }): string => `      - ${indexed ? `[${index}] ` : ""}${name.name} (${indexed === "complete" ? JSON.stringify(name.evidence) : name.evidence.map(evidenceText).join(", ")})`;
    const listing = [head, ...ofKind.map(line)];
    const summarized = [head, ...listed.map(line)];
    return counted === 0 || size(summarized) <= size(listing) ? summarized : listing;
  });
}

/** The names no repository given serves: a summary lists what the repository could call and counts the coordinates it consumes. */
function unservedBlock(unserved: readonly RepositoryOutwardName[], detail: ResponseMode): string[] {
  if (unserved.length === 0) return ["no local repository serves (0):", NONE];
  const listed = detail === "details" ? unserved : unserved.filter((name) => name.kind !== "dependency");
  const counted = unserved.length - listed.length;
  const head = `no local repository serves (${unserved.length}):`;
  const listing = [head, ...unserved.map((name) => `  - ${name.kind} ${name.name}${name.evidence.length === 0 ? "" : ` (${name.evidence.map(repositoryEvidenceText).join(", ")})`}`)];
  if (counted === 0) return listing;
  const summarized = [`${head} ${counted} dependency counted; ${categoryRecovery({ details: "lists them", full: "retains all recorded names" })}`, ...listed.map((name) => `  - ${name.kind} ${name.name}${name.evidence.length === 0 ? "" : ` (${name.evidence.map(repositoryEvidenceText).join(", ")})`}`)];
  return size(summarized) <= size(listing) ? summarized : listing;
}

/** The unresolved call sites under the file that holds them, sorted, each with the request it writes when the code states it. */
function unresolvedListing(sites: readonly UnresolvedCallSite[], detail: ResponseMode): string[] {
  const sorted = [...sites].toSorted(compareUnresolvedCallSites);
  return [...Map.groupBy(sorted, (site) => site.path)].flatMap(([path, inFile]) => [
    `    ${path}`,
    ...[...Map.groupBy(inFile, (site) => `${site.reason}${site.diagnostic === undefined ? "" : `/${site.diagnostic.cause}`}${site.diagnostic?.source === undefined ? "" : ` source=${site.diagnostic.source}`}`)].flatMap(([reason, group]) => [
      ...(detail === "details" ? [`      ${reason}:`] : []),
      ...group.map((site) => unresolvedLine(site, detail)),
    ]),
  ]);
}

function unresolvedLine(site: UnresolvedCallSite, detail: ResponseMode): string {
  const through = site.via === undefined ? "" : `, through ${site.via}`;
  const stated = site.stated === undefined ? "" : ` ${site.stated.method} ${site.stated.path}`;
  const evidence = detail === "details" ? ` <- ${site.evidence.map(evidenceText).join(", ")}${site.diagnostic?.unreadableSources === undefined ? "" : `; unreadable libraries: ${site.diagnostic.unreadableSources.map(evidenceText).join(", ")}`}${site.diagnostic?.alternatives === undefined ? "" : `; chosen at run time, declared alternatives: ${site.diagnostic.alternatives.join(", ")}`}` : ` ${unresolvedLabel(site)}`;
  return `      ${spanText(site.line, site.endLine)} ${site.symbol} (${site.transport}${through})${stated}${evidence}`;
}

/** The call sites no repository given decides, so the caller settles each one by reading its declaration, never the file. */
function unresolvedBlock(value: Omit<WorkspaceValue, "repositories">, detail: ResponseMode): string[] {
  const sections = value.workspace.repos.flatMap((repo) => {
    const section = value.sections[repo];
    return section === undefined || section.status === "unknown" || section.value.unresolved.length === 0 ? [] : [[repo, section.value.unresolved] as const];
  });
  if (sections.length === 0) return [];
  return [
    `unresolved call sites (${sections.reduce((total, [, sites]) => total + sites.length, 0)}):`,
    ...sections.flatMap(([repo, sites]) => [`  ${repo}:`, ...unresolvedListing(sites, detail)]),
  ];
}

export function renderWorkspace(fact: Fact<Omit<WorkspaceValue, "repositories">>, detail: ResponseMode = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : "Match value.sections by repository and check each section status, reason and cuts; value.repositorySnapshots identifies each revision. Inspect value.candidates by name and repo for basis and evidence, value.unserved for unmatched names, value.links for the links between repositories and value.unlinked for the call sites without one.";
  const lines = headerLines(fact, fact.status === "unknown" ? {} : {
    undecided: Object.values(fact.value.sections).reduce((total, section) => total + (section.status === "unknown" ? 0 : section.value.unresolved.length), 0),
    unknownSection: unknownSectionIn(fact.value.sections),
  });
  if (fact.status === "unknown") return lines.join("\n");
  const { value } = fact;
  const served = new Set(value.candidates.map((candidate) => candidate.name));
  const sections = value.workspace.repos.flatMap((repo) => {
    const section = value.sections[repo];
    return section === undefined || section.status === "unknown" ? [] : [[repo, section.value.names] as const];
  });
  lines.push(counted("repositories", value.repositorySnapshots.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  lines.push(sourceLine(value.workspace.source, "repos"));
  for (const repo of value.workspace.repos) {
    const section = value.sections[repo];
    if (section?.status === "unknown") lines.push(`  ${repo}: unknown (${section.reason})`);
  }
  const heading = `outward names (${sections.reduce((total, [, names]) => total + names.length, 0)}):`;
  const candidates = [`served by a local repository (${value.candidates.length}):`, ...value.candidates.map(candidateLine)];
  const literalNames = [heading, ...sections.flatMap(([repo, names]) => [`  ${repo}:`, ...namesBlock(names, served, detail)])];
  const literalUnserved = unservedBlock(value.unserved, detail);
  const repos = value.workspace.repos;
  const validOwner = (repo: string): boolean => {
    const section = value.sections[repo];
    const snapshots = value.repositorySnapshots.filter((item) => item.repo === repo);
    return repos.filter((item) => item === repo).length === 1 && section !== undefined && section.status !== "unknown" && section.snapshot.repo === repo && snapshots.length === 1 && snapshots[0]!.snapshot.repo === repo && canonicalJson(section.snapshot) === canonicalJson(snapshots[0]!.snapshot);
  };
  const qualified = sections.flatMap(([repo, names]) => names.map((name, index) => ({ repo, index, name: { ...name, evidence: name.evidence.map((evidence) => ({ ...evidence, repo })) } })));
  const ordered = sections.flatMap(([repo, names]) => groupedByRank(names, (name) => name.kind, OUTWARD_ORDER).flatMap(([, group]) => group.map((name) => ({ ...name, evidence: name.evidence.map((evidence) => ({ ...evidence, repo })) }))));
  const exact = repos.length > 0 && repos.every(validOwner) && qualified.length > 0 && qualified.every(({ name }) => name.evidence.length > 0 && name.evidence.every((evidence) => evidence.via === undefined && evidence.confidence === undefined))
    && (detail === "details" || qualified.every(({ name }) => name.kind !== "dependency" || served.has(name.name)))
    && canonicalJson(ordered) === canonicalJson(value.unserved);
  const reference = [`no local repository serves (${value.unserved.length}): all recorded outward names are unserved; see ${repos.length === 1 ? repos[0] : "the repository sections"} above.`];
  const normal = [...literalNames, ...candidates, ...(exact && size(reference) < size(literalUnserved) ? reference : literalUnserved)];
  const indexedNames = [heading, ...sections.flatMap(([repo, names]) => [`  ${repo}:`, ...namesBlock(names, served, "details", "complete")])];
  const available = new Map<string, (typeof qualified)[number]>();
  for (const item of qualified) {
    if (item.name.evidence.length === 0 || !validOwner(item.repo)) continue;
    const key = canonicalJson(item.name);
    if (!available.has(key)) available.set(key, item);
  }
  const refs = value.unserved.map((name) => name.evidence.length === 0 ? undefined : available.get(canonicalJson(name)));
  const mixed = [
    ...indexedNames, ...candidates,
    `no local repository serves (${value.unserved.length}): outward references identify the repository and name index above, in unserved order.`,
    ...value.unserved.map((name, index) => {
      const ref = refs[index];
      return ref === undefined ? `  - ${name.kind} ${name.name}${name.evidence.length === 0 ? "" : ` (${name.evidence.map(repositoryEvidenceText).join(", ")})`}` : `  - outward ${JSON.stringify(ref.repo)}[${ref.index}]`;
    }),
  ];
  let best = refs.some((ref) => ref !== undefined) && size(mixed) < size(normal) ? mixed : normal;
  // Location-only rows can be referenced without repeating evidence metadata only when no metadata is present.
  if (detail === "details" && refs.length > 0 && refs.every((ref) => ref !== undefined) && qualified.every(({ name }) => name.evidence.every((evidence) => evidence.via === undefined && evidence.confidence === undefined))) {
    const order: { repo: string; indexes: number[] }[] = [];
    for (const ref of refs) {
      const previous = order.at(-1);
      if (previous?.repo === ref!.repo) previous.indexes.push(ref!.index);
      else order.push({ repo: ref!.repo, indexes: [ref!.index] });
    }
    const permutation = [
      heading, ...sections.flatMap(([repo, names]) => [`  ${repo}:`, ...namesBlock(names, served, "details", "locations")]), ...candidates,
      `no local repository serves (${value.unserved.length}): outward indexes identify the name rows above, in unserved order.`,
      ...order.map(({ repo, indexes }) => `  outward ${JSON.stringify(repo)} indexes ${JSON.stringify(indexes)}`),
    ];
    if (size(permutation) < size(best)) best = permutation;
  }
  lines.push(...best);
  if (value.unserved.length > 0) lines.push(DECISIONS_HINT);
  lines.push(...linkMapLines(value.links, value.unlinked, detail));
  lines.push(...unresolvedBlock(value, detail));
  lines.push(...cutsBlock(cutsOf(fact), detail));
  for (const [repo, section] of Object.entries(value.sections)) {
    if (section.status !== "partial") continue;
    const unresolved = section.cuts.filter((cut) => cut.kind === "unresolved-link");
    const other = section.cuts.filter((cut) => cut.kind !== "unresolved-link");
    lines.push(`cuts for repository ${repo}:`, ...cutsBlock(other, detail).slice(1), ...impactCuts(unresolved, detail).slice(1));
  }
  return lines.join("\n");
}

function repositoryEvidenceText(evidence: RepositoryEvidence): string {
  return `${evidence.repo}:${evidenceText(evidence)}`;
}

function optionLine(option: DecisionOption): string {
  const facts = [...(option.basis === undefined ? [] : [option.basis]), ...(option.recommended ? ["recommended"] : []), ...option.evidence.map(repositoryEvidenceText)];
  return `      - ${option.value}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`;
}

/** One gap: what is missing, the places that motivated it, every option, and whether a value no fact states answers it. */
function decisionLines(decision: Decision): string[] {
  return [
    `    ${decision.subject}`,
    ...(decision.evidence.length === 0 ? [] : [`      evidence: ${decision.evidence.map(repositoryEvidenceText).join(", ")}`]),
    ...decision.options.map(optionLine),
    ...(decision.allowsFreeText ? ["      free text: an answer no fact states is accepted"] : []),
  ];
}

/** Whether a decision is a dependency coordinate no repository given serves: free text only, so a summary counts it. */
function dependencyGap(decision: Decision): boolean {
  const kinds = decision.outwardKinds ?? [];
  return decision.kind === "repository" && decision.options.length === 0 && kinds.length > 0 && kinds.every((kind) => kind === "dependency");
}

/** The gaps under their kind, the ones that block first: a summary counts the dependency coordinates a form cannot answer. */
function decisionsBlock(decisions: readonly Decision[], detail: ResponseMode): string[] {
  const groups = groupedByRank(decisions, (decision) => decision.kind, DECISION_ORDER);
  const literal = groups.flatMap(([kind, ofKind]) => {
    const listed = detail === "details" ? ofKind : ofKind.filter((decision) => !dependencyGap(decision));
    const counted = ofKind.length - listed.length;
    const head = counted === 0 ? `  ${kind} (${ofKind.length}):` : `  ${kind} (${ofKind.length}): ${counted} dependency counted (free text only); ${categoryRecovery({ details: "lists them" })}`;
    const listing = [head, ...ofKind.flatMap(decisionLines)];
    const summarized = [head, ...listed.flatMap(decisionLines)];
    return counted === 0 || size(summarized) <= size(listing) ? summarized : listing;
  });
  const visible = groups.flatMap(([, ofKind]) => {
    const listed = detail === "details" ? ofKind : ofKind.filter((decision) => !dependencyGap(decision));
    const listing = ofKind.flatMap(decisionLines);
    const summarized = listed.flatMap(decisionLines);
    return listed.length === ofKind.length || size(summarized) <= size(listing) ? listed : ofKind;
  });
  const counts = new Map<string, number>();
  for (const decision of visible) if (decision.evidence.length) {
    const key = canonicalJson(decision.evidence);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = new Map<string, number>();
  const definitions: string[] = [];
  for (const decision of visible) {
    const key = canonicalJson(decision.evidence);
    if ((counts.get(key) ?? 0) > 1 && !shared.has(key)) {
      shared.set(key, shared.size + 1);
      definitions.push(`  evidence ${shared.size}: ${decision.evidence.map(repositoryEvidenceText).join(", ")}`);
    }
  }
  const shareFreeText = visible.filter((decision) => decision.allowsFreeText).length > 1;
  if (definitions.length === 0 && !shareFreeText) return literal;
  if (shareFreeText) definitions.push("  free text allowed: an answer no fact states is accepted for each marked decision.");
  const expanded = groups.flatMap(([kind, ofKind]) => {
    const shown = visible.filter((decision) => ofKind.includes(decision));
    const counted = ofKind.length - shown.length;
    const head = counted === 0 ? `  ${kind} (${ofKind.length}):` : `  ${kind} (${ofKind.length}): ${counted} dependency counted (free text only); ${categoryRecovery({ details: "lists them" })}`;
    return [head, ...shown.flatMap((decision) => {
      const reference = shared.get(canonicalJson(decision.evidence));
      return [`    ${decision.subject}`, ...(decision.evidence.length === 0 ? [] : [reference === undefined ? `      evidence: ${decision.evidence.map(repositoryEvidenceText).join(", ")}` : `      evidence ${reference}`]), ...decision.options.map(optionLine), ...(decision.allowsFreeText ? [shareFreeText ? "      free text allowed" : "      free text: an answer no fact states is accepted"] : [])];
    })];
  });
  const compact = [...definitions, ...expanded];
  return size(compact) < size(literal) ? compact : literal;
}

export function renderDecisions(fact: Fact<DecisionValue>, detail: ResponseMode = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : "Select value.decisions by kind and subject; inspect evidence, options[].basis and options[].recommended. Match evidence repositories to value.repositories snapshots. value.unresolved lists the undecided call sites by repository.";
  const lines = headerLines(fact, fact.status === "unknown" ? {} : { undecided: fact.value.unresolved.length });
  if (fact.status === "unknown") return lines.join("\n");
  const { value } = fact;
  lines.push(counted("repositories", value.repositories.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  lines.push(sourceLine(value.source, "repos"));
  lines.push(`decisions (${value.decisions.length}):`, ...decisionsBlock(value.decisions, detail));
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}


const CONSEQUENCES_FULL_GUIDE = "Match value.answers by index (the order asked, or sorted by operation and property for a change) and check each answer's status, reason and cuts; findings[].value.chain and verdict.witness hold the chains and witnesses, and an unknown finding carries its reason and places. A change's value.change.derivation holds every classified difference (rule, level, operation, property, places) and the derivation frontiers; answers[].derivedFrom.rules names the rules a derived answer follows; value.repositorySnapshots names the snapshot of every repository read.";

/** The counted text when it is no longer than listing what it counts, the listing otherwise; a tie keeps the count (RFC-0017 section 1). Details always lists. */
function elided(counts: readonly string[], listing: readonly string[], detail: ResponseMode): string[] {
  return detail === "details" || size(listing) < size(counts) ? [...listing] : [...counts];
}

function hypothesisText(hypothesis: HypothesisAnswer["hypothesis"]): string {
  const entries = (Array.isArray(hypothesis.change) ? hypothesis.change : [hypothesis.change]) as readonly unknown[];
  return `${hypothesis.method} ${hypothesis.path} ${hypothesis.target} ${hypothesis.property} ${entries.map((entry) => (typeof entry === "string" ? entry : canonicalJson(entry))).join(" + ")}`;
}

function countedBy(labels: readonly string[]): string {
  return [...Map.groupBy(labels, (label) => label)].toSorted(([a, ofA], [b, ofB]) => ofB.length - ofA.length || compareText(a, b)).map(([label, group]) => `${group.length} ${label}`).join(", ");
}

const findingKind = (finding: ConsequenceFinding<UseConsequence | ProducerConsequence>): string =>
  finding.status === "unknown" ? `unknown (${finding.reason})` : finding.value.verdict.kind;

/** How an answer names the empty access path, which is the body itself. */
export const ROOT_PATH_TEXT = "(whole body)";
const accessPathText = (path: string): string => (path === "" ? ROOT_PATH_TEXT : path);

function findingLine(finding: ConsequenceFinding<UseConsequence | ProducerConsequence>): string {
  const places = finding.evidence.map(repositoryEvidenceText).join(", ");
  if (finding.status === "unknown") return `    - unknown (${finding.reason})${places === "" ? "" : ` at ${places}`}`;
  const { value } = finding;
  const call = `${value.link.call.file}:${value.link.call.line} ${value.link.call.symbol} -> ${value.link.handler.repo}:${placeText(value.link.handler.path, value.link.handler.line)} ${value.link.handler.symbol}`;
  if ("operation" in value) {
    const { verdict } = value;
    return `    - use ${verdict.kind}${verdict.kind === "review" ? ` (${verdict.reason})` : ""} at ${places}; reads ${accessPathText(value.path)}, changed ${accessPathText(value.changed)}; via ${call}${verdict.kind === "incompatible" ? `; witness ${verdict.witness}` : ""}`;
  }
  const { verdict } = value;
  const witness = verdict.kind === "incompatible" ? `; witness ${verdict.witness.value} at ${verdict.witness.at.path}:${verdict.witness.at.line}` : "";
  return `    - producer ${verdict.kind}${verdict.kind === "review" ? ` (${verdict.reason})` : ""} at ${places || value.repo}; writes ${accessPathText(value.path)}; via ${call}${witness}`;
}

function answerLines(answer: HypothesisAnswer, index: number, detail: ResponseMode): string[] {
  const head = `  ${index + 1}. ${hypothesisText(answer.hypothesis)}`;
  if (answer.status === "unknown") return [`${head}: unknown (${answer.reason}): ${answer.detail}`];
  const status = answer.status === "partial" ? `partial (cuts: ${cutCounts(answer.cuts)})` : completeText(undecidedOf(answer.findings));
  const open = `${head}: ${status}${answer.silent === undefined ? "" : `; ${answer.silent} silent uses`}`;
  const listing = [open, ...(answer.findings.length === 0 ? ["    (no findings)"] : answer.findings.map(findingLine))];
  const counts = [`${open}; ${answer.findings.length === 0 ? "no findings" : `${answer.findings.length} findings: ${countedBy(answer.findings.map(findingKind))}`}${answer.findings.length === 0 ? "" : `; ${categoryRecovery({ details: "lists each with its place", full: "retains the chains and witnesses" })}`}`];
  return elided(counts, listing, detail);
}

function frontierLine(frontier: ChangeFrontier): string {
  const subject = [frontier.operation, frontier.target, frontier.property, frontier.side === undefined ? undefined : `at ${frontier.side}`].filter((part) => part !== undefined && part !== "").join(" ");
  return `    - ${frontier.kind} (${frontier.reason})${subject === "" ? "" : ` ${subject}`}${frontier.detail === undefined ? "" : `: ${frontier.detail}`}${frontier.evidence.length === 0 ? "" : ` at ${frontier.evidence.map(repositoryEvidenceText).join(", ")}`}`;
}

function differenceLine({ level, rule, operation, property, subject, base, head, places }: ClassifiedDifference): string {
  const value = (written: unknown) => (written === undefined ? "absent" : JSON.stringify(written));
  const about = subject === undefined ? "" : base === undefined && head === undefined ? ` (${subject})` : ` (${subject}: ${value(base)} -> ${value(head)})`;
  return `    - ${level} ${rule} ${operation}${property ? ` ${property}` : ""}${about} at ${repositoryEvidenceText((places.head ?? places.base)!)}`;
}

function derivationLines(value: NonNullable<ConsequencesValue["change"]>, detail: ResponseMode): string[] {
  const { derivation } = value;
  const lines = [`change: ${value.base} -> ${value.head} (commits ${value.snapshots.base} -> ${value.snapshots.head})`, "derivation:", ...statusLines(derivation, "  ")];
  if (derivation.status === "unknown") return lines;
  const { differences, frontiers } = derivation.value;
  const classified = [`  differences (${differences.length}): ${countedBy(differences.map(({ level }) => level))}; ${categoryRecovery({ details: "lists each with its rule and place" })}`];
  lines.push(...(differences.length === 0 ? ["  differences (0):"] : elided(classified, [`  differences (${differences.length}):`, ...differences.map(differenceLine)], detail)));
  const counts = [`  frontiers (${frontiers.length}): ${countedBy(frontiers.map((frontier) => `${frontier.kind} (${frontier.reason})`))}; ${categoryRecovery({ details: "lists them with their places" })}`];
  lines.push(...(frontiers.length === 0 ? ["  frontiers (0):"] : elided(counts, [`  frontiers (${frontiers.length}):`, ...frontiers.map(frontierLine)], detail)));
  return lines;
}

/** The undecided findings of every answer, and the reason of the answer or derivation section a section cut names. */
function consequencesStatus(value: ConsequencesValue): StatusContext {
  const sections = new Map<string, { status: string; reason?: string }>(value.answers.map((answer, index) => [`answers.${index}`, answer]));
  if (value.change !== undefined) sections.set("change.derivation", value.change.derivation);
  return {
    undecided: value.answers.reduce((total, answer) => total + (answer.status === "unknown" ? 0 : undecidedOf(answer.findings)), 0),
    unknownSection: (name) => { const section = sections.get(name); return section?.status === "unknown" ? section.reason : undefined; },
  };
}

/** One composite answer: the hypotheses (or the change) of one workspace read, each with its verdicts and the places it could not follow. */
export function renderContractConsequences(fact: Fact<ConsequencesValue>, detail: ResponseMode = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : CONSEQUENCES_FULL_GUIDE;
  const lines = headerLines(fact, fact.status === "unknown" ? {} : consequencesStatus(fact.value));
  if (fact.status === "unknown") return lines.join("\n");
  const { value } = fact;
  lines.push(counted("repositories", value.repositorySnapshots.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  if (value.change !== undefined) lines.push(...derivationLines(value.change, detail));
  lines.push(`answers (${value.answers.length}):`, ...(value.answers.length === 0 ? [NONE] : value.answers.flatMap((answer, index) => answerLines(answer, index, detail))));
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}
