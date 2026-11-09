import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { FOLLOWED_EDGE_KINDS, type ReceiverSettlement } from "../../domain/impact/edge-policy.ts";
import { hasTyping } from "../../domain/languages/profiles.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import { createInboundEdges, type EdgeCorrections, type InboundEdges, type InboundOccurrences } from "./inbound-edges.ts";
import type { ReferenceProofs } from "../navigation/reference-origins.ts";
import { edgeKey, type EdgeTargets, type FollowedEdge } from "../navigation/edge-targets.ts";
import type { CallBindings } from "../navigation/call-binding.ts";
import { boundThroughOrigins, callsThroughOrigins } from "../navigation/origin-calls.ts";
import type { ContradictedCalls } from "../snapshot/base-reading.ts";

/** What the Angular relation extractor read from the sources of one snapshot. */
export interface RelationOrigins {
  relations: readonly Finding<Relation>[];
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
  memberUses?: readonly MemberUseOrigin[] | undefined;
}

/**
 * What depends on a symbol of the snapshot: the code graph's edges with the injection and template relations and the
 * calls made through fields and locals the extractor placed, with the graph's edges as `EdgeTargets` corrected them. Test
 * files never depend on anything.
 */
export function inboundEdgesOf(store: CodeGraphReader, origins: RelationOrigins, proofs?: Pick<ReferenceProofs, "validOccurrences" | "thisMemberCalls">, corrections?: EdgeCorrections): InboundEdges & InboundOccurrences {
  const isTest = (path: string): boolean => kindOfChangedFile(path) === "test";
  return createInboundEdges(store, isTest, origins.relations.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])), proofs?.validOccurrences ?? new Set(), origins.memberUses, proofs?.thisMemberCalls, corrections);
}

/**
 * How each graph edge out of the TypeScript sources among `files` whose receiver is a value is known, settled at once for
 * a reading whose callers are asked without waiting (ADR-0036): kept with its settlement, or moved to the declaration the
 * base binds it to (ADR-0041 decision 4), with the member calls through the origins the base binds (`originCallsOf`).
 * A record `contradictions` names is dropped, never moved: its source writes no call at its place (ADR-0041 U6).
 */
export async function receiverCorrectionsOf(store: CodeGraphReader, targets: EdgeTargets, origins: Pick<RelationOrigins, "fields" | "locals">, files: readonly string[], signal?: AbortSignal, contradictions?: ContradictedCalls): Promise<EdgeCorrections> {
  const sources = new Map(store.symbolsInFiles(files.filter((file) => hasTyping(file, "structural") && kindOfChangedFile(file) !== "test")).map((symbol) => [symbol.id, symbol]));
  const edges = store.outgoingEdges([...sources.keys()], FOLLOWED_EDGE_KINDS);
  const reached = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.target))]).map((symbol) => [symbol.id, symbol]));
  const followed = edges.flatMap((edge): FollowedEdge[] => {
    const source = sources.get(edge.source);
    const target = reached.get(edge.target);
    return source === undefined || target === undefined ? [] : [{ edge, source, target }];
  });
  const contradicted = contradictions === undefined || followed.length === 0 ? new Set<string>() : new Set((await contradictions([...sources.values()])).keys());
  const kept = contradicted.size === 0 ? followed : followed.filter(({ edge }) => !contradicted.has(edgeKey(edge)));
  const verdicts = await targets.verdictsOf(kept, signal);
  const settled = new Map<string, ReceiverSettlement>();
  const moved = kept.flatMap((edge, index) => {
    const verdict = verdicts[index]!;
    if (verdict.kind === "keep" && verdict.derivation !== undefined) settled.set(edgeKey(edge.edge), verdict.derivation);
    return verdict.kind === "redirect" && verdict.receiver !== undefined ? [{ ...edge, target: verdict.to }] : [];
  });
  const throughOrigins = targets.bindings === undefined ? [] : await originCallsOf(store, targets.bindings, origins, signal);
  return { dropped: new Set([...contradicted, ...moved.map(({ edge }) => edgeKey(edge))]), into: Map.groupBy([...moved, ...throughOrigins], ({ target }) => target.id), settled };
}

/**
 * The member calls made through a field's or an `inject()` local's origin, `this.f.m()` in the class that declares the
 * field and `l.m()` in the declaration that takes the local, each moved to what the base binds it to (ADR-0041 decision
 * 4): the declaration it binds, or each one its receiver's type is attributed among several. A local's call counts only
 * at a site the extractor certifies.
 */
export async function originCallsOf(store: CodeGraphReader, bindings: CallBindings, origins: Pick<RelationOrigins, "fields" | "locals">, signal?: AbortSignal): Promise<readonly FollowedEdge[]> {
  return boundThroughOrigins(bindings, callsThroughOrigins(store, origins), signal);
}
