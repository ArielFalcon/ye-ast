import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import type { ChangedContract } from "../impact/changed-contracts.ts";
import { compareText } from "../shared/code-node.ts";
import type { CallPlace } from "./call-site.ts";

/** How a call site was matched to the entrypoint it reaches. */
export type LinkBasis = "exact" | "base-path" | "suffix" | "event-destination" | "gateway-prefix" | "route-overlap";

/** A call site of one repository joined to an entrypoint of another, or of its own when the transport stays inside it. */
export interface Link {
  /** Digest of every field but `confidence`: two links with one id are one link. */
  id: string;
  from: CallPlace;
  to: { repo: string; kind: Entrypoint["kind"]; name: string; handler: Handler };
  transport: "http" | "event";
  basis: LinkBasis;
  /** For `base-path`: the profile expressions under which the match holds; absent means the default document. */
  profiles?: readonly string[];
  /** `undecided` when the snapshot states the call's path but not the base URL it is sent to (ADR-0054). */
  authority?: "undecided";
  confidence: number;
}

/**
 * A call site the join reached and did not link: no route takes it and it names no host, several entrypoints take it
 * equally, or a route could take it depending on the value the code fills at run time.
 */
export interface UnlinkedCallSite {
  from: Link["from"];
  transport: Link["transport"];
  outcome: "unmatched" | "ambiguous" | "could-match";
  /** The path no route took when `unmatched`, or some could when `could-match`; the prefix or destination that matched when `ambiguous`. */
  name: string;
  /** The repositories that matched equally, sorted; only when `ambiguous`. */
  repos?: readonly string[];
  /** The routes that took the call equally, sorted; only when an HTTP call is `ambiguous`. */
  routes?: readonly string[];
}

/** The ids of the links crossed from the change, nearest first. */
export type Reach = readonly string[];

/** A link as an answer reports it: which way the change reached it, and the links crossed from the change, nearest first. */
export interface ImpactedLink {
  link: Link;
  direction: "upstream" | "downstream";
  reach: Reach;
  /**
   * The contract operations the change altered or removed that the handler the link lands in serves: the call site calls
   * the operation, which does not establish that it reads the data that changed.
   */
  operations?: readonly Omit<ChangedContract, "handlers">[];
}

/** What makes two links one, and what a reach names: every end, the transport and the basis, never the confidence. */
export function linkIdentity(link: Omit<Link, "id">): string {
  const { from, to, transport, basis, profiles, authority } = link;
  const identity = [from.repo, from.file, from.line, from.symbol, to.repo, to.kind, to.name, to.handler.path, to.handler.symbol, to.handler.line, transport, basis, profiles ?? null];
  return JSON.stringify(authority === undefined ? identity : [...identity, authority]);
}

/** The order the answer lists its links in: the place of the call site, then the identity that tells equal places apart. */
export function compareLink(a: ImpactedLink, b: ImpactedLink): number {
  return compareText(a.link.from.repo, b.link.from.repo) || compareText(a.link.from.file, b.link.from.file) || a.link.from.line - b.link.from.line || compareText(a.link.id, b.link.id);
}
