import type { Cut } from "../shared/fact.ts";
import { placeAt } from "../impact/impact-cuts.ts";
import { unresolvedCallSite, type CallSite, type UnresolvedCallSite } from "../topology/call-site.ts";
import type { DataEffectSite } from "./data-effect-site.ts";
import type { TraceEffect } from "./trace-fact.ts";

/**
 * What a call site the RFC-0011 extraction reads is in a trace (R12): an effect with its kind and target when the
 * extraction resolves the target, otherwise an `unresolved-link` cut at its place naming the library it goes through.
 * The kind is the extraction's transport, never a guess from a name.
 */
export function effectOf(site: CallSite | DataEffectSite): { effect: TraceEffect } | { cut: Cut; request?: UnresolvedCallSite } {
  if (!("transport" in site)) return site.effect === undefined ? { cut: unplacedEffect(site) } : { effect: site.effect };
  const kind = site.transport === "http" ? "http" : "message";
  const { target } = site;
  if (target.status === "complete") {
    if (kind === "http" && "path" in target.value) return { effect: { kind, line: site.line, target: target.value } };
    if (kind === "message" && "destination" in target.value) return { effect: { kind, line: site.line, target: target.value } };
  }
  return { cut: unplacedEffect(site), ...(site.stated?.expressions === undefined ? {} : { request: unresolvedCallSite(site) }) };
}

/** A call site the trace cannot carry as an effect: a cut at its place, naming the library its target goes through when the extraction names one. */
export function unplacedEffect(site: CallSite | DataEffectSite): Cut {
  if (!("transport" in site)) return unplacedAt(placeAt(site.file, site.line, "data effect"));
  const kind = site.transport === "http" ? "http" : "message";
  const via = site.target.status === "unknown" ? site.target.evidence[0]?.via : undefined;
  return unplacedAt(placeAt(site.file, site.line, `${kind} effect${via === undefined ? "" : ` through ${via}`}`));
}

function unplacedAt(place: string): Cut {
  return { kind: "unresolved-link", at: [place], reason: "effect-unplaced", reach: { kind: "call-at", place } };
}
