import { compareText } from "./code-node.ts";

/** What a call's spelling says about its callee. */
export type Callee = { form: "bare"; name: string } | { form: "member"; name: string } | { form: "computed" };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const NOT_ASCII = /[^\x00-\x7F]/;
const QUOTES = ["'", '"', "`"];

/** What follows a name's last separator: `save` of `x.save`, `b` of `a::b`. */
export function nameTail(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("."), name.lastIndexOf(":"), name.lastIndexOf("#")) + 1);
}

/**
 * A call's spelling without whitespace, comments, argument lists or the type arguments of a member (`.<T>m`), so two
 * readers that spell one link of a chain with and without its arguments agree: `a.b(x)\n  .c` and `a.b().c`.
 */
export function normalizedSpelling(spelling: string): string {
  let normalized = "";
  let depth = 0;
  for (let at = 0; at < spelling.length; at++) {
    const char = spelling[at]!;
    if (char === "/" && (spelling[at + 1] === "/" || spelling[at + 1] === "*")) at = commentEnd(spelling, at);
    else if (QUOTES.includes(char)) {
      const end = quoteEnd(spelling, at);
      if (depth === 0) normalized += spelling.slice(at, end + 1);
      at = end;
    } else if (char === "(") {
      if (depth === 0) normalized += "()";
      depth++;
    } else if (char === ")") depth = Math.max(depth - 1, 0);
    else if (depth === 0 && char === "<" && normalized.endsWith(".")) at = typeArgumentsEnd(spelling, at);
    else if (depth === 0 && !/\s/.test(char)) normalized += char;
  }
  return normalized;
}

function commentEnd(text: string, at: number): number {
  const end = text[at + 1] === "/" ? text.indexOf("\n", at) : text.indexOf("*/", at + 2) + 1;
  return end <= 0 ? text.length : end;
}

function quoteEnd(text: string, at: number): number {
  for (let end = at + 1; end < text.length; end++) {
    if (text[end] === "\\") end++;
    else if (text[end] === text[at]) return end;
  }
  return text.length;
}

function typeArgumentsEnd(text: string, at: number): number {
  let depth = 0;
  for (let end = at; end < text.length; end++) {
    if (text[end] === "<") depth++;
    else if (text[end] === ">" && --depth === 0) return end;
  }
  return text.length;
}

/** The name a member call's chain starts from: `X` of `X.m()`, `this.x.m()` and `X.a().m()`; none for a bare call. */
export function receiverRootOf(spelling: string): string | undefined {
  const normalized = normalizedSpelling(spelling).replace(/^this\./, "");
  const root = /^[A-Za-z_$][\w$]*/.exec(normalized)?.[0];
  return root !== undefined && normalized.length > root.length && normalized[root.length] === "." ? root : undefined;
}

/**
 * Whether a column lies before its line's first character outside ASCII. Up to there two parsers that count columns in
 * different units count alike, and past it both only count further, so a comparison with any boundary on the line gives
 * the same answer in either count.
 */
export function countedAlike(column: number, text: string): boolean {
  const first = NOT_ASCII.exec(text)?.index;
  return first === undefined || column <= first;
}

/** `f` is bare and `x.m`, `head().m` are members named `m`; `x[k]` and `(expr)` name no callee, so they are computed. */
export function calleeOf(spelling: string): Callee {
  const name = nameTail(spelling);
  if (!IDENTIFIER.test(name)) return { form: "computed" };
  return name === spelling ? { form: "bare", name } : { form: "member", name };
}

/** The name `x.m` and `this.x.m` call `m` on: `x`; none when the receiver ends in a call or an index. */
export function receiverOf(spelling: string): string | undefined {
  const receiver = spelling.slice(0, Math.max(spelling.lastIndexOf("."), 0));
  const name = receiver.slice(receiver.lastIndexOf(".") + 1);
  return IDENTIFIER.test(name) && name !== "this" ? name : undefined;
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
