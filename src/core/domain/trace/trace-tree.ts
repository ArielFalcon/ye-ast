import { compareText } from "../shared/code-node.ts";
import type { ExternalCalls, TraceLeaf, TraceStep, TraceVia } from "./trace-fact.ts";

/** A declaration a trace reaches; `key` tells two declarations apart and never leaves the walk. */
export interface TraceDeclaration {
  key: string;
  file: string;
  symbol: string;
  kind: string;
  start: number;
  end: number;
}

export type ExternalCall = { kind: "import"; module: string; name: string } | { kind: "global" | "unnamed"; name: string };

/** One occurrence of a declaration in the walk, before folding and numbering. */
export interface WalkedStep {
  declaration: TraceDeclaration;
  at?: { line: number; column?: number };
  via?: TraceVia;
  deferred?: true;
  /** Its body was read: false for an occurrence a bound stopped and for a `seen` one. */
  expanded: boolean;
  seen?: WalkedStep;
  /** Its body holds a call no rule settled. */
  unsettled: boolean;
  children: WalkedStep[];
  external: ExternalCall[];
  /** Every body the declared hierarchy proves a call to this body-less method may run. */
  alternatives?: readonly TraceDeclaration[];
}

/** Read, and nothing in its body calls, leaves the repository or stays unsettled. */
function isProvenTerminal(step: WalkedStep): boolean {
  return step.expanded && !step.unsettled && step.children.length === 0 && step.external.length === 0;
}

/** A declaration folds wherever it occurs below a root, so a `seen` step never points at a folded one. */
function folds(step: WalkedStep): boolean {
  return isProvenTerminal(step.seen ?? step);
}

/**
 * The walked forest as pre-order steps: every proven terminal step below a root folds into its caller's `leaves`, once
 * per declaration; everything else stays a step, numbered in pre-order.
 */
export function traceSteps(roots: readonly WalkedStep[]): { steps: TraceStep[]; ids: ReadonlyMap<WalkedStep, number> } {
  const ids = new Map<WalkedStep, number>();
  const steps: TraceStep[] = [];
  const pending: { step: WalkedStep; depth: number; parent?: number }[] = roots.map((step) => ({ step, depth: 0 })).reverse();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { step, depth, parent } = next;
    const id = ids.size;
    ids.set(step, id);
    steps.push(stepOf(step, id, depth, parent, ids));
    const expanded = step.children.filter((child) => !folds(child));
    for (let index = expanded.length - 1; index >= 0; index -= 1) pending.push({ step: expanded[index]!, depth: depth + 1, parent: id });
  }
  return { steps, ids };
}

function stepOf(step: WalkedStep, id: number, depth: number, parent: number | undefined, ids: ReadonlyMap<WalkedStep, number>): TraceStep {
  const { file, symbol, kind, start, end } = step.declaration;
  /** A root seen at a declaration folded below an earlier root stands alone: that declaration has no step. */
  const seen = step.seen === undefined ? undefined : ids.get(step.seen);
  const leaves = [...new Map(step.children.filter(folds).map(({ declaration, deferred }): [string, TraceLeaf] => [
    JSON.stringify([declaration.key, deferred === true]),
    { symbol: declaration.symbol, file: declaration.file, start: declaration.start, end: declaration.end, ...(deferred === undefined ? {} : { deferred }) },
  ])).values()];
  return {
    id,
    ...(parent === undefined ? {} : { parent }),
    depth,
    file,
    symbol,
    kind,
    line: start,
    ...(end === start ? {} : { endLine: end }),
    ...(step.at === undefined ? {} : { at: step.at }),
    ...(step.via === undefined ? {} : { via: step.via }),
    ...(step.deferred === undefined ? {} : { deferred: step.deferred }),
    ...(seen === undefined ? {} : { seen }),
    ...(leaves.length === 0 ? {} : { leaves }),
    ...(step.external.length === 0 ? {} : { external: groupedByModule(step.external) }),
    ...(step.alternatives === undefined ? {} : { alternatives: step.alternatives.map(({ symbol, file, start, end }) => ({ symbol, file, start, end })) }),
  };
}

const KIND_ORDER: readonly ExternalCall["kind"][] = ["import", "global", "unnamed"];

function groupedByModule(calls: readonly ExternalCall[]): ExternalCalls[] {
  const groups = Map.groupBy(calls, (call) => JSON.stringify([KIND_ORDER.indexOf(call.kind), call.kind === "import" ? call.module : ""]));
  return [...groups]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, group]): ExternalCalls => {
      const first = group[0]!;
      const names = [...new Set(group.map(({ name }) => name))].sort(compareText);
      return first.kind === "import" ? { kind: "import", module: first.module, names } : { kind: first.kind, names };
    });
}
