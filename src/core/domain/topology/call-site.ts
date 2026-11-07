import type { LibrarySource } from "./library-source.ts";
import type { HttpMethod } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import { declarationSpan, type Cut, type Evidence, type Finding, type UnknownReason } from "../shared/fact.ts";

/** A call one repository makes out of itself: an HTTP request or a published message, with where it is written. */
export interface CallSite {
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
  /** The request the code writes, when the snapshot decides everything about it but the base it reaches. */
  stated?: StatedRequest;
}

export const CALL_SITE_CAUSES = ["source-not-read", "request-not-found", "dispatch-disagreement", "recursive", "destination-undecidable"] as const;

export interface CallSiteDiagnostic {
  cause: (typeof CALL_SITE_CAUSES)[number];
  source?: "not-read" | "read";
  /** Library files rejected by the parser; none is asserted to declare the intermediary. */
  unreadableSources?: readonly Evidence[];
  /** The values a run-time choice in the destination takes on the branches the snapshot decides; never the destination itself. */
  alternatives?: readonly string[];
}

/** The request an HTTP call writes when the snapshot cannot decide its base: the method and the path. */
export interface StatedRequest {
  method: HttpMethod;
  path: string;
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

/** A message the code publishes. */
export interface EventTarget {
  protocol: "kafka" | "rabbit" | "jms" | "event" | "nats";
  destination: string;
  role: "publish";
}

/** The call sites of a repository's snapshot, read from its sources; reading them resolves the modules they import. */
export interface CallSiteReader {
  /**
   * `libraries` are the sources of repositories the snapshot depends on: a call through a class they declare is read
   * through their code, and none of their own calls is reported.
   */
  of(files: readonly { path: string; content: string }[], repo: string, libraries?: readonly LibrarySource[]): Promise<readonly CallSite[]>;
}

/**
 * A call site with where its call starts on `site.line`, 0-based in the language parser's own count, or `declaration`
 * when the site is a client method a declaration states (Feign, `@HttpExchange`) rather than a call. No column when no
 * call was read (a source that does not parse). Only a trace reads it; the facts that report call sites never carry it.
 */
export interface PlacedCallSite {
  site: CallSite;
  column?: number;
  declaration?: true;
}

/** The call sites of a snapshot with their exact places, read as `CallSiteReader.of` reads them. */
export interface PlacedCallSiteReader {
  placed(files: readonly { path: string; content: string }[], repo: string): Promise<readonly PlacedCallSite[]>;
}

/**
 * A call site whose target the snapshot does not decide, with what is known about it: the declaration it is written in,
 * the transport, the library it goes through and, when only the base is undecided, the request it writes. Enough to act
 * on it without opening the file.
 */
export interface UnresolvedCallSite {
  path: string;
  line: number;
  endLine?: number;
  symbol: string;
  transport: CallSite["transport"];
  reason: UnknownReason;
  evidence: readonly Evidence[];
  diagnostic?: CallSiteDiagnostic;
  /** The library the call goes through, when the snapshot names one. */
  via?: string;
  /** The request the code writes, when the snapshot decides everything but where it goes. */
  stated?: StatedRequest;
}

/** Where a call site is written in the workspace: the place a link starts from. */
export type CallPlace = Pick<CallSite, "repo" | "file" | "line" | "symbol">;

export function callPlaceOf(site: CallSite): CallPlace {
  return { repo: site.repo, file: site.file, line: site.line, symbol: site.symbol };
}

/** The order of call places: repository, file, line, then symbol. */
export function compareCallPlaces(a: CallPlace, b: CallPlace): number {
  return compareText(a.repo, b.repo) || compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol);
}

/** The order of call sites: by place, then by the status of the target at one place. */
export function compareCallSites(a: CallSite, b: CallSite): number {
  return compareCallPlaces(a, b) || compareText(a.target.status, b.target.status);
}

/** The place a call site is written, as the evidence of the finding that reports it. */
export function callSiteEvidence(site: CallSite): Evidence {
  return site.endLine === undefined ? { path: site.file, line: site.line } : { path: site.file, line: site.line, endLine: site.endLine };
}

/** A call site the join reached and could not settle, as the cut of its repository's section: its file, then its place. */
export function unsettledCallSiteCut(site: CallSite): Cut {
  return { kind: "unresolved-link", at: [site.file, `${site.file}:${site.line}`] };
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
