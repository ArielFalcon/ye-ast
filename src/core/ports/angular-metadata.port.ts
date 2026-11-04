import type { MemberUseOrigin, MemberProofContext } from "../domain/relations/member-use.ts";
import type { AngularClass } from "../domain/relations/angular-class.ts";
import type { FieldOrigin, LocalOrigin } from "../domain/relations/field-origin.ts";
import type { Relation } from "../domain/relations/relation.ts";
import type { Finding } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

export interface AngularMetadata {
  /** The decorated classes of the sources, sorted by file and line. */
  classes: readonly AngularClass[];
  /** The injection relations, and the unknown items of what the sources name but this reader cannot place. */
  findings: readonly Finding<Relation>[];
  /** The fields whose declaration fixes what they hold, sorted by owner and field; none whose token a provider replaces. */
  fields: readonly FieldOrigin[];
  /** The locals a function or constant takes from `inject()`, sorted by owner and local; none whose token a provider replaces. */
  locals: readonly LocalOrigin[];
  /** When present, this is the sole member-settlement evidence; an empty list authorizes no settlement. */
  memberUses?: readonly MemberUseOrigin[];
}

export interface AngularMetadataReader {
  /** Reads the Angular classes and the injection relations of the in-scope TypeScript sources. */
  read(files: readonly SourceFile[], options?: { memberProofs?: MemberProofContext }): Promise<AngularMetadata>;
}
