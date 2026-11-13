import type { Cut, Evidence } from "../shared/fact.ts";
import { placeAt } from "../impact/impact-cuts.ts";
import { undecidedAuthorityTargetsOf, unresolvedCallSite, type CallSite, type PlacedCallSite, type UnresolvedCallSite } from "../topology/call-site.ts";
import type { DataEffectSite, PlacedDataEffect } from "./data-effect-site.ts";
import type { TraceEffect } from "./trace-fact.ts";

/**
 * What a call site the RFC-0011 extraction reads is in a trace (R12): an effect with its kind and target when the
 * extraction resolves the target, otherwise an `unresolved-link` cut at its place naming the library it goes through.
 * The kind is the extraction's transport, never a guess from a name. A request that states one route after a base the
 * snapshot does not decide is an effect with that route, marked `authority: "undecided"` (ADR-0069).
 */
export function effectOf(site: CallSite | DataEffectSite): { effect: TraceEffect } | { cut: Cut; request?: UnresolvedCallSite } {
  if (!("transport" in site)) return site.effect === undefined ? { cut: unplacedEffect(site) } : { effect: site.effect };
  const kind = site.transport === "http" ? "http" : "message";
  const { target } = site;
  if (target.status === "complete") {
    if (kind === "http" && "path" in target.value) return { effect: { kind, line: site.line, target: target.value } };
    if (kind === "message" && "destination" in target.value) return { effect: { kind, line: site.line, target: target.value } };
  }
  const [stated, ...alternatives] = kind === "http" ? undecidedAuthorityTargetsOf(site) : [];
  if (stated !== undefined && alternatives.length === 0) return { effect: { kind: "http", line: site.line, target: stated, authority: "undecided" } };
  return { cut: unplacedEffect(site), ...(site.stated?.expressions === undefined ? {} : { request: unresolvedCallSite(site) }) };
}

/** A call site the trace cannot carry as an effect: a cut at its place, naming the library its target goes through when the extraction names one. */
export function unplacedEffect(site: CallSite | DataEffectSite): Cut {
  if (!("transport" in site)) return unplacedAt(placeAt(site.file, site.line, "cause" in site && site.cause !== undefined ? `data effect (${site.cause})` : "data effect"));
  const kind = site.transport === "http" ? "http" : "message";
  const via = site.target.status === "unknown" ? site.target.evidence[0]?.via : undefined;
  return unplacedAt(placeAt(site.file, site.line, `${kind} effect${via === undefined ? "" : ` through ${via}`}`));
}

function unplacedAt(place: string): Cut {
  return { kind: "unresolved-link", at: [place], reason: "effect-unplaced", reach: { kind: "call-at", place } };
}

/**
 * A placed site that only stands for a call whose callee may reach a request: no propagated proof (`origins` is empty), no
 * request stated, no library named, and a cause place other than the call itself.
 */
export function mayReachRequest(placed: PlacedCallSite | PlacedDataEffect): placed is PlacedCallSite {
  if (!("origins" in placed) || placed.origins?.length !== 0 || !("transport" in placed.site)) return false;
  const { site } = placed;
  const cause = causePlace(site);
  return site.transport === "http" && site.target.status === "unknown" && site.stated === undefined && site.diagnostic !== undefined && site.target.evidence[0]?.via === undefined && cause !== undefined && !(cause.path === site.file && cause.line === site.line);
}

function causePlace(site: CallSite): Evidence | undefined {
  return site.target.status === "unknown" ? site.target.evidence.at(-1) : undefined;
}

/** The cut for a placed site: the call that may reach a request when that is all it is, otherwise the effect it could not place. */
export function cutOfPlaced(placed: PlacedCallSite | PlacedDataEffect, site: CallSite | DataEffectSite): Cut {
  if (!mayReachRequest(placed)) return unplacedEffect(site);
  const cause = causePlace(placed.site)!;
  const place = placeAt(site.file, site.line, `call that may reach a request (${placed.site.diagnostic!.cause})`);
  return { kind: "unresolved-link", at: [place, placeAt(cause.path, cause.line)], reason: "request-possible", reach: { kind: "call-at", place } };
}
