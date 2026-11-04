import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../core/domain/entrypoints/http-route.ts";
import type { ChangedEntrypoint } from "../core/domain/impact/changed-entrypoints.ts";
import type { ImpactedSymbol, ImpactValue, ReachedEntrypoint, Seed } from "../core/domain/impact/impact-fact.ts";
import type { ModuleImpactValue } from "../core/domain/impact/module-dependency.ts";
import { declarationAnchor } from "../core/domain/impact/impact-cuts.ts";
import type { ImportedFile, ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { OutlineValue } from "../core/domain/outline/outline-fact.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { Decision, DecisionKind, DecisionOption } from "../core/domain/decisions/decision.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { Cut, Evidence, Fact, Finding, SnapshotRef } from "../core/domain/shared/fact.ts";
import type { ImpactFault } from "../core/ports/impact-queries.port.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { NameCandidate, OutwardKind, OutwardName, RepositoryOutwardName } from "../core/domain/topology/outward-name.ts";
import type { RepositoryEvidence } from "../core/domain/shared/repository-evidence.ts";
import type { WorkspaceRefresh, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { CallSite, UnresolvedCallSite } from "../core/domain/topology/call-site.ts";
import type { ImpactedLink } from "../core/domain/topology/link.ts";
import type { RepositoryResolution } from "../core/domain/topology/remote-snapshot.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { WorkspaceSource } from "../core/ports/workspace-repos.port.ts";
import { FIXED_LAYER_DIRECTORY } from "../core/ports/fixed-layer-store.port.ts";
import { WORKSPACE_MANIFEST_FILE } from "../core/ports/workspace-defaults.port.ts";

const NONE = "  (none)";
const CUTS = "cuts:";
const MODULE_LISTED_DEPTH = 1;

/** What each source of the repositories in force is called in the text; `none` says what the answer then covers. */
const SOURCE_TEXT: Readonly<Record<WorkspaceSource, string>> = {
  request: "the request",
  persisted: `${FIXED_LAYER_DIRECTORY}/${WORKSPACE_MANIFEST_FILE}`,
  none: "nothing: this answer covers the bound repository alone (pass workspace.repos, or persist a declaration with ye-ast init --workspace)",
};

/** The line that says where the repositories the answer worked over came from, so one repository is never read as all of them. */
function sourceLine(source: WorkspaceSource): string {
  return `repositories declared by: ${SOURCE_TEXT[source]}`;
}

/** A place: its line, and the last line when the declaration spans more than one. */
function spanText(line: number, endLine?: number): string {
  return endLine === undefined ? `${line}` : `${line}-${endLine}`;
}

function placeText(path: string, line: number, endLine?: number): string {
  return `${path}:${spanText(line, endLine)}`;
}

function snapshotLine(snapshot: SnapshotRef): string {
  return snapshot.kind === "sha" ? `snapshot: ${snapshot.repo} @ ${snapshot.sha}` : `snapshot: ${snapshot.repo} live @ ${snapshot.head} (${snapshot.stateId})`;
}

function evidenceText(evidence: Evidence): string {
  return placeText(evidence.path, evidence.line, evidence.endLine);
}

function cutsOf(fact: Fact<unknown>): readonly Cut[] {
  return fact.status === "partial" ? fact.cuts : [];
}

/** The cuts grouped by kind, the kind that cut most first: the price the caller can act on leads the list. */
function cutsByKind(cuts: readonly Cut[]): (readonly [Cut["kind"], readonly Cut[]])[] {
  return [...Map.groupBy(cuts, (cut) => cut.kind)].toSorted(([a, ofA], [b, ofB]) => ofB.length - ofA.length || compareText(a, b));
}

/** The cuts of one kind, counted: the status line keeps the fact's size down to what the caller can act on. A section
 * cut names the section, so the status line already says which one degraded. */
function cutCounts(cuts: readonly Cut[]): string {
  return cutsByKind(cuts)
    .map(([kind, ofKind]) => `${ofKind.length} ${kind}${kind === "section" ? `: ${ofKind.flatMap((cut) => cut.at).join(", ")}` : ""}`)
    .join(", ");
}

/** The completeness of a fact: its status, the cut count per kind, and where an unknown one cannot tell. */
function statusLines(fact: Fact<unknown>, indent = ""): string[] {
  if (fact.status === "complete") return [`${indent}status: complete`];
  if (fact.status === "unknown") return [`${indent}status: unknown (${fact.reason})`, ...fact.evidence.map((evidence) => `${indent}  evidence: ${evidenceText(evidence)}`)];
  return [`${indent}status: partial (cuts: ${cutCounts(fact.cuts)})`];
}

/** The paths the caller narrowed the answer to, when it did: what they select is read, and so is the configuration that
 * interprets it. */
function scopeLines({ inputs: { declaredScope } }: Fact<unknown>): string[] {
  const parts = [["include", declaredScope.include], ["exclude", declaredScope.exclude]] as const;
  const named = parts.filter(([, globs]) => globs.length > 0).map(([label, globs]) => `${label} ${globs.join(", ")}`);
  return named.length === 0 ? [] : [`scope: ${named.join("; ")} (the content it selects; the configuration that interprets it is read too)`];
}

/** The languages and frameworks a status is relative to. */
function declaredScopeLines({ inputs: { declaredScope } }: Fact<unknown>): string[] {
  const named = [
    declaredScope.languages.length === 0 ? undefined : `languages ${declaredScope.languages.join(", ")}`,
    declaredScope.frameworks.length === 0 ? undefined : `frameworks ${declaredScope.frameworks.join(", ")}`,
  ].filter((part) => part !== undefined);
  return named.length === 0 ? [] : [`declared scope: ${named.join("; ")}`];
}

/** The part of the change the caller selected: paths, not content, so the walk stayed whole. */
function changedLines({ inputs: { declaredConfig } }: Fact<unknown>): string[] {
  const changed = declaredConfig.changed;
  return changed === undefined || changed.length === 0
    ? []
    : [`change: only paths matching ${changed.join(", ")} (the repository is indexed whole; callers outside the selection are known; the rest of the change is not answered about)`];
}

/** What every answer opens with: its completeness, what that completeness covers, and the snapshot it read. */
function headerLines(fact: Fact<unknown>): string[] {
  return [...statusLines(fact), ...declaredScopeLines(fact), ...scopeLines(fact), ...changedLines(fact), snapshotLine(fact.snapshot)];
}

/** A place after its file: the line, and the reason it could not be read when it carries one. */
function placeRest(place: string, prefix: string): string {
  const [line, ...reason] = place.slice(prefix.length).split(" ");
  return reason.length === 0 ? (line ?? "") : `${line} (${reason.join(" ")})`;
}

/** The places of an `unresolved-link` cut: the ones in the anchor's own file as line numbers, the rest as path:line. */
function cutPlaces(cut: Cut): string {
  const [anchor, ...places] = cut.at;
  if (cut.kind !== "unresolved-link" || anchor === undefined || places.length === 0) return cut.at.join(", ");
  const file = anchor.includes("::") ? anchor.slice(0, anchor.indexOf("::")) : anchor;
  const prefix = `${file}:`;
  const here = places.filter((place) => place.startsWith(prefix)).map((place) => placeRest(place, prefix));
  const elsewhere = places.filter((place) => !place.startsWith(prefix));
  const lines = here.length === 0 ? [] : [`${here.length === 1 ? "line" : "lines"} ${here.join(", ")}`];
  return `${anchor}: ${[...lines, ...groupedPlaces(elsewhere)].join(", ")}`;
}

/** The places grouped under their file, so a path repeated by every place is printed once and no place is dropped. */
function groupedPlaces(places: readonly string[]): string[] {
  const byFile = new Map<string, string[]>();
  for (const place of places) {
    const [pathLine = "", ...reason] = place.split(" ");
    const colon = pathLine.lastIndexOf(":");
    const file = colon === -1 ? pathLine : pathLine.slice(0, colon);
    const line = colon === -1 ? "" : pathLine.slice(colon + 1);
    const key = reason.length === 0 ? file : `${file} (${reason.join(" ")})`;
    byFile.set(key, [...(byFile.get(key) ?? []), line].filter((part) => part !== ""));
  }
  return [...byFile].map(([head, lines]) => (lines.length === 0 ? head : lines.length === 1 ? `${head}:${lines[0]}` : `${head}: ${lines.join(", ")}`));
}

function cutLine(cut: Cut): string {
  return `  ${cut.kind} at ${cutPlaces(cut)}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`;
}

/** The single-path cuts of one kind on one line: their limit only when all of them share it. */
function singlePathLine(kind: Cut["kind"], cuts: readonly Cut[]): string {
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
  for (const place of cut.at.slice(1)) {
    const [pathLine = ""] = place.split(" ");
    const colon = pathLine.lastIndexOf(":");
    files.add(colon === -1 ? pathLine : pathLine.slice(0, colon));
  }
  return [...files].sort(compareText).join(", ");
}

/** The references a file-led cut could not settle, as written, sorted and deduplicated: the reader settles each one by
 * reading it, without opening the file. */
function placeReasons(cut: Cut): string[] {
  const reasons = new Set<string>();
  for (const place of cut.at.slice(1)) {
    const [, ...reason] = place.split(" ");
    if (reason.length > 0) reasons.add(reason.join(" "));
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
    `  unresolved-link (${settled.join(", ")}, ${named(references, "reference", "references")}; detail "full" lists every place):`,
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
function cutLines(cuts: readonly Cut[], detail: Detail): string[] {
  return cutsByKind(cuts).flatMap(([kind, ofKind]) => {
    if (kind === "unresolved-link" && detail !== "full") return unresolvedDeclarations(ofKind);
    const single = ofKind.filter((cut) => cut.at.length === 1);
    const rest = ofKind.filter((cut) => cut.at.length > 1).toSorted((a, b) => compareText(a.at.join("\0"), b.at.join("\0")));
    return [...(single.length === 0 ? [] : [singlePathLine(kind, single)]), ...rest.map(cutLine)];
  });
}

/** The bytes a block costs with its line breaks, so a summary is held to the answer it stands for. */
function size(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
}

function cutsBlock(cuts: readonly Cut[], detail: Detail = "summary"): string[] {
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
  if (via.lines === undefined || via.lines.length === 0) return `${where} (${via.basis})`;
  const at = `at ${via.lines.join(", ")}`;
  return via.basis === "call" ? `${where} ${at}` : `${where} ${at} (${via.basis})`;
}

function entrypointLine(entrypoint: Entrypoint): string {
  const served = entrypoint.kind === "ui-route" ? (entrypoint.component === "unknown" ? "component unknown" : handlerText(entrypoint.component)) : handlerText(entrypoint.handler);
  return `  - ${entrypoint.kind} ${entrypoint.name} -> ${served}`;
}

function itemLine(item: Finding<Entrypoint>): string {
  return item.status === "unknown" ? `  - unknown (${item.reason}) ${item.evidence.map(evidenceText).join(", ")}`.trimEnd() : entrypointLine(item.value);
}

export function renderEntrypointMap(fact: Fact<EntrypointMap>, detail: Detail = "summary"): string {
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  const section = fact.value.entrypoints;
  lines.push("entrypoints:", ...statusLines(section, "  "));
  if (section.status !== "unknown") lines.push(...list(section.value.map(itemLine)));
  lines.push(...cutsBlock([...cutsOf(fact), ...cutsOf(section)], detail));
  return lines.join("\n");
}

function changedLine(change: ChangedEntrypoint): string {
  return `  - ${change.change} ${change.kind} ${change.name} -> ${handlerText(change.handler)}`;
}

function reachedLines(reached: ReachedEntrypoint, seeds: readonly Seed[], detail: Detail): string[] {
  const name = reached.name === undefined ? reached.kind : `${reached.kind} ${reached.name}`;
  const confidence = reached.confidence < 1 ? `, confidence ${reached.confidence}` : "";
  const origin = seeds[reached.seeds[0] ?? -1];
  const others = reached.seeds.length - 1;
  return [
    `  - ${name} -> ${handlerText(reached.handler)} (depth ${reached.depth}${confidence})`,
    ...(detail === "summary" && reached.seeds.length > 0 ? [`    origins: ${reached.seeds.length}`] : []),
    ...(detail === "summary" || origin === undefined ? [] : [`    one verified origin: ${placeText(origin.file, origin.line, origin.endLine)} ${origin.symbol} (${origin.basis})${others > 0 ? `; ${others} other ${others === 1 ? "origin" : "origins"}; full: true includes all` : ""}`]),
  ];
}

/** A seed is already listed, so a symbol reached at depth 0 that stands for one is not printed twice. */
function seedKeys(value: ImpactValue): Set<string> {
  return new Set(value.seeds.map((seed) => `${seed.file}\0${seed.symbol}\0${seed.line}`));
}

function symbolLine(symbol: ImpactedSymbol, file: string, includeVia = true): string {
  const facts = [`depth ${symbol.depth}`];
  if (symbol.confidence < 1) facts.push(`confidence ${symbol.confidence}`);
  if (symbol.fanIn > 0) facts.push(`fan-in ${symbol.fanIn}`);
  if (includeVia && symbol.via !== undefined) facts.push(`via ${viaText(symbol.via, file)}`);
  return `    ${spanText(symbol.line, symbol.endLine)} ${symbol.symbol} [${symbol.kind}] (${facts.join(", ")})`;
}

export type Detail = "summary" | "full";

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

function investigationSymbols(value: ImpactValue): readonly ImpactedSymbol[] {
  const symbols = consequenceSymbols(value);
  const nearest = symbols.reduce((depth, symbol) => Math.min(depth, symbol.depth), Infinity);
  return symbols.filter((symbol) => symbol.depth === nearest || value.entrypoints.some(({ handler }) => handler.path === symbol.file && handler.line === symbol.line && handler.symbol === symbol.symbol));
}

function impactedSymbols(value: ImpactValue, detail: Detail): string[] {
  const symbols = consequenceSymbols(value);
  const header = `impacted symbols (${symbols.length}):`;
  if (symbols.length === 0) return [header];
  const literal = [header, ...groupedLines(symbols)];
  if (detail === "summary") {
    const depths = [...Map.groupBy(symbols, (symbol) => symbol.depth)].toSorted(([a], [b]) => a - b);
    const counted = [header, `  by depth: ${depths.map(([depth, group]) => `${depth}: ${group.length}`).join(", ")}; detail "full" shows investigation evidence; full: true includes every symbol`];
    return size(counted) <= size(literal) ? counted : literal;
  }
  const shown = investigationSymbols(value);
  const omitted = symbols.length - shown.length;
  const evidence = [header, `  evidence view: nearest recorded depth ${shown.reduce((depth, symbol) => Math.min(depth, symbol.depth), Infinity)} and reached handlers`, ...groupedLines(shown), ...(omitted === 0 ? [] : [`  ${omitted} other ${omitted === 1 ? "symbol" : "symbols"}; full: true includes all`])];
  return omitted > 0 && size(evidence) <= size(literal) ? evidence : literal;
}

/** What an impact answer says about its walk, without its header or its cuts. */
function impactBody(value: ImpactValue, detail: Detail): string[] {
  return [
    ...(value.mergeBase === undefined ? [] : [`merge base: ${value.mergeBase}`]),
    ...(value.changedEntrypoints === undefined ? [] : [`changed entrypoints (${value.changedEntrypoints.length}):`, ...value.changedEntrypoints.map(changedLine)]),
    `reached entrypoints (${value.entrypoints.length}):`,
    ...(detail === "summary" && value.entrypoints.some((entrypoint) => entrypoint.seeds.length > 0) ? [`  origin associations (${value.entrypoints.reduce((total, entrypoint) => total + entrypoint.seeds.length, 0)}): counted below; detail "full" shows one per entrypoint; full: true includes all`] : []),
    ...value.entrypoints.flatMap((entrypoint) => reachedLines(entrypoint, value.seeds, detail)),
    ...impactedSymbols(value, detail),
    ...(value.modules === undefined ? [] : moduleLines(value.modules, detail)),
  ];
}

function moduleLines(value: ModuleImpactValue, detail: Detail): string[] {
  const listed = detail === "full" ? value.modules : value.modules.filter((module) => module.depth <= MODULE_LISTED_DEPTH);
  const omitted = value.modules.length - listed.length;
  return [
    `module origins (${value.origins.length}):`,
    ...value.origins.map((origin) => `  ${origin.file} (${origin.change})`),
    `module dependencies (${value.modules.length}, not symbol or entrypoint impact):`,
    ...listed.map((module) => `  ${module.snapshot} ${module.file} (depth ${module.depth}, origins ${module.origins.join(", ")})${module.via === undefined ? "" : ` via ${module.via.kind} ${module.via.file} at ${module.file}:${module.via.line}${module.via.typeOnly ? " (type-only)" : ""}`}`),
    ...(omitted === 0 ? [] : [`  ${omitted} deeper module dependencies not listed; detail "full" lists their evidence, or ye_ast_importers reads direct consumers at a snapshot.`]),
    `module expansions: ${value.cost.expansionsUsed}`,
  ];
}

function impactSeeds(value: ImpactValue, detail: Detail): string[] {
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

/** The seeds under the file that holds them, so a path repeated by every seed is printed once. A basis the whole file
 * shares is printed with the file; a file that mixes bases keeps one beside each seed. */
function seedListing(seeds: readonly Seed[]): string[] {
  return [...Map.groupBy(seeds, (seed) => seed.file)].flatMap(([file, inFile]) => {
    const bases = new Set(inFile.map((seed) => seed.basis));
    const [shared] = bases;
    return bases.size === 1 && shared !== undefined
      ? [`  ${file} (${shared})`, ...inFile.map((seed) => `    ${spanText(seed.line, seed.endLine)} ${seed.symbol}`)]
      : [`  ${file}`, ...inFile.map((seed) => `    ${spanText(seed.line, seed.endLine)} ${seed.symbol} (${seed.basis})`)];
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
    ...(rest.length === 0 ? [] : [`  change origins: ${rest.length} ${rest.length === 1 ? "declaration" : "declarations"} across ${files.size} ${files.size === 1 ? "file" : "files"} (${bases.join(", ")}); full: true includes every seed`]),
  ];
}

/** The seeds of a summary, or the full listing when counting them would cost more bytes than naming them. */
function groupedSeeds(seeds: readonly Seed[]): string[] {
  const listing = seedListing(seeds);
  const summary = seedSummary(seeds);
  return size(summary) <= size(listing) ? summary : listing;
}

function impactCuts(cuts: readonly Cut[], detail: Detail): string[] {
  if (cuts.length === 0) return [];
  const groups = cutsByKind(cuts);
  if (detail === "summary") return [CUTS, ...groups.map(([kind, group]) => {
    const limits = [...new Set(group.flatMap((cut) => cut.limit === undefined ? [] : [cut.limit]))].toSorted((a, b) => a - b);
    return `  ${kind} (${group.length})${limits.length === 0 ? "" : `; ${limits.length === 1 ? "limit" : "limits"} ${limits.join(", ")}`}`;
  }), '  detail "full" locates cut anchors; full: true includes every place'];
  return [CUTS, ...groups.flatMap(([kind, group]) => {
    if (kind !== "unresolved-link") return cutLines(group, "full");
    const byFile = Map.groupBy(group, (cut) => (cut.at[0] ?? "").split("::")[0] ?? "");
    return [`  ${kind} (${group.length}):`, ...[...byFile].toSorted(([a], [b]) => compareText(a, b)).flatMap(([file, inFile]) => [
      `    ${file}`,
      ...[...Map.groupBy(inFile, (cut) => cut.at[0] ?? "")].toSorted(([a], [b]) => compareText(a, b)).map(([anchor, records]) => {
        const name = anchor.includes("::") ? anchor.slice(anchor.indexOf("::") + 2) : "(the file itself)";
        const places = records.reduce((total, cut) => total + Math.max(0, cut.at.length - 1), 0);
        const reasons = anchor.includes("::") ? [] : [...new Set(records.flatMap(placeReasons))].sort(compareText);
        const limits = [...new Set(records.flatMap((cut) => cut.limit === undefined ? [] : [cut.limit]))].toSorted((a, b) => a - b);
        return `      ${name}: ${records.length} ${records.length === 1 ? "cut" : "cuts"}, ${places} reference ${places === 1 ? "place" : "places"}${limits.length === 0 ? "" : `; limits ${limits.join(", ")}`}${reasons.length === 0 ? "" : `; ${reasons.join(", ")}`}`;
      }),
    ])];
  }), '  reference places counted; full: true includes every place'];
}

function impactLookups(value: ImpactValue, path: string): string[] {
  const lines: string[] = [];
  if (value.entrypoints.length > 0) lines.push(`  To explain a listed entrypoint, select ${path}.entrypoints by kind/name and handler.path, handler.symbol, handler.line. Its seeds are zero-based indexes into ${path}.seeds; resolve those indexes to recover all associated origins, not a complete call chain.`);
  if (value.symbols.length > 0) lines.push(`  To inspect a dependency omitted from text, filter ${path}.symbols by file, symbol and line. Read via.file/symbol for its recorded dependency; via.lines are locations in that symbol's own file, not in via.file. Preserve via.basis and confidence when interpreting it.`);
  if (value.seeds.length > 0 && value.entrypoints.length === 0) lines.push(`  To identify the walk origins, match ${path}.seeds by file, symbol and line; basis distinguishes requested targets from change-derived origins.`);
  if ((value.changedEntrypoints?.length ?? 0) > 0) lines.push(`  To inspect entrypoints added, removed or altered by the diff, filter ${path}.changedEntrypoints by change, kind/name and handler identity; these are distinct from reached entrypoints.`);
  return lines;
}

function impactCutLookup(cuts: readonly Cut[], path: string): string[] {
  if (cuts.length === 0) return [];
  return [
    `  Before treating this result as exhaustive, inspect ${path}: filter by kind and the relevant anchor in at; a recorded limit explains where coverage stopped. Full JSON does not extend that coverage.`,
    ...(cuts.some((cut) => cut.kind === "unresolved-link") ? [`  For unresolved-link in ${path}, at[0] names the unresolved file/declaration anchor and the remaining at entries locate potential references; they are not verified calls.`] : []),
  ];
}

function impactSnapshotGuide(snapshot: SnapshotRef, mergeBase?: string): string {
  if (snapshot.kind === "live") return "  Keep evidence at the same snapshot: a live stateId is an identity, not a request selector. Repeating live can observe different content; HEAD alone does not reproduce that working-tree state.";
  const selector = mergeBase === undefined ? `revision ${JSON.stringify(snapshot.sha)}` : `head ${JSON.stringify(snapshot.sha)} and base ${JSON.stringify(mergeBase)}`;
  return `  Keep the same snapshot when repeating this query: ${selector}; retain the declared scope and change selection. For a related callers/outline/importers query use revision ${JSON.stringify(snapshot.sha)} instead of impact base/head; it answers a new question, not a filter over this result.`;
}

function unknownImpactGuide(): string[] {
  return ["Investigation guide:", "  Analysis is unknown, not a verified absence of impact. Inspect reason and evidence in structuredContent (full: true includes the full fact) to establish the missing prerequisite before retrying; there is no value to search."];
}

function localImpactGuide(fact: Fact<ImpactValue> & { status: "complete" | "partial" }): string[] {
  const lookups = impactLookups(fact.value, "value");
  return [
    "Investigation guide:",
    "  Full JSON navigation (available with full: true): paths below are relative to structuredContent; query the returned payload directly when already included.",
    ...lookups,
    ...(lookups.length === 0 ? ["  There are no recorded consequences or walk origins in this answer. Read inputs.declaredScope and inputs.declaredConfig before interpreting that scoped emptiness."] : []),
    ...impactCutLookup(cutsOf(fact), "cuts"),
    impactSnapshotGuide(fact.snapshot, fact.value.mergeBase),
  ];
}

function workspaceImpactGuide(fact: Fact<WorkspaceImpactValue> & { status: "complete" | "partial" }): string[] {
  const { value } = fact;
  const trigger = value.sections[value.trigger.repo];
  const originPath = `value.sections[${JSON.stringify(value.trigger.repo)}].value.impact`;
  const impacts = Object.values(value.sections).flatMap((section) => section.status === "unknown" || section.value.impact === undefined ? [] : [section.value.impact]);
  return [
    "Investigation guide:",
    "  Full JSON navigation (available with full: true): paths below are relative to structuredContent; query the returned payload directly when already included.",
    ...(Object.keys(value.sections).length === 0 ? [] : ["  Select value.sections by the exact repository key, not a shared relative file path. Check section.status and, when present, section.reason/cuts and section.value.reads[].fact status/reason before using its evidence; an unknown section has no value."]),
    ...(trigger?.status !== "unknown" && trigger?.value.impact !== undefined ? [`  The originating repository's walk is at ${originPath}.`, ...impactLookups(trigger.value.impact, originPath)] : []),
    ...(impacts.length === 0 ? [] : ["  Other repository walks are at value.sections[repo].value.impact only when that field exists. In each walk, entrypoints[].seeds indexes that same walk's seeds array; never join origins across repositories."]),
    ...(value.links.length === 0 ? [] : ["  To follow a cross-repository consequence, filter value.links by link.from (repo/file/symbol/line) or link.to (repo/name/handler). Each reach contains link IDs in recorded order: resolve them against value.links[].link.id, not the text's display numbers. Retain direction, basis and confidence; reach does not establish an unrecorded path inside a repository."]),
    ...(value.workspace.unserved.length === 0 ? [] : ["  For missing service coverage, inspect value.workspace.unserved and section.value.external when present. Use ye_ast_workspace to investigate outward-name evidence and candidate local repositories; adding workspace.repos changes the query's coverage rather than filtering this fact."]),
    ...impactCutLookup(cutsOf(fact), "cuts"),
    ...(Object.values(value.sections).some((section) => section.status === "partial") ? ["  Repository-local limits remain in value.sections[repo].cuts; inspect contributing section.value.reads[].fact too. Do not treat a complete independent read as resolving an unknown contributing read."] : []),
    "  Preserve each repository's revision from value.repositorySnapshots when repeating a workspace query; evidence paths belong to their owning repository.",
    impactSnapshotGuide(fact.snapshot, value.trigger.mergeBase),
  ];
}

export function renderImpact(fact: Fact<ImpactValue>, detail: Detail = "summary"): string {
  const lines = headerLines(fact);
  if (fact.status === "unknown") return [...lines, ...unknownImpactGuide()].join("\n");
  lines.push(...impactBody(fact.value, detail), ...impactSeeds(fact.value, detail), ...impactCuts(cutsOf(fact), detail), ...localImpactGuide(fact));
  return lines.join("\n");
}

function importerFiles(entry: ImportedFile, detail: Detail): string[] {
  const moduleGroups: readonly (readonly [string, readonly string[] | undefined])[] = [
    ["importers", entry.importers], ["reexporters", entry.reexporters], ["dynamic importers", entry.dynamicImporters], ["type importers", entry.typeImporters],
  ];
  const seen = new Set<string>();
  const distinctModules = moduleGroups.flatMap(([label, files]) => {
    if (files === undefined) return [];
    return [[label, files.filter((file) => { if (seen.has(file)) return false; seen.add(file); return true; })] as const];
  });
  const linked = new Set([...seen, ...entry.users]);
  const unresolved = new Set(entry.unresolvedNamers);
  const groups: readonly (readonly [string, readonly string[]])[] = [
    ...distinctModules,
    ["additional users", entry.users.filter((file) => !seen.has(file))],
    ["unresolved-only candidates", entry.unresolvedNamers.filter((file) => !linked.has(file))],
  ];
  const overlapping = [...linked].filter((file) => unresolved.has(file)).length;
  const notes = [
    ...(overlapping === 0 ? [] : [`    ${overlapping} files with resolved links also have unresolved name matches.`]),
    ...(unresolved.size === 0 ? [] : ["    Unresolved name matches do not establish additional dependencies."]),
  ];
  const count = groups.reduce((total, [, files]) => total + files.length, 0);
  const heading = `    related files (${count} distinct)`;
  const listing = groups.flatMap(([label, files]) => {
    const head = `    ${label} (${files.length})`;
    if (files.length === 0) return [head];
    const pending = files.filter((file) => linked.has(file) && unresolved.has(file));
    if (pending.length === 0) return [`${head}: ${files.join(", ")}`];
    const remaining = files.filter((file) => !unresolved.has(file));
    return [
      `${head}:`,
      `      with unresolved name matches (${pending.length}): ${pending.join(", ")}`,
      ...(remaining.length === 0 ? [] : [`      without unresolved name matches (${remaining.length}): ${remaining.join(", ")}`]),
    ];
  });
  const summary = [
    ...groups.map(([label, files]) => `    ${label} (${files.length})`),
    ...(count === 0 ? [] : ['    File paths omitted; use detail: "full" to list them, or full: true for the original structured fact.']),
  ];
  return [heading, ...(detail === "summary" && size(summary) <= size(listing) ? summary : listing), ...notes];
}

export function renderImporters(fact: Fact<ImportersValue>, detail: Detail = "summary"): string {
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  for (const entry of fact.value.files) lines.push(`  ${entry.file}`, ...importerFiles(entry, detail));
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}

export function renderStructuredImporters(fact: Fact<ImportersValue>): string {
  return [statusLines(fact)[0], "full structured result: structuredContent"].join("\n");
}

export function renderOutline(fact: Fact<OutlineValue>, detail: Detail = "summary"): string {
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  for (const entry of fact.value.files) {
    lines.push(`  ${entry.file}`);
    lines.push(...(entry.declarations.length === 0 ? ["    declares nothing"] : entry.declarations.map((declaration) => `    ${spanText(declaration.line, declaration.endLine)} ${declaration.name} [${declaration.kind}]`)));
    if (entry.imports.length > 0) lines.push(`    imports: ${entry.imports.join(", ")}`);
  }
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}

/** What a fault entry can be told to the caller: the declarations of the file that could have been asked instead. */
function declarationText(entry: { file: string; candidates: readonly string[] }): string {
  return entry.candidates.length === 0 ? `${entry.file} declares no symbol` : `declared in ${entry.file}: ${entry.candidates.join(", ")}`;
}

function impactedLinkLine({ link, direction, reach }: ImpactedLink, indexes: ReadonlyMap<string, number>): string {
  const confidence = link.confidence < 1 ? `, confidence ${link.confidence}` : "";
  const profiles = link.profiles === undefined ? "" : `, under ${link.profiles.join(", ")}`;
  const chain = reach.length === 0 ? "" : `; reach: ${reach.map((id) => indexes.get(id) ?? id).join(", ")}`;
  return `  - ${indexes.get(link.id)}. ${link.from.repo}:${placeText(link.from.file, link.from.line)} ${link.from.symbol} -> ${link.to.repo} ${link.to.name} -> ${handlerText(link.to.handler)} (${link.basis}${confidence}${profiles}, ${direction}${chain})`;
}

function callSiteLine(site: CallSite): string {
  const { target } = site;
  const named = target.status !== "complete" ? "unknown" : "path" in target.value ? `${target.value.method} ${target.value.path}` : `${target.value.protocol} ${target.value.destination}`;
  return `      - ${placeText(site.file, site.line)} ${site.symbol} -> ${named}`;
}

function callSiteBlock(label: string, sites: readonly CallSite[]): string[] {
  return sites.length === 0 ? [] : [`    ${label} (${sites.length}):`, ...sites.map(callSiteLine)];
}

function repoImpactLines(repo: string, section: Fact<RepoImpact>, detail: Detail, bound: string): string[] {
  if (section.status === "unknown") return [`  ${repo}: unknown (${section.reason})`];
  const { value } = section;
  return [
    `  ${repo}: ${section.status}`,
    ...value.reads.flatMap(({ kind, fact }) => fact.status === "unknown" ? [`    ${kind}: unknown (${fact.reason})`] : []),
    ...callSiteBlock("call sites that land in what the walk reached", value.callSites),
    ...(value.impact === undefined || repo === bound ? [] : impactBody(value.impact, detail).map((line) => `    ${line}`)),
    ...callSiteBlock("unmatched", value.unmatched),
    ...callSiteBlock("external", value.external),
  ];
}

export function renderWorkspaceImpact(fact: Fact<WorkspaceImpactValue>, detail: Detail = "summary"): string {
  const lines = headerLines(fact);
  if (fact.status === "unknown") return [...lines, ...unknownImpactGuide()].join("\n");
  const { value } = fact;
  const trigger = value.sections[value.trigger.repo];
  lines.push(counted("repositories", value.repositorySnapshots.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  lines.push(sourceLine(value.workspace.source));
  lines.push(`bound repository: ${value.trigger.repo}`);
  lines.push(`gateway prefixes (${value.workspace.gateways.length}):`, ...value.workspace.gateways.map(({ prefix, repo, basis }) => `  - ${prefix} -> ${repo} (${basis})`));
  const stale = value.workspace.unmatchedGateways;
  if (stale.length > 0) lines.push(`declared gateways that matched nothing (${stale.length}):`, ...stale.map(({ prefix, repo }) => `  - ${prefix} -> ${repo}`));
  if (trigger !== undefined && trigger.status !== "unknown" && trigger.value.impact !== undefined) lines.push(...impactBody(trigger.value.impact, detail));
  const linkIndexes = new Map(value.links.map(({ link }, index) => [link.id, index + 1]));
  lines.push(`links across repositories (${value.links.length}):${value.links.some(({ reach }) => reach.length > 0) ? " reach lists link numbers nearest to the change first" : ""}`, ...value.links.map((link) => impactedLinkLine(link, linkIndexes)));
  lines.push("per repository:", ...value.workspace.repos.flatMap((repo) => (value.sections[repo] === undefined ? [] : repoImpactLines(repo, value.sections[repo] as Fact<RepoImpact>, detail, value.trigger.repo))));
  const unserved = counted("no local repository serves", value.workspace.unserved);
  const unservedSummary = `no local repository serves (${value.workspace.unserved.length}): full: true includes all names`;
  lines.push(value.workspace.unserved.length > 0 && size([unservedSummary]) <= size([unserved]) ? unservedSummary : unserved);
  lines.push("walk origins:", ...value.workspace.repos.flatMap((repo) => {
    const section = value.sections[repo];
    if (section === undefined || section.status === "unknown" || section.value.impact === undefined) return [];
    return [`  ${repo}:`, ...impactSeeds(section.value.impact, detail).map((line) => `    ${line}`)];
  }));
  lines.push(...impactCuts(cutsOf(fact), detail));
  for (const repo of value.workspace.repos) {
    const section = value.sections[repo];
    if (section === undefined || section.status !== "partial") continue;
    lines.push(`cuts for repository ${repo}:`, ...impactCuts(section.cuts, detail).slice(1));
  }
  lines.push(...workspaceImpactGuide(fact));
  return lines.join("\n");
}

function faultRecovery(kind: string): string {
  switch (kind) {
    case "unknown-change-path": return "Correct the nonmatching changed globs. Remove changed to investigate all changes within the declared scope; full/detail or a larger walk budget cannot fix a path-selection mismatch.";
    case "unknown-symbol": return "Use a listed declaration or an inclusive line range in targets. If needed, call ye_ast_outline for these files at the same revision to locate declaration spans; candidate names are alternatives, not an automatic substitution.";
    case "unknown-revision": return "Select a revision that resolves to a local commit. For impact check base/head, for other queries check revision, and for workspace check the identified repository's revision; inspect the reported cause before retrying.";
    case "no-merge-base": return "Choose base/head commits with a common ancestor. This query uses a merge-base diff; unrelated histories cannot be replaced silently with a direct diff.";
    case "not-repository-root": return "Use the repository root for the bound server or the indicated workspace repository path, rather than a subdirectory.";
    case "object-missing": return "Use a local clone containing the required Git objects for this revision. A partial clone may lack them; this error does not authorize an automatic download.";
    case "live-requires-trusted": return "Omit live and select a committed head (impact) or revision (other queries). Declaring trust is a user decision; repository content cannot grant it.";
    case "unsupported-object-format": return "For a live-read object-format limitation, omit live and try a committed head/revision appropriate to the tool; inspect any remaining limitation rather than assuming coverage is restored.";
    case "live-mirror-failed": return "Inspect the reported mirror/copy cause. If committed content answers the question, omit live and select that commit; it does not represent uncommitted edits.";
    case "unreadable":
    case "export-write-failed": return "Inspect the reported path and underlying read/write cause, including permissions or available space when indicated. Correct that prerequisite before retrying; this kind alone does not identify which repository or engine-owned resource failed.";
    case "duplicate-repository": return "Remove the duplicate repository declaration identified by the cause and retain the intended repository identity and revision.";
    case "git-failed": return "Inspect the reported Git/workspace cause and repository path. Correct the stated prerequisite before retrying; changing text detail does not repair this failure.";
    case "aborted": return "The caller cancelled the work. Request it again only if still needed and the cancellation no longer applies.";
    case "internal-fault": return "Inspect the redacted cause. If reproducible, report the fault kind, query and snapshot context without secrets; no parameter change is guaranteed to repair an internal failure.";
    default: return "Inspect the redacted cause and typed fault metadata to identify the missing prerequisite; retry only after that condition can change. A fault provides no fact to inspect with full.";
  }
}

export function renderFault(fault: { kind: string; detail: string } | ImpactFault): string {
  const entries = "entries" in fault ? fault.entries.map((entry) => `\n  - ${entry.file}:${entry.symbol}: ${declarationText(entry)}`).join("") : "";
  return `fault: ${fault.kind}\n${fault.detail.trim()}${entries}\nNext step: ${faultRecovery(fault.kind)}`;
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
function namesBlock(names: readonly OutwardName[], served: ReadonlySet<string>, detail: Detail): string[] {
  return groupedByRank(names, (name) => name.kind, OUTWARD_ORDER).flatMap(([kind, ofKind]) => {
    const listed = detail === "full" || kind !== "dependency" ? ofKind : ofKind.filter((name) => served.has(name.name));
    const counted = ofKind.length - listed.length;
    const head =
      counted === 0 ? `    ${kind} (${ofKind.length}):`
      : counted === ofKind.length ? `    ${kind} (${ofKind.length}): no repository given serves them; detail "full" lists them`
      : `    ${kind} (${ofKind.length}): ${counted} no repository given serves; detail "full" lists them`;
    const line = (name: OutwardName): string => `      - ${name.name} (${name.evidence.map(evidenceText).join(", ")})`;
    const listing = [head, ...ofKind.map(line)];
    const summarized = [head, ...listed.map(line)];
    return counted === 0 || size(summarized) <= size(listing) ? summarized : listing;
  });
}

/** The names no repository given serves: a summary lists what the repository could call and counts the coordinates it consumes. */
function unservedBlock(unserved: readonly RepositoryOutwardName[], detail: Detail): string[] {
  if (unserved.length === 0) return ["no local repository serves (0):", NONE];
  const listed = detail === "full" ? unserved : unserved.filter((name) => name.kind !== "dependency");
  const counted = unserved.length - listed.length;
  const head = `no local repository serves (${unserved.length}):`;
  const listing = [head, ...unserved.map((name) => `  - ${name.kind} ${name.name}${name.evidence.length === 0 ? "" : ` (${name.evidence.map(repositoryEvidenceText).join(", ")})`}`)];
  if (counted === 0) return listing;
  const summarized = [`${head} ${counted} dependency counted; detail "full" lists them`, ...listed.map((name) => `  - ${name.kind} ${name.name}${name.evidence.length === 0 ? "" : ` (${name.evidence.map(repositoryEvidenceText).join(", ")})`}`)];
  return size(summarized) <= size(listing) ? summarized : listing;
}

/** The unresolved call sites under the file that holds them, sorted, each with the request it writes when the code states it. */
function unresolvedListing(sites: readonly UnresolvedCallSite[]): string[] {
  const sorted = [...sites].toSorted((a, b) => compareText(a.path, b.path) || a.line - b.line || compareText(a.symbol, b.symbol));
  return [...Map.groupBy(sorted, (site) => site.path)].flatMap(([path, inFile]) => [`    ${path}`, ...inFile.map(unresolvedLine)]);
}

function unresolvedLine(site: UnresolvedCallSite): string {
  const through = site.via === undefined ? "" : `, through ${site.via}`;
  const stated = site.stated === undefined ? "" : ` ${site.stated.method} ${site.stated.path}`;
  return `      ${spanText(site.line, site.endLine)} ${site.symbol} (${site.transport}${through})${stated}`;
}

/** The call sites no repository given decides, so the caller settles each one by reading its declaration, never the file. */
function unresolvedBlock(value: WorkspaceValue): string[] {
  const sections = value.workspace.repos.flatMap((repo) => {
    const section = value.sections[repo];
    return section === undefined || section.status === "unknown" || section.value.unresolved.length === 0 ? [] : [[repo, section.value.unresolved] as const];
  });
  if (sections.length === 0) return [];
  return [
    `unresolved call sites (${sections.reduce((total, [, sites]) => total + sites.length, 0)}):`,
    ...sections.flatMap(([repo, sites]) => [`  ${repo}:`, ...unresolvedListing(sites)]),
  ];
}

export function renderWorkspace(fact: Fact<WorkspaceValue>, detail: Detail = "summary"): string {
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  const { value } = fact;
  const served = new Set(value.candidates.map((candidate) => candidate.name));
  const sections = value.workspace.repos.flatMap((repo) => {
    const section = value.sections[repo];
    return section === undefined || section.status === "unknown" ? [] : [[repo, section.value.names] as const];
  });
  lines.push(counted("repositories", value.repositorySnapshots.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  lines.push(sourceLine(value.workspace.source));
  for (const repo of value.workspace.repos) {
    const section = value.sections[repo];
    if (section?.status === "unknown") lines.push(`  ${repo}: unknown (${section.reason})`);
  }
  lines.push(`outward names (${sections.reduce((total, [, names]) => total + names.length, 0)}):`);
  for (const [repo, names] of sections) lines.push(`  ${repo}:`, ...namesBlock(names, served, detail));
  lines.push(`served by a local repository (${value.candidates.length}):`, ...value.candidates.map(candidateLine));
  lines.push(...unservedBlock(value.unserved, detail));
  lines.push(...unresolvedBlock(value));
  const cuts = [...cutsOf(fact), ...Object.values(value.sections).flatMap(cutsOf)].filter((cut) => cut.kind !== "unresolved-link");
  lines.push(...cutsBlock(cuts, detail));
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
function decisionsBlock(decisions: readonly Decision[], detail: Detail): string[] {
  return groupedByRank(decisions, (decision) => decision.kind, DECISION_ORDER).flatMap(([kind, ofKind]) => {
    const listed = detail === "full" ? ofKind : ofKind.filter((decision) => !dependencyGap(decision));
    const counted = ofKind.length - listed.length;
    const head = counted === 0 ? `  ${kind} (${ofKind.length}):` : `  ${kind} (${ofKind.length}): ${counted} dependency counted (free text only); detail "full" lists them`;
    const listing = [head, ...ofKind.flatMap(decisionLines)];
    const summarized = [head, ...listed.flatMap(decisionLines)];
    return counted === 0 || size(summarized) <= size(listing) ? summarized : listing;
  });
}

export function renderDecisions(fact: Fact<DecisionValue>, detail: Detail = "summary"): string {
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  const { value } = fact;
  lines.push(counted("repositories", value.repositories.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  lines.push(sourceLine(value.source));
  lines.push(`decisions (${value.decisions.length}):`, ...decisionsBlock(value.decisions, detail));
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}

