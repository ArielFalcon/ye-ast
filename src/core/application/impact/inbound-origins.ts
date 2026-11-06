import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import { createInboundEdges, type InboundEdges, type InboundOccurrences } from "./inbound-edges.ts";
import type { ReferenceProofs } from "./reference-origins.ts";

/** What the Angular relation extractor read from the sources of one snapshot. */
export interface RelationOrigins {
  relations: readonly Finding<Relation>[];
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
  memberUses?: readonly MemberUseOrigin[] | undefined;
}

/**
 * What depends on a symbol of the snapshot: the code graph's edges with the injection and template relations and the
 * calls made through fields and locals the extractor placed. Test files never depend on anything, and neither does an edge
 * of `dropped` (`edgeKey`), which `EdgeTargets` judged to reach no declaration it names.
 */
export function inboundEdgesOf(store: CodeGraphReader, origins: RelationOrigins, proofs?: Pick<ReferenceProofs, "validOccurrences" | "thisMemberCalls">, dropped?: ReadonlySet<string>): InboundEdges & InboundOccurrences {
  const isTest = (path: string): boolean => kindOfChangedFile(path) === "test";
  return createInboundEdges(store, isTest, origins.relations.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])), origins.fields, origins.locals, proofs?.validOccurrences ?? new Set(), origins.memberUses, proofs?.thisMemberCalls, dropped);
}
