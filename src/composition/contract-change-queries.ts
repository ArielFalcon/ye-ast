import { createPayloadShapes } from "../core/adapters/openapi/payload-shapes.adapter.ts";
import { extractRoutes } from "../core/adapters/spring/spring-routes.adapter.ts";
import { createSpringPayloadShapes } from "../core/adapters/spring/spring-payload-shapes.adapter.ts";
import { createJavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createContractChangeQueries } from "../core/application/contracts/contract-change-queries.ts";
import { createRevisionSources } from "../core/application/snapshot/revision-sources.ts";
import type { HeadReaderDeps } from "../core/application/snapshot/head-reading.ts";
import { isExtractorConfiguration } from "../core/domain/languages/configuration.ts";
import { isJavaSource, isJvmTestFile } from "../core/domain/languages/java.ts";
import type { ContractChangeQueries } from "../core/ports/contract-change-queries.port.ts";
import type { ConsumerSources } from "../core/ports/consumer-sources.port.ts";
import type { ContractRoutes } from "../core/ports/contract-routes.port.ts";

/** What the shape readers read of a commit: Java sources, contract documents and the configuration the mapper reads. */
const isShapeSource = (path: string): boolean => (isJavaSource(path) && !isJvmTestFile(path)) || isExtractorConfiguration(path);

/**
 * What a change between two revisions did to the responses of the operations, from the OpenAPI documents and then the
 * Spring handlers, and what depends on it at the head. The revisions are read from git at their commits under the
 * trust declaration, and `contracts` is the one the entrypoint wiring reads routes with.
 */
export function composeContractChangeQueries(deps: { sources: ConsumerSources; heads: HeadReaderDeps; contracts: ContractRoutes }): ContractChangeQueries {
  const revisions = createRevisionSources({ ...deps.heads, sourceSelection: isShapeSource });
  let ready: Promise<ContractChangeQueries> | undefined;
  const queries = (): Promise<ContractChangeQueries> => (ready ??= createJavaParser().then((parser) => createContractChangeQueries({
    sources: deps.sources,
    revisions,
    shapes: [createPayloadShapes(), createSpringPayloadShapes(parser, (files) => extractRoutes(parser, files, [], deps.contracts))],
  })));
  return { consequencesOfChange: async (request) => (await queries()).consequencesOfChange(request) };
}
