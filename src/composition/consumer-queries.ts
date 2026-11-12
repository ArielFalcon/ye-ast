import { missingReferences } from "../core/adapters/openapi/contract-document.adapter.ts";
import { createPayloadShapes } from "../core/adapters/openapi/payload-shapes.adapter.ts";
import { extractRoutes } from "../core/adapters/spring/spring-routes.adapter.ts";
import { createSpringPayloadShapes } from "../core/adapters/spring/spring-payload-shapes.adapter.ts";
import type { JavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createTemplateFlowReader } from "../core/adapters/angular-compiler/template-flow.adapter.ts";
import { createAngularMetadataReader } from "../core/adapters/typescript/angular-metadata.adapter.ts";
import { createConsumerReaders } from "../core/adapters/typescript/consumer-readers.ts";
import { composeAngularRelations } from "./angular-relations.ts";
import { createContractChange } from "../core/application/contracts/contract-change-queries.ts";
import { createContractConsequencesQueries } from "../core/application/contracts/contract-consequences-queries.ts";
import { createConsumerSources } from "../core/application/contracts/consumer-sources.ts";
import { createRevisionSources } from "../core/application/snapshot/revision-sources.ts";
import type { HeadReaderDeps } from "../core/application/snapshot/head-reading.ts";
import { isExtractorConfiguration } from "../core/domain/languages/configuration.ts";
import { isJavaSource, isJvmTestFile } from "../core/domain/languages/java.ts";
import type { WorkspaceReadOperation } from "../core/application/topology/workspace-operation.ts";
import type { ContractConsequencesQueries } from "../core/ports/contract-consequences-queries.port.ts";
import type { ConsumerSources } from "../core/ports/consumer-sources.port.ts";
import type { ContractRoutes } from "../core/ports/contract-routes.port.ts";
import type { PlacedCallSiteReader } from "../core/domain/topology/call-site.ts";
import type { ImportOriginsReader } from "../core/ports/import-origins.port.ts";
import type { DeclaredMemberNamesReader } from "../core/ports/declared-member-names.port.ts";
import type { ModuleDependenciesReader } from "../core/ports/module-dependencies.port.ts";
import type { RevisionSources } from "../core/ports/revision-sources.port.ts";
import type { TypeBindings } from "../core/ports/type-bindings.port.ts";
import type { DeclaredBuildOutput } from "../core/domain/shared/build-outputs.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import type { FrameworkPlugin } from "../core/ports/framework-plugin.port.ts";

/** The workspace read of consequences queries over the workspace read, the TypeScript flow and request origin readers and the Angular template reader. */
export function composeConsumerSources(deps: { operation: WorkspaceReadOperation; heads: HeadReaderDeps; digest: Digest; importOrigins: ImportOriginsReader; memberNames: DeclaredMemberNamesReader; modules: ModuleDependenciesReader; engines: Readonly<Record<string, string>>; callSites: PlacedCallSiteReader; frameworks: readonly FrameworkPlugin[]; typeBindings?: TypeBindings; checkerInputs?: RevisionSources; declaredOutputs?: (repo: string) => readonly DeclaredBuildOutput[] | undefined }): ConsumerSources {
  return createConsumerSources({ ...deps, consumerReaders: (files, repo, options) => createConsumerReaders(files, repo, undefined, deps.frameworks, options), metadata: createAngularMetadataReader(), templateFlow: createTemplateFlowReader(), relations: composeAngularRelations() });
}

/** What the shape readers read of a commit before the files its contract documents reference: Java sources, contract documents and the configuration the mapper reads. */
const isShapeSource = (path: string): boolean => (isJavaSource(path) && !isJvmTestFile(path)) || isExtractorConfiguration(path);

/**
 * What changing the contract of an operation does to the code that consumes it: for hypotheses written by hand, and for a
 * change between two revisions whose hypotheses are derived from the OpenAPI documents and then the Spring handlers. The
 * revisions are read from git at their commits under the trust declaration, and `contracts` is the one the entrypoint
 * wiring reads routes with.
 */
export function composeContractConsequences(deps: { sources: ConsumerSources; heads: HeadReaderDeps; contracts: ContractRoutes; javaParser: () => Promise<JavaParser> }): ContractConsequencesQueries {
  const revisions = createRevisionSources({ ...deps.heads, sourceSelection: isShapeSource, dependencies: missingReferences });
  let ready: Promise<ContractConsequencesQueries["ofChange"]> | undefined;
  const ofChange = (): Promise<ContractConsequencesQueries["ofChange"]> => (ready ??= deps.javaParser().then((parser) => createContractChange({
    sources: deps.sources,
    revisions,
    shapes: [createPayloadShapes(), createSpringPayloadShapes(parser, (files) => extractRoutes(parser, files, [], deps.contracts))],
  })));
  return createContractConsequencesQueries({ sources: deps.sources, ofChange: async (request) => (await ofChange())(request) });
}
