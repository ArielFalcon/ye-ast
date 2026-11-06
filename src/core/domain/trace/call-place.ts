import { nameTail } from "../impact/impact-cuts.ts";
import { compareText } from "../shared/code-node.ts";

/** What a call's spelling says about its callee. */
export type Callee = { form: "bare"; name: string } | { form: "member"; name: string } | { form: "computed" };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `f` is bare and `x.m`, `head().m` are members named `m`; `x[k]` and `(expr)` name no callee, so they are computed. */
export function calleeOf(spelling: string): Callee {
  const name = nameTail(spelling);
  if (!IDENTIFIER.test(name)) return { form: "computed" };
  return name === spelling ? { form: "bare", name } : { form: "member", name };
}

/** The member `this.<member>` and `this.<member>.<rest>` name. */
export function ownMemberOf(spelling: string): string | undefined {
  const [receiver, member] = spelling.split(".");
  return receiver === "this" && member !== undefined && IDENTIFIER.test(member) ? member : undefined;
}

export interface EdgeOccurrence {
  source: string;
  line: number | null;
  column: number | null;
  targetName: string;
}

export interface ReferenceOccurrence {
  from: string;
  line: number;
  column: number;
  name: string;
}

/**
 * Whether a resolved edge and an unresolved reference are one call: the same source, line and column, and the edge's
 * target named as the reference's last name. An unplaced edge stands for nothing, and chain links keep distinct names.
 */
export function sameOccurrence(edge: EdgeOccurrence, reference: ReferenceOccurrence): boolean {
  return edge.source === reference.from && edge.line === reference.line && edge.column === reference.column && edge.targetName === nameTail(reference.name);
}

export interface OrderedPlace {
  line: number | null;
  column: number | null;
  spelling: string;
  target: string;
}

/** Line, column, spelling, then target; a missing line or column after every present one. */
export function compareOccurrence(a: OrderedPlace, b: OrderedPlace): number {
  return (a.line ?? Infinity) - (b.line ?? Infinity) || (a.column ?? Infinity) - (b.column ?? Infinity) || compareText(a.spelling, b.spelling) || compareText(a.target, b.target);
}
