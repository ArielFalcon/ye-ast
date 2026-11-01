import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { Handler } from "../entrypoints/http-route.ts";

/** How a call site was matched to the entrypoint it reaches. */
export type LinkBasis = "exact" | "base-path" | "suffix" | "operation-id" | "event-destination" | "gateway-prefix" | "route-overlap";

/** A call site of one repository joined to an entrypoint of another, or of its own when the transport stays inside it. */
export interface Link {
  /** Digest of every field but `confidence`: two links with one id are one link. */
  id: string;
  from: { repo: string; file: string; line: number; symbol: string };
  to: { repo: string; kind: Entrypoint["kind"]; name: string; handler: Handler };
  transport: "http" | "event";
  basis: LinkBasis;
  /** For `base-path`: the profile expressions under which the match holds; absent means the default document. */
  profiles?: readonly string[];
  confidence: number;
}

/** A link as an answer reports it: which way the change reached it, and the links crossed from the change, nearest first. */
export interface ImpactedLink {
  link: Link;
  direction: "upstream" | "downstream";
  reach: readonly string[];
}

/** What makes two links one, and what a reach names: every end, the transport and the basis, never the confidence. */
export function linkIdentity(link: Omit<Link, "id">): string {
  const { from, to, transport, basis, profiles } = link;
  return JSON.stringify([from.repo, from.file, from.line, from.symbol, to.repo, to.kind, to.name, to.handler.path, to.handler.symbol, to.handler.line, transport, basis, profiles ?? null]);
}
