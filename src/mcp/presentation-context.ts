import type { Cut, Evidence, Fact, SnapshotRef } from "../core/domain/shared/fact.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { SourceSummary } from "./select-evidence.ts";

/** The provenance axes shared by ordinary and selected response policies. */
function contextOf(read: Pick<SourceSummary, "snapshot" | "inputs">) {
  return { snapshot: read.snapshot, trust: read.inputs.trust, declaredScope: read.inputs.declaredScope, declaredConfig: read.inputs.declaredConfig };
}

export function snapshotLine(snapshot: SnapshotRef): string {
  return snapshot.kind === "sha" ? `snapshot: ${snapshot.repo} @ ${snapshot.sha}` : `snapshot: ${snapshot.repo} live @ ${snapshot.head} (${snapshot.stateId})`;
}

export function evidenceText(evidence: Evidence): string {
  return `${evidence.path}:${evidence.line}${evidence.endLine === undefined ? "" : `-${evidence.endLine}`}`;
}

/** The cuts grouped by kind, the kind that cut most first: the price the caller can act on leads the list. */
export function cutsByKind(cuts: readonly Cut[]): (readonly [Cut["kind"], readonly Cut[]])[] {
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
export function renderFactStatus(fact: Fact<unknown>, indent = ""): string[] {
  if (fact.status === "complete") return [`${indent}status: complete`];
  if (fact.status === "unknown") return [`${indent}status: unknown (${fact.reason})`, ...fact.evidence.map((evidence) => `${indent}  evidence: ${evidenceText(evidence)}`)];
  return [`${indent}status: partial (cuts: ${cutCounts(fact.cuts)})`];
}

/** The paths the caller narrowed the answer to, when it did: what they select is read, and so is the configuration that
 * interprets it. */
function scopeLines(fact: Fact<unknown>): string[] {
  const { declaredScope } = contextOf(fact);
  const parts = [["include", declaredScope.include], ["exclude", declaredScope.exclude]] as const;
  const named = parts.filter(([, globs]) => globs.length > 0).map(([label, globs]) => `${label} ${globs.join(", ")}`);
  return named.length === 0 ? [] : [`scope: ${named.join("; ")} (the content it selects; the configuration that interprets it is read too)`];
}

/** The languages and frameworks a status is relative to. */
function declaredScopeLines(fact: Fact<unknown>): string[] {
  const { declaredScope } = contextOf(fact);
  const named = [
    declaredScope.languages.length === 0 ? undefined : `languages ${declaredScope.languages.join(", ")}`,
    declaredScope.frameworks.length === 0 ? undefined : `frameworks ${declaredScope.frameworks.join(", ")}`,
  ].filter((part) => part !== undefined);
  return named.length === 0 ? [] : [`declared scope: ${named.join("; ")}`];
}

function changedLines(fact: Fact<unknown>): string[] {
  const { declaredConfig } = contextOf(fact);
  const changed = declaredConfig.changed;
  return changed === undefined || changed.length === 0
    ? []
    : [`change: only paths matching ${changed.join(", ")} (callers outside the selection remain eligible within scope; recorded cuts limit coverage; the rest of the change is not answered about)`];
}

/** What every answer opens with: its completeness, what that completeness covers, and the snapshot it read. */
export function renderFactHeader(fact: Fact<unknown>): string[] {
  return [...renderFactStatus(fact), ...declaredScopeLines(fact), ...scopeLines(fact), ...changedLines(fact), snapshotLine(contextOf(fact).snapshot)];
}

export function renderSourceContext(source: SourceSummary): string[] {
  const root = contextOf(source);
  const lines = [`Source context: ${JSON.stringify({ ...root, analysis: source.analysis })}`];
  if (source.reads.length > 0) {
    lines.push("Reads inherit source snapshot/trust/scope/config unless explicitly overridden:");
    for (const read of source.reads) {
      const own = contextOf(read);
      const differences = Object.fromEntries(Object.entries(own).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(root[key as keyof typeof root])));
      lines.push(`  Read: ${JSON.stringify({ owner: read.owner, analysis: read.analysis, ...differences })}`);
    }
  }
  if (source.limits.length > 0) lines.push(`Source limits: ${JSON.stringify(source.limits)}`);
  lines.push("Provenance catalogs: source in the result JSON.");
  return lines;
}
