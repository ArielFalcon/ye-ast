import type { CallSiteDiagnostic } from "./call-site-diagnostic.ts";
export { CALL_SITE_CAUSES, type CallSiteDiagnostic } from "./call-site-diagnostic.ts";
import type { LibrarySource } from "./library-source.ts";
import { routeAfterUndecidedBase, type RequestUrlPart } from "./request-url.ts";
import type { HttpMethod } from "../entrypoints/http-route.ts";
import { canonicalJson } from "../shared/canonical-json.ts";
import { compareText } from "../shared/code-node.ts";
import { declarationSpan, type CallSiteReach, type Cut, type Evidence, type Finding, type UnknownReason } from "../shared/fact.ts";

/** A call one repository makes out of itself: an HTTP request or a published message, with where it is written. */
export interface CallSite {
  column?: number;
  /** The repository the call site is in. */
  repo: string;
  file: string;
  line: number;
  endLine?: number;
  /** The enclosing declaration, by the entrypoint join's simple name. */
  symbol: string;
  /** Named declarations enclosing this site in the source AST, nearest first. */
  ancestors?: readonly { symbol: string; line: number; endLine: number }[];
  transport: "http" | "event";
  target: Finding<HttpTarget | EventTarget>;
  diagnostic?: CallSiteDiagnostic;
  /** The request components the code establishes independently of its undecided target. */
  stated?: StatedRequest;
}

/** The established HTTP method and, when read, its path independently of the destination base. */
export interface StatedRequest {
  method: HttpMethod;
  path?: string;
  /** Separate possible URL expressions; none asserts a normalized destination or a route match. */
  expressions?: readonly (readonly RequestUrlPart[])[];
}

/**
 * A request as the code writes it. `path` is the URL it reaches, its origin included when the code states one, as a
 * pattern: a `{}` segment is a parameter the code fills at run time. A base the snapshot does not decide makes the
 * target `unknown`.
 */
export interface HttpTarget {
  method: HttpMethod;
  path: string;
  /** A service the client names without a URL. */
  base?: string;
}

export function httpTargetOf(site: CallSite): HttpTarget | undefined {
  return site.transport === "http" && site.target.status === "complete" && "path" in site.target.value ? site.target.value : undefined;
}

/**
 * The requests a call site states when only its base is undecided: each of its URL expressions that starts with the
 * undecided base and states the path after it (ADR-0054, ADR-0057), one per distinct path. The path is relative to an
 * authority the snapshot does not decide.
 */
export function undecidedAuthorityTargetsOf(site: CallSite): readonly HttpTarget[] {
  if (site.transport !== "http" || site.target.status === "complete" || site.stated === undefined) return [];
  const { method, expressions = [] } = site.stated;
  const paths = new Set(expressions.flatMap((expression) => routeAfterUndecidedBase(expression) ?? []));
  return [...paths].sort(compareText).map((path) => ({ method, path }));
}

/** A message the code publishes. */
export interface EventTarget {
  protocol: "kafka" | "rabbit" | "jms" | "event" | "nats";
  destination: string;
  role: "publish";
  /** The RabbitMQ exchange the code publishes to when it names one other than the default, `{}` when the snapshot does not decide it. */
  exchange?: string;
}

export interface CallSiteReadOptions {
  completeSource?: boolean;
}

/** The call sites of a repository's snapshot, read from its sources; reading them resolves the modules they import. */
export interface CallSiteReader {
  /**
   * `libraries` are the sources of repositories the snapshot depends on: a call through a class they declare is read
   * through their code, and none of their own calls is reported.
   */
  of(files: readonly { path: string; content: string }[], repo: string, libraries?: readonly LibrarySource[], options?: CallSiteReadOptions): Promise<readonly CallSite[]>;
}

/**
 * A call site with where its call starts on `site.line`, 0-based in the language parser's own count, or `declaration`
 * when the site is a client method a declaration states (Feign, `@HttpExchange`) rather than a call. No column when no
 * call was read (a source that does not parse). Only a trace reads it; call-site facts carry it 1-based as
 * `CallSite.column`.
 */
export interface PlacedCallSite {
  site: CallSite;
  column?: number;
  declaration?: true;
  /** This exact occurrence is the proven issuing boundary for its represented alternatives. */
  issuingBoundary?: "site";
  /**
   * Source bodies and occurrences used by extraction; empty means no propagated proof, absent means a direct site. A
   * `body` is a method or function the request passed through, a `leaf` the call in a body that issues it.
   */
  origins?: readonly PlacedOrigin[];
}

export interface PlacedOrigin {
  kind: "body" | "leaf";
  file: string;
  line: number;
  column: number;
}

/** The call sites of a snapshot with their exact places, read as `CallSiteReader.of` reads them. */
export interface PlacedCallSiteReader {
  placed(files: readonly { path: string; content: string }[], repo: string, libraries?: readonly LibrarySource[], options?: CallSiteReadOptions): Promise<readonly PlacedCallSite[]>;
}

/**
 * A call site whose target the snapshot does not decide, with what is known about it: the declaration it is written in,
 * the transport, the library it goes through and, when only the base is undecided, the request it writes. Enough to act
 * on it without opening the file.
 */
export interface UnresolvedCallSite {
  path: string;
  line: number;
  /** 1-based, where a trace placed the call in the executed body that issues it. */
  column?: number;
  endLine?: number;
  symbol: string;
  transport: CallSite["transport"];
  reason: UnknownReason;
  evidence: readonly Evidence[];
  diagnostic?: CallSiteDiagnostic;
  /** The library the call goes through, when the snapshot names one. */
  via?: string;
  /** The request components established independently of the undecided destination. */
  stated?: StatedRequest;
  /** A trace placed it in a function value a registered combinator takes: it runs later, if at all. */
  deferred?: true;
}

/** Where a call site is written in the workspace: the place a link starts from. */
export type CallPlace = Pick<CallSite, "repo" | "file" | "line" | "column" | "symbol">;

export function callPlaceOf(site: CallPlace): CallPlace {
  const place = { repo: site.repo, file: site.file, line: site.line, symbol: site.symbol };
  return site.column === undefined ? place : { ...place, column: site.column };
}

/** Exact occurrence evidence omits the enclosing symbol and requires a column. */
export function callPlaceEvidence(site: CallPlace): (Evidence & { column: number }) | undefined {
  const { file, line, column } = callPlaceOf(site);
  return column === undefined ? undefined : { path: file, line, column };
}

/** The order of call places: repository, file, line, symbol, then an optional tiebreaker before column. */
export function compareCallPlaces(a: CallPlace, b: CallPlace, beforeColumn = 0): number {
  return compareText(a.repo, b.repo) || compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol) || beforeColumn || (a.column ?? 0) - (b.column ?? 0);
}

/** The order of the unresolved call sites of one repository: by the place each is written. */
export function compareUnresolvedCallSites(a: UnresolvedCallSite, b: UnresolvedCallSite): number {
  return compareText(a.path, b.path) || a.line - b.line || compareText(a.symbol, b.symbol);
}

/** The order of call sites: by place, then by the status of the target at one place. */
export function compareCallSites(a: CallSite, b: CallSite): number {
  return compareCallPlaces(a, b, compareText(a.target.status, b.target.status));
}

/** The place a call site is written, as the evidence of the finding that reports it. */
export function callSiteEvidence(site: CallSite): Evidence {
  return site.endLine === undefined ? { path: site.file, line: site.line } : { path: site.file, line: site.line, endLine: site.endLine };
}

/** A call site the join reached and could not settle, as the cut of its repository's section: its file, then its place. */
export function unsettledCallSiteCut(site: CallSite): Cut {
  return { kind: "unresolved-link", at: [site.file, `${site.file}:${site.line}`], reason: "join-unsettled", reach: callSiteReach(site) };
}

/** What a call site could reach, as the extractor read it: its transport, and its method and path when the snapshot states them. */
export function callSiteReach(site: CallSite): CallSiteReach {
  const request = httpTargetOf(site) ?? site.stated;
  return request === undefined ? { kind: "call-site", transport: site.transport } : { kind: "call-site", transport: site.transport, method: request.method, ...(request.path === undefined ? {} : { template: request.path }) };
}

/** A call site the snapshot cannot decide, as the workspace reports it: what is known, never only its place. */
export function unresolvedCallSite(site: CallSite): UnresolvedCallSite {
  const via = site.target.status === "unknown" ? site.target.evidence[0]?.via : undefined;
  return {
    path: site.file,
    line: site.line,
    ...declarationSpan(site.line, site.endLine),
    symbol: site.symbol,
    transport: site.transport,
    reason: site.target.status === "unknown" ? site.target.reason : "unresolved",
    evidence: site.target.evidence,
    ...(site.diagnostic === undefined ? {} : { diagnostic: site.diagnostic }),
    ...(via === undefined ? {} : { via }),
    ...(site.stated === undefined ? {} : { stated: site.stated }),
  };
}

/**
 * The unresolved call sites with the ones that differ only in evidence read as one: a call written once but read through
 * several transport primitives of a wrapper is one entry that cites every primitive. Evidence keeps its first-seen order
 * and holds each place once; the entries keep the order of their first occurrence.
 */
export function gatherUnresolvedCallSites(sites: readonly UnresolvedCallSite[]): UnresolvedCallSite[] {
  const gathered = new Map<string, UnresolvedCallSite & { evidence: Evidence[] }>();
  for (const site of sites) {
    const key = canonicalJson({ ...site, evidence: undefined });
    const held = gathered.get(key) ?? { ...site, evidence: [] };
    const known = new Set(held.evidence.map((place) => canonicalJson(place)));
    for (const place of site.evidence) if (!known.has(canonicalJson(place))) { known.add(canonicalJson(place)); held.evidence.push(place); }
    gathered.set(key, held);
  }
  return [...gathered.values()];
}
