import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { FOLLOWED_EDGE_KINDS, type ReceiverSettlement } from "../../domain/impact/edge-policy.ts";
import { isTypeScriptFile } from "../../domain/languages/typescript.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import { createInboundEdges, type EdgeCorrections, type InboundEdges, type InboundOccurrences } from "./inbound-edges.ts";
import type { ReferenceProofs } from "./reference-origins.ts";
import { edgeKey, type EdgeTargets, type FollowedEdge } from "../navigation/edge-targets.ts";

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
  return createInboundEdges(store, isTest, origins.relations.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])), origins.fields, origins.locals, proofs?.validOccurrences ?? new Set(), origins.memberUses, proofs?.thisMemberCalls, corrections);
}

/**
 * How each graph edge out of the TypeScript sources among `files` whose receiver is a value is known, settled at once for
 * a reading whose callers are asked without waiting (ADR-0035).
 */
export async function receiverSettlementsOf(store: CodeGraphReader, targets: EdgeTargets, files: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, ReceiverSettlement>> {
  const sources = new Map(store.symbolsInFiles(files.filter((file) => isTypeScriptFile(file) && kindOfChangedFile(file) !== "test")).map((symbol) => [symbol.id, symbol]));
  const edges = store.outgoingEdges([...sources.keys()], FOLLOWED_EDGE_KINDS);
  const reached = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.target))]).map((symbol) => [symbol.id, symbol]));
  const followed = edges.flatMap((edge): FollowedEdge[] => {
    const source = sources.get(edge.source);
    const target = reached.get(edge.target);
    return source === undefined || target === undefined ? [] : [{ edge, source, target }];
  });
  const verdicts = await targets.verdictsOf(followed, signal);
  return new Map(followed.flatMap(({ edge }, index) => {
    const verdict = verdicts[index]!;
    return verdict.kind === "keep" && verdict.derivation !== undefined ? [[edgeKey(edge), verdict.derivation] as const] : [];
  }));
}
