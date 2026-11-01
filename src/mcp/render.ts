import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../core/domain/entrypoints/http-route.ts";
import type { ChangedEntrypoint } from "../core/domain/impact/changed-entrypoints.ts";
import type { ImpactValue, ReachedEntrypoint } from "../core/domain/impact/impact-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { Evidence, Fact, SnapshotRef } from "../core/domain/shared/fact.ts";
import type { ImpactFault } from "../core/ports/impact-queries.port.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";

const NONE = "  (none)";

function at(path: string, line: number): string {
  return `${path}:${line}`;
}

function snapshotLine(snapshot: SnapshotRef): string {
  return snapshot.kind === "sha" ? `snapshot: ${snapshot.repo} @ ${snapshot.sha}` : `snapshot: ${snapshot.repo} live @ ${snapshot.head} (${snapshot.stateId})`;
}

function evidenceText(evidence: Evidence): string {
  return at(evidence.path, evidence.line) + (evidence.endLine === undefined ? "" : `-${evidence.endLine}`);
}

/** The completeness of a fact: its status, the reason when it is unknown and every cut when it is partial. */
function statusLines(fact: Fact<unknown>, indent = ""): string[] {
  if (fact.status === "complete") return [`${indent}status: complete`];
  if (fact.status === "unknown") return [`${indent}status: unknown (${fact.reason})`, ...fact.evidence.map((evidence) => `${indent}  evidence: ${evidenceText(evidence)}`)];
  return [
    `${indent}status: partial`,
    ...fact.cuts.map((cut) => `${indent}  cut ${cut.kind} at ${cut.at.join(", ")}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`),
  ];
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

export function renderEntrypointMap(fact: Fact<EntrypointMap>): string {
  const lines = [...statusLines(fact), snapshotLine(fact.snapshot)];
  if (fact.status === "unknown") return lines.join("\n");
  const section = fact.value.entrypoints;
  lines.push("entrypoints:", ...statusLines(section, "  "));
  if (section.status !== "unknown") {
    lines.push(
      ...list(
        section.value.map((item) =>
          item.status === "unknown"
            ? `  - unknown (${item.reason}) ${item.evidence.map(evidenceText).join(", ")}`.trimEnd()
            : entrypointLine(item.value) + (item.status === "partial" ? " [partial]" : ""),
        ),
      ),
    );
  }
  return lines.join("\n");
}

function changedLine(change: ChangedEntrypoint): string {
  return `  - ${change.change} ${change.kind} ${change.name} -> ${handlerText(change.handler)}`;
}

function reachedLine(reached: ReachedEntrypoint): string {
  const name = reached.name === undefined ? reached.kind : `${reached.kind} ${reached.name}`;
  return `  - ${name} -> ${handlerText(reached.handler)} (depth ${reached.depth}, confidence ${reached.confidence})`;
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
    `impacted symbols (${value.symbols.length}):`,
    ...list(
      value.symbols.map(
        (symbol) =>
          `  - ${at(symbol.file, symbol.line)} ${symbol.symbol} [${symbol.kind}] (depth ${symbol.depth}, confidence ${symbol.confidence}, fan-in ${symbol.fanIn}${symbol.via === undefined ? "" : `, via ${symbol.via.file}:${symbol.via.symbol}`})`,
      ),
    ),
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
  return lines.join("\n");
}

export function renderFault(fault: { kind: string; detail: string } | ImpactFault): string {
  const entries = "entries" in fault ? fault.entries.map((entry) => `\n  - ${entry.file}:${entry.symbol}`).join("") : "";
  return `fault: ${fault.kind}\n${fault.detail.trim()}${entries}`;
}

/** The line that opens the text of a live answer the working tree has moved past. */
export function renderStale(notice: LiveStaleNotice): string {
  return `stale: the working tree changed after this answer, which reflects state ${notice.stateId}: ${notice.changed.join(", ")}`;
}
