import type { UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import type { LanguageRelationsReader } from "../../ports/language-pack.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { ExternalMemberUseOrigin, MemberUseOrigin, MemberProofContext } from "../../domain/relations/member-use.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { Relation, SymbolRef } from "../../domain/relations/relation.ts";
import type { LanguageProfile } from "../../domain/languages/profiles.ts";
import type { Cut, Evidence, Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { TemplateEventCall, TemplateHandlerCall } from "../../ports/template-usage.port.ts";

/**
 * What the impact use case asks for language and framework relations. It lives here, not in `core/ports`, because an
 * application module answers it: the layer table reserves a port for what an adapter implements (RFC-0001).
 */
export interface RelationExtractor {
  /** The framework reader's language; source completeness bounds its member proofs. */
  language: LanguageProfile;
  /**
   * The language and framework relations the in-scope sources declare. A relation is a `complete` finding; what the sources name but cannot be placed is an `unknown` finding at its
   * location. Sorted by evidence location, then by kind and name, so the same sources give the same output. `fields`
   * describe class-field initializers, and `locals` constant locals initialized by `inject()`.
   * Presence of `memberUses`, including an empty list, supersedes field-origin settlements and local-origin member bridges.
   * `externalUses` comes with `memberUses`: the calls proven to run on a field that holds a type from outside the repository.
   */
  extract(files: readonly SourceFile[], options?: { memberProofs?: MemberProofContext; paths?: readonly string[]; completeSource?: boolean; hold?: ParseHold; signal?: AbortSignal }): Promise<RelationExtraction>;
}

export interface RelationExtraction {
  /** Unread source coverage that no narrower type name bounds. */
  cuts?: readonly Cut[];
  /** Written type occurrences left to the shared reverse frontier for query-relative attribution. */
  unresolved?: readonly UnresolvedUse[];
  relations: readonly Finding<Relation>[];
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
  memberUses?: readonly MemberUseOrigin[];
  externalUses?: readonly ExternalMemberUseOrigin[];
  /** Per component, in class order: the calls its template's render expressions and event bindings make, or where its template cannot be read. */
  templates?: readonly ComponentTemplate[];
}

export interface ComponentTemplate {
  component: SymbolRef;
  /** The lines the template text spans, where its relations and handlers are placed; absent when it was not read. */
  lines?: { path: string; start: number; end: number };
  renderHandlers?: readonly TemplateHandlerCall[];
  renderCalls?: readonly TemplateEventCall[];
  handlers: readonly TemplateHandlerCall[];
  eventCalls: readonly TemplateEventCall[];
  /** The declarations the template uses, in the order they first appear in its text. */
  uses: readonly SymbolRef[];
  /** Where no template can be read: one that does not parse or cannot be found, or a component that names none. */
  unreadable?: Evidence;
}

export function createRelationExtractor(framework: RelationExtractor, languages: LanguageRelationsReader): RelationExtractor {
  return {
    language: framework.language,
    async extract(files, options) {
      const [base, additions] = await Promise.all([framework.extract(files, options), languages.extract(files, options)]);
      return {
        ...base,
        relations: sortFindings([...base.relations, ...additions.relations]),
        cuts: [...base.cuts ?? [], ...additions.cuts],
        unresolved: [...base.unresolved ?? [], ...additions.unresolved],
      };
    },
  };
}
