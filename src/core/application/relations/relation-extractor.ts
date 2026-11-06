import type { ExternalMemberUseOrigin, MemberUseOrigin, MemberProofContext } from "../../domain/relations/member-use.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

/**
 * What the impact use case asks for injection and template relations. It lives here, not in `core/ports`, because an
 * application module answers it: the layer table reserves a port for what an adapter implements (RFC-0001).
 */
export interface RelationExtractor {
  /**
   * The injection and template relations the in-scope sources declare: TypeScript sources and the template files they
   * name. A relation is a `complete` finding; what the sources name but cannot be placed is an `unknown` finding at its
   * location. Sorted by evidence location, then by kind and name, so the same sources give the same output. `fields`
   * describe class-field initializers, and `locals` constant locals initialized by `inject()`.
   * Presence of `memberUses`, including an empty list, supersedes field-origin settlements and local-origin member bridges.
   * `externalUses` comes with `memberUses`: the calls proven to run on a field that holds a type from outside the repository.
   */
  extract(files: readonly SourceFile[], options?: { memberProofs?: MemberProofContext }): Promise<RelationExtraction>;
}

export interface RelationExtraction {
  relations: readonly Finding<Relation>[];
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
  memberUses?: readonly MemberUseOrigin[];
  externalUses?: readonly ExternalMemberUseOrigin[];
}
