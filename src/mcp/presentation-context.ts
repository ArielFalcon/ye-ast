import { mountOf } from "../core/domain/shared/build-outputs.ts";
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

/** A cut's kind and reason, the reason omitted where it only repeats the kind (a bound). */
export function cutLabel(cut: Cut): string {
  return cut.reason === cut.kind ? cut.kind : `${cut.kind} ${cut.reason}`;
}

/** Why a cut exists: its reason, with its sub-reason where it has one. */
export function cutReasonText(cut: Cut): string {
  return cut.subReason === undefined ? cut.reason : `${cut.reason} (${cut.subReason})`;
}

/** A cut row's label: its kind and why it exists, the reason omitted where it only repeats the kind. */
export function cutRowLabel(cut: Cut): string {
  return cut.reason === cut.kind && cut.subReason === undefined ? cut.kind : `${cut.kind} ${cutReasonText(cut)}`;
}

/** The cuts counted by kind and reason, most first (ADR-0042 decision 8). A section cut names the section, so the status
 * line already says which one degraded. */
export function cutCounts(cuts: readonly Cut[]): string {
  return [...Map.groupBy(cuts, cutLabel)]
    .toSorted(([a, ofA], [b, ofB]) => ofB.length - ofA.length || compareText(a, b))
    .map(([label, ofLabel]) => `${ofLabel.length} ${label}${ofLabel[0]!.kind === "section" ? `: ${ofLabel.flatMap((cut) => cut.at).join(", ")}` : ""}`)
    .join(", ");
}

/** A complete status, with the count of the asserted items it holds as `unknown` when there are any. */
export function completeText(undecided: number): string {
  return undecided === 0 ? "complete" : `complete (${undecided} undecided)`;
}

/** How many items of a collection are `unknown`. */
export function undecidedOf(items: readonly { status: string }[]): number {
  return items.filter((item) => item.status === "unknown").length;
}

/**
 * What a status line needs beyond the fact: how many items the family asserts are `unknown`, and the unknown reason of a
 * section a section cut names.
 */
export interface StatusContext {
  undecided?: number;
  unknownSection?: (name: string) => string | undefined;
}

/** The completeness of a fact: its status, the cut count per kind and reason, and where an unknown one cannot tell. A
 * complete collection with unknown items says how many (ADR-0042 decision 7); a composite whose one cut is an unknown
 * section prints that section's status. */
export function renderFactStatus(fact: Fact<unknown>, indent = "", { undecided = 0, unknownSection }: StatusContext = {}): string[] {
  if (fact.status === "complete") return [`${indent}status: ${completeText(undecided)}`];
  if (fact.status === "unknown") return [`${indent}status: unknown (${fact.reason})`, ...fact.evidence.map((evidence) => `${indent}  evidence: ${evidenceText(evidence)}`)];
  const [only, ...rest] = fact.cuts;
  const reason = rest.length === 0 && only.kind === "section" && only.at.length === 1 ? unknownSection?.(only.at[0]!) : undefined;
  return [`${indent}status: partial (${reason === undefined ? `cuts: ${cutCounts(fact.cuts)}` : `section ${only.at[0]}: unknown (${reason})`})`];
}

/** The paths the caller narrowed the answer to, when it did: what they select is read, and so is the configuration that
 * interprets it. */
function scopeLines(fact: Fact<unknown>): string[] {
  const { declaredScope } = contextOf(fact);
  const parts = [["include", declaredScope.include], ["exclude", declaredScope.exclude]] as const;
  const named = parts.filter(([, globs]) => globs.length > 0).map(([label, globs]) => `${label} ${globs.join(", ")}`);
  const lines = named.length === 0 ? [] : [`scope: ${named.join("; ")} (the content it selects; the configuration that interprets it is read too)`];
  if (fact.scopeSelection !== undefined) lines.push(`scope: include ${fact.scopeSelection.unmatchedIncludes.join(", ")} selected no path (the rest selected ${fact.scopeSelection.selectedFiles} files)`);
  return lines;
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
export function renderFactHeader(fact: Fact<unknown>, status?: StatusContext): string[] {
  return [...renderFactStatus(fact, "", status), ...declaredScopeLines(fact), ...scopeLines(fact), ...changedLines(fact), ...buildOutputLines(fact), snapshotLine(contextOf(fact).snapshot)];
}

/** Each build output the fact read (ADR-0037), and whether the snapshot's lockfile verified it; a declared JDK is always unverified (ADR-0063). */
function buildOutputLines(fact: Fact<unknown>): string[] {
  return (fact.inputs.buildOutputs ?? []).map((output) =>
    output.jdk === undefined
      ? `build output: ${mountOf(output)}, ${output.verified ? "verified by the snapshot's lockfile" : "unverified (no lockfile at the snapshot)"}`
      : `build output: ${mountOf(output)}, declared JDK ${output.jdk.version} (library signatures at release ${output.jdk.feature}), unverified`,
  );
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
