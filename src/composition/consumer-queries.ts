import { createTemplateFlowReader } from "../core/adapters/angular-compiler/template-flow.adapter.ts";
import { createAngularMetadataReader } from "../core/adapters/typescript/angular-metadata.adapter.ts";
import { createConsumerFlowReader } from "../core/adapters/typescript/consumer-flow.adapter.ts";
import { composeAngularRelations } from "./angular-relations.ts";
import { createConsumerQueries } from "../core/application/contracts/consumer-queries.ts";
import { createConsumerSources } from "../core/application/contracts/consumer-sources.ts";
import type { HeadReaderDeps } from "../core/application/snapshot/head-reading.ts";
import type { WorkspaceReadOperation } from "../core/application/topology/workspace-operation.ts";
import type { ConsumerQueries } from "../core/ports/consumer-queries.port.ts";
import type { ImportOriginsReader } from "../core/ports/import-origins.port.ts";
import type { Digest } from "../core/ports/digest.port.ts";

/** The consequences of a contract change over the workspace read, the TypeScript flow reader and the Angular template reader. */
export function composeConsumerQueries(deps: { operation: WorkspaceReadOperation; heads: HeadReaderDeps; digest: Digest; importOrigins: ImportOriginsReader }): ConsumerQueries {
  return createConsumerQueries({
    sources: createConsumerSources({ ...deps, flow: createConsumerFlowReader, metadata: createAngularMetadataReader(), templateFlow: createTemplateFlowReader(), relations: composeAngularRelations() }),
  });
}
