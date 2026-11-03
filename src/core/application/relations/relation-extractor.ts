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
   * are the class fields whose declaration fixes what they hold, and `locals` the locals a function takes from `inject()`.
   */
  extract(files: readonly SourceFile[]): Promise<{ relations: readonly Finding<Relation>[]; fields: readonly FieldOrigin[]; locals: readonly LocalOrigin[] }>;
}
