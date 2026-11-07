/** What a call path holds where the code fills a value at run time; the extractors of every language write it. */
export const RUN_TIME_HOLE = "{}";

type TemplatePart = { kind: "text"; text: string } | { kind: "hole" };

/**
 * One segment of a path: text and holes, or a wildcard only a route states (`*` one segment, `**` or `{*name}` the rest
 * of the path, none of it included). A tail with a `minimum` takes at least that many segments.
 */
export type TemplateSegment = { kind: "parts"; parts: readonly TemplatePart[] } | { kind: "any-segment" } | { kind: "any-tail"; minimum?: number };

/** How one segment of a call unifies with the segment of a route at the same place. */
export type SegmentRule = (call: TemplateSegment, route: TemplateSegment) => Unification;

/** A call path as segments, with the scheme and authority it states when it states them. */
export interface CallTemplate {
  origin?: string;
  segments: readonly TemplateSegment[];
}

/** How a call path and a route path unify: a match counts the segments whose text both state and says whether a run-time value filled a route parameter. */
export type Unification = { outcome: "matches"; literals: number; parity: boolean } | { outcome: "could-match" } | { outcome: "cannot-match" };

export const CANNOT_MATCH: Unification = { outcome: "cannot-match" };
export const COULD_MATCH: Unification = { outcome: "could-match" };
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** A scheme and authority, the authority captured: it ends where the path, the query or the fragment starts. */
const ORIGIN = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i;
/** A `{...}` hole, with one level of braces inside for a regular expression such as `{id:\d{3}}`. */
const HOLE = /\{[^/{}]*(?:\{[^/{}]*\}[^/{}]*)*\}/g;

/**
 * A URL as a call writes it: the scheme and authority it names (`scheme://host`, or `//host`), and its path without the
 * query or the fragment, a slash before each segment.
 */
export interface CallUrl {
  origin?: string;
  path: string;
}

/** The one reading of a URL a call writes; every reader of call sites states its target through it. */
export function callUrl(text: string): CallUrl {
  const { origin, rest } = splitOrigin(text);
  return urlOf(origin, pathSegments(rest.split(/[?#]/)[0] ?? ""));
}

/** The URL parts a call writes one after another come to, as a URL resolves: a part that names an origin starts it again. */
export function joinedCallUrl(...parts: readonly string[]): CallUrl {
  let origin: string | undefined;
  let segments: string[] = [];
  for (const part of parts) {
    const read = callUrl(part);
    if (read.origin !== undefined) [origin, segments] = [read.origin, []];
    segments.push(...pathSegments(read.path));
  }
  return urlOf(origin, segments);
}

/** A URL as the one text a call target states: its origin, then its path. */
export function urlText(url: CallUrl): string {
  return `${url.origin ?? ""}${url.path}`;
}

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function urlOf(origin: string | undefined, segments: readonly string[]): CallUrl {
  const path = `/${segments.join("/")}`;
  return origin === undefined ? { path } : { origin, path };
}

/** The path a call states: a base it declares comes first, and an absolute path overrides it. */
export function callTemplate(target: { path: string; base?: string }): CallTemplate {
  const own = splitOrigin(target.path);
  if (own.origin !== undefined || target.base === undefined) return withOrigin(own.origin, segmentsOf(own.rest, "call"));
  const base = splitOrigin(target.base);
  return withOrigin(base.origin, [...segmentsOf(base.rest, "call"), ...segmentsOf(own.rest, "call")]);
}

/** Whether a call names the host it reaches; a host the code fills at run time names none. */
export function namesHost(call: CallTemplate): boolean {
  const authority = call.origin === undefined ? undefined : ORIGIN.exec(call.origin)?.[1];
  return authority !== undefined && authority !== "" && !authority.startsWith("{");
}

/** The text of the first segment a call path states, which is the prefix a gateway routes; a URI with a scheme and no host states none. */
export function prefixText(path: string): string | undefined {
  if (SCHEME.test(path) && !ORIGIN.exec(path)?.[1]) return undefined;
  const [first] = callTemplate({ path }).segments;
  return first === undefined ? undefined : literalText(first);
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
export function unify(call: readonly TemplateSegment[], route: readonly TemplateSegment[], unifySegment: SegmentRule = unifyPathSegment): Unification {
  const tail = route.findIndex((segment) => segment.kind === "any-tail");
  if (tail === -1 && call.length !== route.length) return CANNOT_MATCH;
  if (tail !== -1 && call.length < tail + tailMinimum(route[tail]!)) return CANNOT_MATCH;
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
  return could ? COULD_MATCH : { outcome: "matches", literals, parity };
}

function tailMinimum(segment: TemplateSegment): number {
  return segment.kind === "any-tail" ? (segment.minimum ?? 0) : 0;
}

function unifyPathSegment(call: TemplateSegment, route: TemplateSegment): Unification {
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
  if (routeText !== undefined) return patternOf(call.parts).test(routeText) ? COULD_MATCH : CANNOT_MATCH;
  return edgesAgree(call.parts, route.parts) ? COULD_MATCH : CANNOT_MATCH;
}

/** Whether a segment that holds values could be a text: what it states around them agrees with the text. */
export function mayHold(segment: TemplateSegment, text: string): boolean {
  return segment.kind === "parts" && patternOf(segment.parts).test(text);
}

/** Whether two segments that both hold values could be the same text: the text they start and end with agrees. */
export function mayShare(first: TemplateSegment, second: TemplateSegment): boolean {
  return first.kind === "parts" && second.kind === "parts" && edgesAgree(first.parts, second.parts);
}

/** Whether a segment is one value the code fills at run time and states nothing else. */
export function isRunTimeValue(segment: TemplateSegment): boolean {
  return segment.kind === "parts" && segment.parts.length === 1 && segment.parts[0]?.kind === "hole";
}

/**
 * A destination as segments: the tokens between its separator, or the whole name when its protocol has none. A token
 * that is one of a listener's `wildcards` stands for one token, or for one or more trailing tokens.
 */
export function destinationSegments(text: string, separator: string | undefined, wildcards?: { one: string; rest: string }): TemplateSegment[] {
  return (separator === undefined ? [text] : text.split(separator)).map((token): TemplateSegment => {
    if (token === wildcards?.one) return { kind: "any-segment" };
    if (token === wildcards?.rest) return { kind: "any-tail", minimum: 1 };
    return { kind: "parts", parts: partsOf(token) };
  });
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

/** A value the code fills ends the authority: it may hold the start of the path, so it is never read as the host. */
function splitOrigin(text: string): { origin?: string; rest: string } {
  const match = ORIGIN.exec(text);
  if (match === null) return { rest: text };
  const hole = match[0].indexOf(RUN_TIME_HOLE);
  const end = hole === -1 ? match[0].length : hole;
  return { origin: text.slice(0, end), rest: text.slice(end) };
}

function withOrigin(origin: string | undefined, segments: TemplateSegment[]): CallTemplate {
  return origin === undefined ? { segments } : { origin, segments };
}

function segmentsOf(path: string, side: "call" | "route"): TemplateSegment[] {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segmentOf(segment, side));
}

function segmentOf(segment: string, side: "call" | "route"): TemplateSegment {
  if (side === "route" && segment === "*") return { kind: "any-segment" };
  if (side === "route" && (segment === "**" || /^\{\*[^/{}]*\}$/.test(segment))) return { kind: "any-tail" };
  return { kind: "parts", parts: partsOf(segment) };
}

function partsOf(segment: string): TemplatePart[] {
  if (segment === "") return [{ kind: "text", text: "" }];
  const parts: TemplatePart[] = [];
  let at = 0;
  for (const hole of segment.matchAll(HOLE)) {
    if (hole.index > at) parts.push({ kind: "text", text: segment.slice(at, hole.index) });
    parts.push({ kind: "hole" });
    at = hole.index + hole[0].length;
  }
  if (at < segment.length) parts.push({ kind: "text", text: segment.slice(at) });
  return parts;
}
