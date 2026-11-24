import { FUNCTION_VALUE_AWAITS_JDK, type Cut, type Fact } from "../../../core/domain/shared/fact.ts";
import { canonicalJson } from "../../../core/domain/shared/canonical-json.ts";
import type { ExternalCalls, TraceEffect, TraceLeaf, TraceLinked, TraceStep, TraceValue } from "../../../core/domain/trace/trace-fact.ts";
import type { UnresolvedCallSite } from "../../../core/domain/topology/call-site.ts";
import type { Link, UnlinkedCallSite } from "../../../core/domain/topology/link.ts";
import { renderFactNarrowing, renderFactStatus } from "../../presentation-context.ts";
import { effectText } from "../../presentation.ts";
import type { Place, Presentation, Qualifier, Row, Section } from "../model.ts";
import { callSiteRow, cutSection, declarationRow, linkRow } from "../rows.ts";

/** The `answer.json` members the sections of this family come from. */
export const STEPS_SECTION = "value.steps";
export const EFFECTS_SECTION = "value.steps[].effects";
export const REQUESTS_SECTION = "value.steps[].unresolvedEffects";
export const ROOTS_SECTION = "value.roots";
export const SETTLED_SECTION = "value.settled";
export const READING_PLAN_SECTION = "value.readingPlan.ranges";
export const LINKS_SECTION = "value.links";
export const UNLINKED_SECTION = "value.unlinked";
export const CUTS_SECTION = "cuts";

const JDK_STEP = "declare a JDK (--jdk on ye-ast trace or ye-ast mcp) so the function values of undeclared library calls are read; a one-implementation port is followed once none of them may implement it";

function stepKeys(steps: readonly TraceStep[]): ReadonlyMap<number, string> {
  const keys = new Map<number, string>();
  for (const step of steps) keys.set(step.id, [step.parent === undefined ? "" : keys.get(step.parent)!, canonicalJson([step.file, step.line, step.symbol, step.at ?? null])].join("\0"));
  return keys;
}
const childKey = (parent: string, kind: string, value: unknown): string => [parent, kind, canonicalJson(value)].join("\0");
const placeOf = (file: string, line: number, endLine?: number): Place => ({ path: file, line, ...(endLine === undefined || endLine === line ? {} : { endLine }) });

function leafRow(parent: string, leaf: TraceLeaf): Row {
  return { key: childKey(parent, "leaf", leaf), place: placeOf(leaf.file, leaf.start, leaf.end), label: `leaf ${leaf.symbol}`, ...(leaf.deferred === true ? { qualifiers: [{ name: "deferred" }] } : {}) };
}

function externalRow(parent: string, group: ExternalCalls): Row {
  return { key: childKey(parent, "external", group), label: `external ${group.kind === "import" ? group.module : group.kind}: ${group.names.join(", ")}` };
}

function effectRow(parent: string, step: TraceStep, effect: TraceEffect): Row {
  return { key: childKey(parent, "effect", effect), place: placeOf(step.file, effect.line), label: effectText(effect), qualifiers: [{ name: "step", value: `#${step.id}` }] };
}

function alternativeRow(parent: string, alternative: Omit<TraceLeaf, "deferred">): Row {
  return { key: childKey(parent, "alternative", alternative), place: placeOf(alternative.file, alternative.start, alternative.end), label: `dispatch ${alternative.symbol}` };
}

function requestRow(parent: string, site: UnresolvedCallSite, step: TraceStep): Row {
  const row = callSiteRow(site);
  return { ...row, key: childKey(parent, "request", site), qualifiers: [...(row.qualifiers ?? []), { name: "step", value: `#${step.id}` }] };
}

function stepRow(step: TraceStep, key: string, children: readonly Row[]): Row {
  const qualifiers: Qualifier[] = [
    ...(step.parent === undefined ? [{ name: step.kind }] : []),
    ...(step.at === undefined ? [] : [{ name: "at", value: String(step.at.line) }]),
    ...(step.via === undefined || step.via === "call" ? [] : [{ name: step.via }]),
    ...(step.deferred === true ? [{ name: "deferred" }] : []),
    ...(step.seen === undefined ? [] : [{ name: "seen", value: `#${step.seen}` }]),
  ];
  return {
    ...declarationRow(step.file, step),
    key,
    place: placeOf(step.file, step.line, step.endLine),
    label: `#${step.id} ${step.symbol}`,
    ...(qualifiers.length === 0 ? {} : { qualifiers }),
    childrenAreAnswer: true,
    ...(children.length === 0 ? {} : { children }),
  };
}

/** The steps as a tree in the fact's pre-order: each step holds its calls, leaves, external calls and dispatch alternatives. */
function stepRows(steps: readonly TraceStep[]): Row[] {
  const keys = stepKeys(steps);
  const ids = new Set(steps.map((step) => step.id));
  const nested = new Map<number, TraceStep[]>();
  const roots: TraceStep[] = [];
  for (const step of steps) {
    if (step.parent === undefined || !ids.has(step.parent)) roots.push(step);
    else nested.set(step.parent, [...(nested.get(step.parent) ?? []), step]);
  }
  const build = (step: TraceStep): Row => {
    const owner = keys.get(step.id)!;
    return stepRow(step, owner, [
      ...(step.leaves ?? []).map((leaf) => leafRow(owner, leaf)),
      ...(step.external ?? []).map((group) => externalRow(owner, group)),
      ...(step.alternatives ?? []).map((alternative) => alternativeRow(owner, alternative)),
      ...(nested.get(step.id) ?? []).map(build),
    ]);
  };
  return roots.map(build);
}

/** The bodies' effects and undecided requests, one row each, so a place is stated once even when two steps share a file. */
function effectRows(steps: readonly TraceStep[]): Row[] {
  const keys = stepKeys(steps);
  const effects = steps.flatMap((step) => (step.effects ?? []).map((effect) => effectRow(keys.get(step.id)!, step, effect)));
  return effects.length > 0 || steps.some((step) => (step.unresolvedEffects?.length ?? 0) > 0) ? effects : [{ key: "no-effects", label: "no recorded effects" }];
}

function requestRows(steps: readonly TraceStep[]): Row[] {
  const keys = stepKeys(steps);
  return steps.flatMap((step) => (step.unresolvedEffects ?? []).map((site) => requestRow(keys.get(step.id)!, site, step)));
}

function traceLinkRow(link: TraceLinked<Link>): Row {
  const row = linkRow(link);
  const extra: Qualifier[] = [
    ...(link.deferred === true ? [{ name: "runs later, if at all" }] : []),
    ...(link.issuedAt === undefined ? [] : [{ name: "issued at", value: link.issuedAt.map(({ file, line }) => `${file}:${line}`).join(", ") }]),
  ];
  return extra.length === 0 ? row : { ...row, qualifiers: [...(row.qualifiers ?? []), ...extra] };
}

function traceUnlinkedRow(site: TraceLinked<UnlinkedCallSite>): Row {
  const row = callSiteRow(site);
  return site.issuedAt === undefined ? row : { ...row, qualifiers: [...(row.qualifiers ?? []), { name: "issued at", value: site.issuedAt.map(({ file, line }) => `${file}:${line}`).join(", ") }] };
}

function rootRows(roots: TraceValue["roots"]): Row[] {
  return roots.map((root) => ({ key: ["roots", root.target].join("\0"), label: `${root.target} matches ${root.steps.length}${root.steps.length === 0 ? "" : `: ${root.steps.map((id) => `#${id}`).join(", ")}`}` }));
}

function settledRows(settled: NonNullable<TraceValue["settled"]>): Row[] {
  return settled.map((range) => ({ key: ["settled", canonicalJson(range)].join("\0"), place: placeOf(range.file, range.start, range.end), label: range.reason, ...(range.candidates.length === 0 ? {} : { qualifiers: [{ name: "candidates", value: range.candidates.join(", ") }] }) }));
}

function readingPlanRows(ranges: TraceValue["readingPlan"]["ranges"]): Row[] {
  return ranges.map((range) => ({ key: ["range", canonicalJson({ file: range.file, start: range.start, end: range.end })].join("\0"), place: placeOf(range.file, range.start, range.end), label: range.steps.length === 0 ? "no step" : `steps ${range.steps.join(", ")}` }));
}

function nextSteps(cuts: readonly Cut[]): NonNullable<Presentation["next"]> {
  const followable = cuts.some((cut) => cut.at.length === 2 && (cut.cause ?? []).some((place) => place.endsWith(` ${FUNCTION_VALUE_AWAITS_JDK}`)));
  return followable ? [{ cause: FUNCTION_VALUE_AWAITS_JDK, step: JDK_STEP }] : [];
}

/** The trace of a selection as rows: the call sequence as a tree, its effects and requests, roots, reading plan and cuts. */
export function present(fact: Fact<TraceValue>): Presentation {
  const value = fact.status === "unknown" ? undefined : fact.value;
  const sections: Section[] = [];
  if (value !== undefined) {
    sections.push(
      { id: STEPS_SECTION, title: "steps", role: "answer", layout: "tree", primary: true, rows: stepRows(value.steps) },
      { id: EFFECTS_SECTION, title: "effects", role: "answer", layout: "by-file", rows: effectRows(value.steps) },
      { id: REQUESTS_SECTION, title: "unresolved requests", role: "answer", layout: "by-file", rows: requestRows(value.steps) },
      { id: ROOTS_SECTION, title: "roots", role: "context", layout: "list", rows: rootRows(value.roots) },
      { id: SETTLED_SECTION, title: "requested ranges", role: "context", layout: "list", rows: settledRows(value.settled ?? []) },
      { id: READING_PLAN_SECTION, title: "reading plan", role: "context", layout: "by-file", rows: readingPlanRows(value.readingPlan.ranges) },
    );
    if (value.repositorySnapshots !== undefined) {
      sections.push(
        { id: LINKS_SECTION, title: "links from placed trace requests", role: "context", layout: "by-file", rows: (value.links ?? []).map(traceLinkRow) },
        { id: UNLINKED_SECTION, title: "call sites the join reached without a link", role: "context", layout: "by-file", rows: (value.unlinked ?? []).map(traceUnlinkedRow) },
      );
    }
  }
  const cuts = fact.status === "partial" ? fact.cuts : [];
  const next = nextSteps(cuts);
  sections.push(cutSection(cuts, CUTS_SECTION));
  return {
    status: renderFactStatus(fact),
    snapshots: [fact.snapshot],
    narrowing: renderFactNarrowing(fact),
    sections,
    ...(next.length === 0 ? {} : { next }),
  };
}
