/** What a call path holds where the code fills a value at run time; the extractors of every language write it. */
export const RUN_TIME_HOLE = "{}";

type TemplatePart = { kind: "text"; text: string } | { kind: "hole" };

/**
 * One segment of a path: text and holes, or a wildcard only a route states (`*` one segment, `**` or `{*name}` the rest
 * of the path, none of it included).
 */
export type TemplateSegment = { kind: "parts"; parts: readonly TemplatePart[] } | { kind: "any-segment" } | { kind: "any-tail" };

/** A call path as segments, with the scheme and authority it states when it states them. */
export interface CallTemplate {
  origin?: string;
  segments: readonly TemplateSegment[];
}

/** How a call path and a route path unify: a match counts the segments whose text both state and says whether a run-time value filled a route parameter. */
export type Unification = { outcome: "matches"; literals: number; parity: boolean } | { outcome: "could-match" } | { outcome: "cannot-match" };

export const CANNOT_MATCH: Unification = { outcome: "cannot-match" };
const COULD: Unification = { outcome: "could-match" };
const ORIGIN = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*)/i;
const NAMED_PARAMETER = /^:[A-Za-z_][A-Za-z0-9_]*$/;
/** A `{...}` hole, with one level of braces inside for a regular expression such as `{id:\d{3}}`. */
const HOLE = /\{[^/{}]*(?:\{[^/{}]*\}[^/{}]*)*\}/g;

/** The path a call states, its query and fragment dropped; a base it declares comes first, and an absolute path overrides it. */
export function callTemplate(target: { path: string; base?: string }): CallTemplate {
  const own = splitOrigin(target.path);
  if (own.origin !== undefined || target.base === undefined) return withOrigin(own.origin, segmentsOf(own.rest, "call"));
  const base = splitOrigin(target.base);
  return withOrigin(base.origin, [...segmentsOf(base.rest, "call"), ...segmentsOf(own.rest, "call")]);
}

/** Whether a call names the host it reaches; a host the code fills at run time names none. */
export function namesHost(call: CallTemplate): boolean {
  return call.origin !== undefined && !/^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:$|\{)/i.test(call.origin);
}

/** The segments of a route path or of a base path a route's configuration adds. */
export function routeSegments(path: string): TemplateSegment[] {
  return segmentsOf(path, "route");
}

/** The text of a segment that states only text; undefined when it holds a value or a wildcard. */
export function literalText(segment: TemplateSegment): string | undefined {
  if (segment.kind !== "parts") return undefined;
  const [only, ...rest] = segment.parts;
  return only?.kind === "text" && rest.length === 0 ? only.text : undefined;
}

/** How many segments of a route take any text: wildcards and parameters. A route with fewer is more specific; one that takes the rest of the path is the least. */
export function looseness(segments: readonly TemplateSegment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.kind === "any-tail" ? segments.length + 1 : segment.kind === "any-segment" || segment.parts.some((part) => part.kind === "hole") ? 1 : 0), 0);
}

/** The text a route states outside its parameters, the longer the more specific. */
export function statedLength(segments: readonly TemplateSegment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.kind === "parts" ? segment.parts.reduce((length, part) => length + (part.kind === "text" ? part.text.length : 0), 0) : 0), 0);
}

/** Whether a call path is a route path: segment by segment, a route's `**` taking the rest of the call. */
export function unify(call: readonly TemplateSegment[], route: readonly TemplateSegment[]): Unification {
  const tail = route.findIndex((segment) => segment.kind === "any-tail");
  if (tail === -1 && call.length !== route.length) return CANNOT_MATCH;
  if (tail !== -1 && call.length < tail) return CANNOT_MATCH;
  const compared = tail === -1 ? call : call.slice(0, tail);
  const swallowed = tail === -1 ? [] : call.slice(tail);
  let literals = 0;
  let parity = swallowed.some(holdsValue);
  let could = false;
  for (const [index, segment] of compared.entries()) {
    const unified = unifySegment(segment, route[index]!);
    if (unified.outcome === "cannot-match") return CANNOT_MATCH;
    if (unified.outcome === "could-match") could = true;
    else {
      literals += unified.literals;
      parity ||= unified.parity;
    }
  }
  return could ? COULD : { outcome: "matches", literals, parity };
}

function unifySegment(call: TemplateSegment, route: TemplateSegment): Unification {
  if (call.kind !== "parts") return CANNOT_MATCH;
  if (route.kind === "any-segment" || route.kind === "any-tail") return { outcome: "matches", literals: 0, parity: holdsValue(call) };
  const callText = literalText(call);
  const routeText = literalText(route);
  if (callText !== undefined && routeText !== undefined) return callText === routeText ? { outcome: "matches", literals: 1, parity: false } : CANNOT_MATCH;
  if (callText !== undefined) return patternOf(route.parts).test(callText) ? { outcome: "matches", literals: statesText(route) ? 1 : 0, parity: false } : CANNOT_MATCH;
  const wholeHole = (parts: readonly TemplatePart[]) => parts.length === 1 && parts[0]?.kind === "hole";
  if (wholeHole(route.parts)) return { outcome: "matches", literals: 0, parity: true };
  if (wholeHole(call.parts)) return CANNOT_MATCH;
  if (shapeOf(call.parts) === shapeOf(route.parts)) return { outcome: "matches", literals: 1, parity: true };
  if (routeText !== undefined) return patternOf(call.parts).test(routeText) ? COULD : CANNOT_MATCH;
  return edgesAgree(call.parts, route.parts) ? COULD : CANNOT_MATCH;
}

function holdsValue(segment: TemplateSegment): boolean {
  return segment.kind === "parts" && segment.parts.some((part) => part.kind === "hole");
}

function statesText(segment: TemplateSegment): boolean {
  return segment.kind === "parts" && segment.parts.some((part) => part.kind === "text");
}

function shapeOf(parts: readonly TemplatePart[]): string {
  return parts.map((part) => (part.kind === "text" ? part.text : RUN_TIME_HOLE)).join("");
}

function patternOf(parts: readonly TemplatePart[]): RegExp {
  return new RegExp(`^${parts.map((part) => (part.kind === "text" ? part.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[^/]+")).join("")}$`);
}

/** Whether the text two segments start with, and the text they end with, can be the same: one is a prefix (or suffix) of the other. */
function edgesAgree(call: readonly TemplatePart[], route: readonly TemplatePart[]): boolean {
  const edge = (parts: readonly TemplatePart[], at: number) => (parts.at(at)?.kind === "text" ? (parts.at(at) as { text: string }).text : "");
  const [callHead, routeHead, callEnd, routeEnd] = [edge(call, 0), edge(route, 0), edge(call, -1), edge(route, -1)];
  return (callHead.startsWith(routeHead) || routeHead.startsWith(callHead)) && (callEnd.endsWith(routeEnd) || routeEnd.endsWith(callEnd));
}

function splitOrigin(text: string): { origin?: string; rest: string } {
  const match = ORIGIN.exec(text);
  return match === null ? { rest: text } : { origin: match[1]!, rest: text.slice(match[1]!.length) };
}

function withOrigin(origin: string | undefined, segments: TemplateSegment[]): CallTemplate {
  return origin === undefined ? { segments } : { origin, segments };
}

function segmentsOf(path: string, side: "call" | "route"): TemplateSegment[] {
  const pathname = path.split(/[?#]/)[0] ?? "";
  return pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segmentOf(segment, side));
}

function segmentOf(segment: string, side: "call" | "route"): TemplateSegment {
  if (side === "route" && segment === "*") return { kind: "any-segment" };
  if (side === "route" && (segment === "**" || /^\{\*[^/{}]*\}$/.test(segment))) return { kind: "any-tail" };
  if (NAMED_PARAMETER.test(segment)) return { kind: "parts", parts: [{ kind: "hole" }] };
  const parts: TemplatePart[] = [];
  let at = 0;
  for (const hole of segment.matchAll(HOLE)) {
    if (hole.index > at) parts.push({ kind: "text", text: segment.slice(at, hole.index) });
    parts.push({ kind: "hole" });
    at = hole.index + hole[0].length;
  }
  if (at < segment.length) parts.push({ kind: "text", text: segment.slice(at) });
  return { kind: "parts", parts };
}
