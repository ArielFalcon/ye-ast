import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../core/domain/entrypoints/http-route.ts";
import type { ChangedEntrypoint } from "../core/domain/impact/changed-entrypoints.ts";
import type { ImpactedSymbol, ImpactValue, ReachedEntrypoint } from "../core/domain/impact/impact-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { Cut, Evidence, Fact, Finding, SnapshotRef } from "../core/domain/shared/fact.ts";
import type { ImpactFault } from "../core/ports/impact-queries.port.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";

const NONE = "  (none)";
const CUTS = "cuts:";

function at(path: string, line: number): string {
  return `${path}:${line}`;
}

function snapshotLine(snapshot: SnapshotRef): string {
  return snapshot.kind === "sha" ? `snapshot: ${snapshot.repo} @ ${snapshot.sha}` : `snapshot: ${snapshot.repo} live @ ${snapshot.head} (${snapshot.stateId})`;
}

function evidenceText(evidence: Evidence): string {
  return at(evidence.path, evidence.line) + (evidence.endLine === undefined ? "" : `-${evidence.endLine}`);
}

function cutsOf(fact: Fact<unknown>): readonly Cut[] {
  return fact.status === "partial" ? fact.cuts : [];
}

/** The cuts grouped by kind, the kind that cut most first: the price the caller can act on leads the list. */
function cutsByKind(cuts: readonly Cut[]): (readonly [Cut["kind"], readonly Cut[]])[] {
  return [...Map.groupBy(cuts, (cut) => cut.kind)].toSorted(([a, ofA], [b, ofB]) => ofB.length - ofA.length || compareText(a, b));
}

/** The cuts of one kind, counted: the status line keeps the fact's size down to what the caller can act on. */
function cutCounts(cuts: readonly Cut[]): string {
  return cutsByKind(cuts)
    .map(([kind, ofKind]) => `${ofKind.length} ${kind}`)
    .join(", ");
}

/** The completeness of a fact: its status, the cut count per kind, and where an unknown one cannot tell. */
function statusLines(fact: Fact<unknown>, indent = ""): string[] {
  if (fact.status === "complete") return [`${indent}status: complete`];
  if (fact.status === "unknown") return [`${indent}status: unknown (${fact.reason})`, ...fact.evidence.map((evidence) => `${indent}  evidence: ${evidenceText(evidence)}`)];
  return [`${indent}status: partial (cuts: ${cutCounts(fact.cuts)})`];
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
  return `${anchor}: ${[...lines, ...elsewhere].join(", ")}`;
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

/** Every cut once: those that name a single path grouped per kind with every path listed, the rest one line each. */
function cutLines(cuts: readonly Cut[]): string[] {
  return cutsByKind(cuts).flatMap(([kind, ofKind]) => {
    const single = ofKind.filter((cut) => cut.at.length === 1);
    const rest = ofKind.filter((cut) => cut.at.length > 1).toSorted((a, b) => compareText(a.at.join("\0"), b.at.join("\0")));
    return [...(single.length === 0 ? [] : [singlePathLine(kind, single)]), ...rest.map(cutLine)];
  });
}

/** The cut list every answer closes with, so the answer content is read first and nothing is dropped. */
function cutsBlock(cuts: readonly Cut[]): string[] {
  return cuts.length === 0 ? [] : [CUTS, ...cutLines(cuts)];
}

function list(lines: readonly string[]): string[] {
  return lines.length === 0 ? [NONE] : [...lines];
}

function handlerText(handler: Handler): string {
  return `${at(handler.path, handler.line)} ${handler.symbol}`;
}

function entrypointLine(entrypoint: Entrypoint): string {
  const served = entrypoint.kind === "ui-route" ? (entrypoint.component === "unknown" ? "component unknown" : handlerText(entrypoint.component)) : handlerText(entrypoint.handler);
  return `  - ${entrypoint.kind} ${entrypoint.name} -> ${served}`;
}

function itemLine(item: Finding<Entrypoint>): string {
  return item.status === "unknown" ? `  - unknown (${item.reason}) ${item.evidence.map(evidenceText).join(", ")}`.trimEnd() : entrypointLine(item.value);
}

export function renderEntrypointMap(fact: Fact<EntrypointMap>): string {
  const lines = [...statusLines(fact), snapshotLine(fact.snapshot)];
  if (fact.status === "unknown") return lines.join("\n");
  const section = fact.value.entrypoints;
  lines.push("entrypoints:", ...statusLines(section, "  "));
  if (section.status !== "unknown") lines.push(...list(section.value.map(itemLine)));
  lines.push(...cutsBlock([...cutsOf(fact), ...cutsOf(section)]));
  return lines.join("\n");
}

function changedLine(change: ChangedEntrypoint): string {
  return `  - ${change.change} ${change.kind} ${change.name} -> ${handlerText(change.handler)}`;
}

function reachedLine(reached: ReachedEntrypoint): string {
  const name = reached.name === undefined ? reached.kind : `${reached.kind} ${reached.name}`;
  const confidence = reached.confidence < 1 ? `, confidence ${reached.confidence}` : "";
  return `  - ${name} -> ${handlerText(reached.handler)} (depth ${reached.depth}${confidence})`;
}

/** A seed is already listed, so a symbol reached at depth 0 that stands for one is not printed twice. */
function seedKeys(value: ImpactValue): Set<string> {
  return new Set(value.seeds.map((seed) => `${seed.file}\0${seed.symbol}\0${seed.line}`));
}

function symbolLine(symbol: ImpactedSymbol, file: string): string {
  const facts = [`depth ${symbol.depth}`];
  if (symbol.confidence < 1) facts.push(`confidence ${symbol.confidence}`);
  if (symbol.fanIn > 0) facts.push(`fan-in ${symbol.fanIn}`);
  if (symbol.via !== undefined) facts.push(`via ${symbol.via.file === file ? symbol.via.symbol : `${symbol.via.file}:${symbol.via.symbol}`}`);
  return `    ${symbol.line} ${symbol.symbol} [${symbol.kind}] (${facts.join(", ")})`;
}

/** The impacted symbols under the file that holds them, so the path is printed once per file. */
function impactedSymbols(value: ImpactValue): string[] {
  const seeds = seedKeys(value);
  const listed = value.symbols.filter((symbol) => symbol.depth !== 0 || !seeds.has(`${symbol.file}\0${symbol.symbol}\0${symbol.line}`));
  const lines = [`impacted symbols (${listed.length}):`];
  if (listed.length === 0) return [...lines, NONE];
  for (const [file, inFile] of Map.groupBy(listed, (symbol) => symbol.file)) lines.push(`  ${file}`, ...inFile.map((symbol) => symbolLine(symbol, file)));
  return lines;
}

export function renderImpact(fact: Fact<ImpactValue>): string {
  const lines = [...statusLines(fact), snapshotLine(fact.snapshot)];
  if (fact.status === "unknown") return lines.join("\n");
  const { value } = fact;
  if (value.mergeBase !== undefined) lines.push(`merge base: ${value.mergeBase}`);
  lines.push(
    `seeds (${value.seeds.length}):`,
    ...list(value.seeds.map((seed) => `  - ${at(seed.file, seed.line)} ${seed.symbol} (${seed.basis})`)),
  );
  if (value.changedEntrypoints !== undefined) lines.push(`changed entrypoints (${value.changedEntrypoints.length}):`, ...list(value.changedEntrypoints.map(changedLine)));
  lines.push(
    `reached entrypoints (${value.entrypoints.length}):`,
    ...list(value.entrypoints.map(reachedLine)),
    ...impactedSymbols(value),
    ...cutsBlock(cutsOf(fact)),
  );
  return lines.join("\n");
}

function namedFiles(label: string, files: readonly string[]): string {
  return `    ${label} (${files.length}): ${files.length === 0 ? "(none)" : files.join(", ")}`;
}

export function renderImporters(fact: Fact<ImportersValue>): string {
  const lines = [...statusLines(fact), snapshotLine(fact.snapshot)];
  if (fact.status === "unknown") return lines.join("\n");
  for (const entry of fact.value.files) {
    lines.push(`  ${entry.file}`, namedFiles("importers", entry.importers), namedFiles("users", entry.users), namedFiles("unresolved namers", entry.unresolvedNamers));
  }
  lines.push(...cutsBlock(cutsOf(fact)));
  return lines.join("\n");
}

/** What a fault entry can be told to the caller: the declarations of the file that could have been asked instead. */
function declarationText(entry: { file: string; candidates: readonly string[] }): string {
  return entry.candidates.length === 0 ? `${entry.file} declares no symbol` : `declared in ${entry.file}: ${entry.candidates.join(", ")}`;
}

export function renderFault(fault: { kind: string; detail: string } | ImpactFault): string {
  const entries = "entries" in fault ? fault.entries.map((entry) => `\n  - ${entry.file}:${entry.symbol}: ${declarationText(entry)}`).join("") : "";
  return `fault: ${fault.kind}\n${fault.detail.trim()}${entries}`;
}

/** The line that opens the text of a live answer the working tree has moved past. */
export function renderStale(notice: LiveStaleNotice): string {
  return `stale: the working tree changed after this answer, which reflects state ${notice.stateId}: ${notice.changed.join(", ")}`;
}
