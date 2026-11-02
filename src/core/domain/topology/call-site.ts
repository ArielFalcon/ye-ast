import type { HttpMethod } from "../entrypoints/http-route.ts";
import type { Evidence, Finding } from "../shared/fact.ts";

/** A call one repository makes out of itself: an HTTP request or a published message, with where it is written. */
export interface CallSite {
  /** The repository the call site is in. */
  repo: string;
  file: string;
  line: number;
  endLine?: number;
  /** The enclosing declaration, by the entrypoint join's simple name. */
  symbol: string;
  transport: "http" | "event";
  target: Finding<HttpTarget | EventTarget>;
}

/**
 * A request as the code writes it. `path` is a pattern: a `{}` segment is a parameter the code fills at run time, and the
 * base URL is a finding of its own, `unknown` when the snapshot does not decide it.
 */
export interface HttpTarget {
  method: HttpMethod;
  path: string;
  base?: string;
  /** The contract operation a generated client names, when the call is made through one. */
  operationId?: string;
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
  of(files: readonly { path: string; content: string }[], repo: string, libraries?: readonly { path: string; content: string }[]): Promise<readonly CallSite[]>;
}

/** The place a call site is written, as the evidence of the finding that reports it. */
export function callSiteEvidence(site: CallSite): Evidence {
  return site.endLine === undefined ? { path: site.file, line: site.line } : { path: site.file, line: site.line, endLine: site.endLine };
}

/** The place of a call site whose target the snapshot does not decide, with the library the call goes through when it names one. */
export function unresolvedPlace(site: CallSite): Evidence {
  const via = site.target.status === "unknown" ? site.target.evidence[0]?.via : undefined;
  return via === undefined ? callSiteEvidence(site) : { ...callSiteEvidence(site), via };
}
