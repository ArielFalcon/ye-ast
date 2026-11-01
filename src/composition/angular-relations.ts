import { createTemplateUsageReader } from "../core/adapters/angular-compiler/template-usage.adapter.ts";
import { createAngularMetadataReader } from "../core/adapters/typescript/angular-metadata.adapter.ts";
import { createAngularRelationExtractor } from "../core/application/relations/angular-relations.ts";
import type { RelationExtractor } from "../core/application/relations/relation-extractor.ts";

/** The Angular injection and template relations over the TypeScript reader and ye-ast's own `@angular/compiler`. */
export function composeAngularRelations(): RelationExtractor {
  return createAngularRelationExtractor({ metadata: createAngularMetadataReader(), templates: createTemplateUsageReader() });
}
