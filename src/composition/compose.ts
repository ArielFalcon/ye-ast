import { createRelationExtractor } from "../core/application/relations/relation-extractor.ts";
import { createDeclarationEvidenceReader } from "../core/adapters/typescript/declaration-evidence.adapter.ts";
import { createTypeBindings } from "../core/adapters/typescript/type-bindings.adapter.ts";
import { createDeclaredTrees } from "../core/adapters/fs/declared-tree.adapter.ts";
import type { DeclaredBuildOutput } from "../core/domain/shared/build-outputs.ts";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { ImpactQueriesDeps } from "../core/application/impact/impact-queries.ts";
import type { HeadReaderDeps } from "../core/application/snapshot/head-reading.ts";
import type { WorkspaceQueriesDeps } from "../core/application/topology/workspace-queries.ts";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { takeCacheFlag } from "../cli/cache-flag.ts";
import { EXIT_CODE, run, type CliIo } from "../cli/main.ts";
import { cacheDirectoryRefusal } from "./cache-directory-refusal.ts";
import { createEntrypointQueries } from "../core/application/entrypoints/entrypoint-queries.ts";
import type { LiveDeps } from "../core/application/live/live-tree.ts";
import { WRITTEN_UNIVERSE_VERSION, isWritten } from "../core/domain/snapshot/live-export.ts";
import { isTypeCheckerInput } from "../core/domain/languages/typescript.ts";
import { createRevisionSources } from "../core/application/snapshot/revision-sources.ts";
import type { IndexRetentionPolicy } from "../core/ports/index-cache.port.ts";
import type { LiveRetentionPolicy } from "../core/domain/snapshot/live-retention.ts";
import { createFixedLayerAdmin } from "../core/application/fixed-layer/fixed-layer-admin.ts";
import { createInstall } from "../core/application/install/install.ts";
import { createImpactQueries } from "../core/application/impact/impact-queries.ts";
import { createOutlineQueries } from "../core/application/outline/outline-queries.ts";
import { createTraceQueries, type TraceQueriesDeps } from "../core/application/trace/trace-queries.ts";
import { primeLive } from "../core/application/live/live-priming.ts";
import { createWorkspaceQueries, createWorkspaceReadOperation } from "../core/application/topology/workspace-queries.ts";
import { createCapturedWorkspaceImpactQueries } from "../core/application/topology/workspace-impact.ts";
import { createCapturedDecisionQueries } from "../core/application/decisions/decision-queries.ts";
import { createIndexCache } from "../core/adapters/codegraph/cached-index.adapter.ts";
import { createDerivedFactStore } from "../core/adapters/fs/derived-fact-store.adapter.ts";
import { STORED_DERIVED_FACT_VERSIONS } from "../core/domain/snapshot/stored-derived-facts.ts";
import type { DerivedFactRetentionPolicy } from "../core/ports/derived-fact-store.port.ts";
import { createCodeGraph, defaultCodeGraphDeps, SUPPORTED_STORE } from "../core/adapters/codegraph/codegraph.adapter.ts";
import { STAGING_RULES_VERSION } from "../core/adapters/codegraph/stage-snapshot.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createJdkLibrarySource } from "../core/adapters/jdk/jdk-library.adapter.ts";
import { createFixedLayerStore } from "../core/adapters/fs/fixed-layer-store.adapter.ts";
import { createWorkspaceDefaults } from "../core/adapters/fs/workspace-defaults.adapter.ts";
import { createTrustRecords } from "../core/adapters/fs/trust-record.adapter.ts";
import { createTreeWatch } from "../core/adapters/fs/tree-watch.adapter.ts";
import { createLiveMirror, defaultLiveMirrorDeps } from "../core/adapters/fs/live-mirror.adapter.ts";
import { createFsSourceReader } from "../core/adapters/fs/fs-source-reader.adapter.ts";
import { createTempScratchDirectory } from "../core/adapters/fs/temp-scratch-directory.adapter.ts";
import { createPathMatcher } from "../core/adapters/fs/path-matcher.adapter.ts";
import { createGitLocalExclude } from "../core/adapters/git/git-local-exclude.adapter.ts";
import { createGitVcs } from "../core/adapters/git/git-vcs.adapter.ts";
import { createRemoteRefresh, defaultRemoteRefreshDeps } from "../core/adapters/git/remote-refresh.adapter.ts";
import { createGitWorkingTree } from "../core/adapters/git/git-working-tree.adapter.ts";
import { createContractRoutes } from "../core/adapters/openapi/contract-document.adapter.ts";
import { createWorkspaceEvidence } from "../core/adapters/workspace/outward-names.adapter.ts";
import { createDeferredValueReader, createHttpCallSites } from "../core/adapters/typescript/http-call-sites.adapter.ts";
import { createPatternRedaction } from "../core/adapters/redaction/pattern-redaction.adapter.ts";
import { createJavaDataEffects } from "../core/adapters/spring/data-effects.adapter.ts";
import { createJavaCallSites } from "../core/adapters/spring/java-call-sites.adapter.ts";
import { createSpringRoutesExtractor } from "../core/adapters/spring/spring-routes.adapter.ts";
import { createJavaRecordsReader } from "../core/adapters/tree-sitter/java-records.adapter.ts";
import type { UnmodelledConstructsReader } from "../core/ports/unmodelled-constructs.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createAngularDeclarationReader } from "../core/adapters/typescript/angular-declarations.adapter.ts";
import { createDynamicLoadReader } from "../core/adapters/typescript/dynamic-loads.adapter.ts";
import { composeAngularRelations } from "./angular-relations.ts";
import { composeConsumerSources, composeContractConsequences } from "./consumer-queries.ts";
import { sortFindings } from "../core/domain/entrypoints/finding-order.ts";
import { compareCallPlaces, type CallSiteReader } from "../core/domain/topology/call-site.ts";
import type { EntrypointExtractor, SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import { absentCapabilitiesOf, routedReaders } from "../core/application/snapshot/language-packs.ts";
import { composeLanguagePacks } from "./language-packs.ts";
import { createModuleDependenciesReader } from "../core/adapters/typescript/module-dependencies.adapter.ts";
import { createJavaImportsReader } from "../core/adapters/spring/java-imports.adapter.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { LibraryPlacedCallSiteReader, LibraryReading } from "../core/ports/library-signatures.port.ts";
import type { DataEffectReader } from "../core/domain/trace/data-effect-site.ts";
import type { ParseHold } from "../core/ports/parse-holds.port.ts";
import type { ModuleDependenciesReader } from "../core/ports/module-dependencies.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { RemoteRefresh } from "../core/ports/remote-refresh.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import type { TrustRecordReader } from "../core/ports/trust-record.port.ts";
import type { TreeWatch } from "../core/ports/tree-watch.port.ts";
import type { ExportBudget } from "../core/ports/vcs.port.ts";
import { installedVersion, ownVersion } from "./installed-versions.ts";
import { measuredAnswerMemo, measuredContractConsequences, measuredDecisions, measuredDerivedFacts, measuredStages, measuredTalliedStages, measuredEntrypoints, measuredGraph, measuredImpact, measuredIndexDiscard, measuredLiveMirror, measuredOutline, measuredPriming, measuredSnapshotCache, measuredTrace, measuredWatch, measuredWorkspace, stageTallies, type MeasurementSink } from "./measurement.ts";
import { composeFrameworkPlugins } from "./framework-plugins.ts";
import { frameworkEntrypoints } from "../core/application/entrypoints/framework-entrypoints.ts";
import { queriesFirst } from "./priming-turns.ts";
import { warmLive, type LiveWarmingDeps } from "../core/application/live/live-warming.ts";
import type { ComposedQueries } from "./composed-queries.ts";
import type { DaemonLink } from "../daemon/daemon-link.ts";
import { daemonBackedQueries, mcpConfiguration, requestWarm } from "./daemon-queries.ts";

const PRODUCER_NAME = "ye-ast";
export const LIVE_STAGING_VERSION = `${STAGING_RULES_VERSION}:${WRITTEN_UNIVERSE_VERSION}`;
const ENTRYPOINT_ENGINES = ["web-tree-sitter", "tree-sitter-java", "typescript"] as const;
const TEMPLATE_ENGINE = "@angular/compiler";
const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The graph images of kept indexes a process holds (ADR-0124): eight of the largest corpus store's measured charge, about 32 MiB each. */
const GRAPH_IMAGE_BYTES = 256 * 1024 * 1024;
/** The graph images of live mirrors a process holds, one per mirror (ADR-0125): four of the largest corpus store's measured charge. */
const LIVE_GRAPH_IMAGE_BYTES = 128 * 1024 * 1024;

/** What a host keeps of the live tree unless it overrides it (RFC-0010 "Retention"): three scopes, 14 days, 512 MiB. */
const LIVE_RETENTION: LiveRetentionPolicy = { keepScopes: 3, unusedForMs: 14 * DAY_MS, maxBytes: 512 * 1024 * 1024 };

/** What a host keeps of the full-index cache unless it overrides it (ADR-0027): the live tree's bound of unused time and of logical bytes. */
export const INDEX_RETENTION: IndexRetentionPolicy = { unusedForMs: LIVE_RETENTION.unusedForMs, maxBytes: LIVE_RETENTION.maxBytes };

/** What a host keeps of the stored derived facts unless it overrides it (ADR-0077 decision 9): the index cache's bound of unused time and of logical bytes, as a budget of its own. */
export const DERIVED_FACT_RETENTION: DerivedFactRetentionPolicy = { ...INDEX_RETENTION };

/** The version of the reader of each stored slot with the engines its derivations run on, so a new engine never reads what the old one stored (ADR-0077 decision 2). */
function storedReaderVersions(engines: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const identity = JSON.stringify(engines);
  return Object.fromEntries(Object.entries(STORED_DERIVED_FACT_VERSIONS).map(([slot, version]) => [slot, `${version}|${identity}`]));
}

export interface CompositionOptions {
  /** Directory that holds the temporary exports; the system temporary directory by default. */
  scratchRoot?: string;
  /** Aborted when the process is asked to stop; never aborted by default. */
  signal?: AbortSignal;
  /** What one export may take from a commit; unbounded unless the host sets it. */
  exportBudget?: ExportBudget;
  /** Directory that keeps full indexes between calls; every call builds and discards its own when absent. */
  indexCache?: string;
  /** Heap bytes retained as decoded snapshot entries, charged from their serialized bytes (ADR-0147); a hard cap when set, zero disables retention; by default a floor derived from the working set of the repositories read. */
  snapshotCacheBytes?: number;
  /** Bytes of graph images of kept indexes held in memory, charged by the text and numbers they hold; 256 MiB by default. */
  graphImageBytes?: number;
  /** ye-ast's per-user cache directory; with it, a trusted repository's declared remote is refreshed into a mirror under it. */
  cacheDirectory?: string;
  /** The refresh the workspace read calls; built from `cacheDirectory` when absent, and absent leaves every read local. */
  refresh?: RemoteRefresh;
  /** Directory that holds the user's trust record; the queries read it and `install` writes it. Without one every repository is read `untrusted`. */
  trustDirectory?: string;
  /** Receives one redacted line, once per composition, when the trust record is refused or unreadable and a repository runs `untrusted` for that reason. */
  reportTrustFault?: (line: string) => void;
  /** Receives one measurement line per query and per index build; without it nothing is measured. */
  measure?: MeasurementSink;
  /** How long a kept full index may go unused and how many logical bytes the index cache may occupy; the live tree's bounds unless a host overrides them. */
  indexRetention?: IndexRetentionPolicy;
  /** How long a stored derived fact may go unread and how many logical bytes they may occupy; the index cache's bounds unless a host overrides them. */
  derivedFactRetention?: DerivedFactRetentionPolicy;
  /** How many live mirrors stay and for how long; the defaults of RFC-0010 "Retention" unless a host overrides them. */
  liveRetention?: LiveRetentionPolicy;
  /**
   * The build outputs the host's own install produced for the repository at a root a request names (ADR-0037), for a
   * request that declares none itself; none by default.
   */
  buildOutputs?: (repo: string) => readonly DeclaredBuildOutput[] | undefined;
  /** The watcher `warmLive` keeps on a trusted live tree to refresh it ahead of the next query (ADR-0152); the platform's recursive watcher by default. */
  treeWatch?: TreeWatch;
}

export type { ComposedQueries } from "./composed-queries.ts";

export function composeQueries(options: CompositionOptions = {}): ComposedQueries {
  const version = ownVersion();
  const redaction = createPatternRedaction();
  const measurement = options.measure === undefined ? undefined : { sink: options.measure, redaction, tallies: stageTallies() };
  const holds = createJavaTreeHolds();
  const javaParser = async () => {
    const parser = await createJavaParser(holds);
    return measurement === undefined ? parser : measuredTalliedStages(parser, { parse: "java-parse" }, measurement);
  };
  const staged = <T extends object>(port: T, stages: { readonly [K in keyof T]?: string }): T => (measurement === undefined ? port : measuredStages(port, stages, measurement));
  const frameworks = composeFrameworkPlugins();
  const contracts = createContractRoutes();
  const extractor = staged<EntrypointExtractor>({
    extract: async (files, libraries, reading) => {
      const spring = await createSpringRoutesExtractor(await javaParser(), contracts).extract(files, libraries, reading);
      const routes = await frameworkEntrypoints(frameworks, files, reading?.facts);
      return { findings: sortFindings([...spring.findings, ...routes.findings]), readingCuts: routes.readingCuts };
    },
  }, { extract: "entrypoints" });
  const typescriptFrameworks = frameworks.filter((plugin) => plugin.languages.includes("typescript"));
  const typescriptCallSites = createHttpCallSites(typescriptFrameworks.flatMap((plugin) => plugin.values ?? []), typescriptFrameworks.flatMap((plugin) => plugin.cells ?? []));
  const callSites = staged<CallSiteReader>({
    of: async (files, repo, libraries, options) => {
      const java = await createJavaCallSites(await javaParser()).of(files, repo, libraries);
      return [...(await typescriptCallSites.of(files, repo, libraries, options)), ...java].sort(compareCallPlaces);
    },
  }, { of: "call-sites" });
  const placedCallSites = staged<LibraryPlacedCallSiteReader>({
    placed: async (files, repo, libraries, options) => {
      const java = await createJavaCallSites(await javaParser()).placed(files, repo, libraries, options);
      return [...(await typescriptCallSites.placed(files, repo, libraries, options)), ...java].sort(({ site: a }, { site: b }) => compareCallPlaces(a, b));
    },
  }, { placed: "call-sites" });
  const vcs = staged(createGitVcs(), { resolveCommit: "resolve-commit", exportCommit: "export", listCommit: "export", materializeCommit: "materialize" });
  const scratch = createTempScratchDirectory(options.scratchRoot);
  const reader = createFsSourceReader();
  const digest = createSha256Digest();
  const matcher = createPathMatcher();
  const entrypointEngines = Object.fromEntries(ENTRYPOINT_ENGINES.map((name) => [name, installedVersion(name)]));
  const derivedFactDisk = options.indexCache === undefined ? undefined : { store: createDerivedFactStore({ directory: options.indexCache, digest, retention: options.derivedFactRetention ?? DERIVED_FACT_RETENTION }), versions: storedReaderVersions(entrypointEngines) };
  const snapshotCache = {
    snapshotCache: createSnapshotDataCache(options.snapshotCacheBytes ?? "working-set", measurement === undefined ? undefined : measuredSnapshotCache(measurement)),
    ...(derivedFactDisk && { derivedFactDisk }),
    ...(measurement && { answerMemo: measuredAnswerMemo(measurement) }),
  };
  const budget = options.exportBudget && { budget: options.exportBudget };
  const trust = options.trustDirectory === undefined ? undefined : { trust: reportingFaultOnce(createTrustRecords(options.trustDirectory), redaction, options.reportTrustFault) };
  const bareGraph = createCodeGraph(defaultCodeGraphDeps, { liveImageBytes: LIVE_GRAPH_IMAGE_BYTES, shutdown: options.signal });
  const graph = measurement === undefined ? bareGraph : measuredGraph(bareGraph, measurement);
  const codegraph = installedVersion(CODEGRAPH_PACKAGE);
  const keptGraph = createCodeGraph(defaultCodeGraphDeps, { imageBytes: options.graphImageBytes ?? GRAPH_IMAGE_BYTES, shutdown: options.signal });
  const indexes = options.indexCache === undefined ? undefined : createIndexCache({ directory: options.indexCache, graph: measurement === undefined ? keptGraph : measuredGraph(keptGraph, measurement), digest, codegraph, retention: options.indexRetention ?? INDEX_RETENTION, ...(measurement && { onDiscard: measuredIndexDiscard(measurement) }) });
  const bareLiveMirror = createLiveMirror({ ...defaultLiveMirrorDeps, writes: isWritten });
  const liveMirror = measurement === undefined ? bareLiveMirror : measuredLiveMirror(bareLiveMirror, measurement);
  const live: LiveDeps = {
    workingTree: staged(createGitWorkingTree(), { list: "live-list" }),
    mirror: liveMirror,
    graph,
    digest,
    versions: { codegraph, store: JSON.stringify(SUPPORTED_STORE), staging: LIVE_STAGING_VERSION },
    retention: options.liveRetention ?? LIVE_RETENTION,
    now: () => Date.now(),
    newStoreGeneration: () => randomUUID(),
    indexes,
  };
  const bareEntrypoints = createEntrypointQueries({ vcs, scratch, holds, reader, extractor, digest, matcher, producer: { name: PRODUCER_NAME, version }, engines: entrypointEngines, live, snapshotCache: snapshotCache.snapshotCache, ...budget, ...trust });
  const entrypoints = measurement === undefined ? bareEntrypoints : measuredEntrypoints(bareEntrypoints, measurement);
  const moduleDependencies = staged(createModuleDependenciesReader(), { extract: "module-dependencies" });
  let javaImportsReader: Promise<ModuleDependenciesReader> | undefined;
  const javaImports = staged<ModuleDependenciesReader>({ extract: async (sources, options) => (await (javaImportsReader ??= javaParser().then(createJavaImportsReader))).extract(sources, options) }, { extract: "java-imports" });
  const packs = composeLanguagePacks(javaParser, { typescript: moduleDependencies, java: javaImports });
  const merged = routedReaders(packs);
  const { sourceTokens, modules: moduleReader } = merged;
  const memberNames = measurement === undefined ? merged.memberNames : measuredTalliedStages(merged.memberNames, { memberNames: "member-names" }, measurement);
  const importOrigins = (sources: readonly SourceFile[], paths?: readonly string[], facts?: DerivedFacts, hold?: ParseHold, context?: readonly SourceFile[], libraries?: LibraryReading) => {
    const reader = merged.importOrigins(sources, paths, facts, hold, context, libraries);
    return staged(measurement === undefined || facts === undefined ? reader : measuredDerivedFacts(reader, facts, "import-origins", measurement), { origins: "import-origins", rootOrigins: "root-origins", rootBindings: "root-bindings", receiverMethods: "receiver-methods", declaredTypes: "declared-types" });
  };
  const unmodelled = staged<UnmodelledConstructsReader>({ extract: async (sources) => createJavaRecordsReader(await javaParser()).extract(sources) }, { extract: "java-records" });
  const impactDeps: ImpactQueriesDeps = {
    frameworks,
    vcs,
    scratch,
    holds,
    reader,
    extractor,
    ...snapshotCache,
    angular: staged(createAngularDeclarationReader(), { read: "angular-declarations" }),
    contracts,
    relations: staged(createRelationExtractor(composeAngularRelations(), merged.relations), { extract: "relations" }),
    dynamicLoads: staged(createDynamicLoadReader(), { extract: "dynamic-loads" }),
    graph,
    ...(indexes && { indexes }),
    digest,
    matcher,
    producer: { name: PRODUCER_NAME, version },
    engines: { ...entrypointEngines, [CODEGRAPH_PACKAGE]: codegraph },
    angularEngines: { [TEMPLATE_ENGINE]: installedVersion(TEMPLATE_ENGINE) },
    live,
    ...budget,
    ...trust,
    importOrigins,
    memberNames,
    tokens: sourceTokens,
    moduleDependencies,
    moduleReader,
    declarationEvidence: createDeclarationEvidenceReader(),
    unmodelled,
    absentCapabilities: absentCapabilitiesOf(packs),
    sourceSelection: isWritten,
    typeBindings: createTypeBindings({ trees: createDeclaredTrees(), digest, shutdown: options.signal }),
    ...(options.buildOutputs === undefined ? {} : { declaredOutputs: options.buildOutputs }),
  };
  const bareImpact = createImpactQueries(impactDeps);
  const impact = measurement === undefined ? bareImpact : measuredImpact(bareImpact, measurement);
  const headDeps: HeadReaderDeps & Pick<ImpactQueriesDeps, "engines"> = {
    ...snapshotCache,
    vcs,
    scratch,
    holds,
    reader,
    extractor,
    graph,
    ...(indexes && { indexes }),
    digest,
    matcher,
    producer: { name: PRODUCER_NAME, version },
    engines: { ...entrypointEngines, [CODEGRAPH_PACKAGE]: codegraph },
    live,
    ...budget,
    ...trust,
    sourceSelection: isWritten,
  };
  const bareOutline = createOutlineQueries({
    frameworks,
    ...headDeps,
    moduleReader,
    unmodelled,
    importOrigins,
    memberNames,
    relations: impactDeps.relations,
    typeBindings: impactDeps.typeBindings,
    checkerInputs: createRevisionSources({ ...headDeps, sourceSelection: isTypeCheckerInput }),
    ...(options.buildOutputs === undefined ? {} : { declaredOutputs: options.buildOutputs }),
  });
  const outline = measurement === undefined ? bareOutline : measuredOutline(bareOutline, measurement);
  const defaults = createWorkspaceDefaults(createFixedLayerStore());
  const refresh = options.refresh ?? (options.cacheDirectory === undefined ? undefined : createRemoteRefresh({ ...defaultRemoteRefreshDeps, cacheDirectory: options.cacheDirectory, digest }));
  const workspaceDeps: WorkspaceQueriesDeps = {
    ...snapshotCache,
    vcs,
    scratch,
    holds,
    reader,
    extractor,
    digest,
    matcher,
    callSites,
    graph,
    live,
    evidence: createWorkspaceEvidence(),
    producer: { name: PRODUCER_NAME, version },
    engines: entrypointEngines,
    defaults,
    ...(refresh === undefined ? {} : { refresh }),
    ...budget,
    ...trust,
  };
  const operation = createWorkspaceReadOperation(workspaceDeps);
  const traceDeps: TraceQueriesDeps = {
    frameworks,
    deferredValues: createDeferredValueReader(typescriptFrameworks.flatMap((plugin) => plugin.deferrals ?? [])),
    workspace: operation,
    holds,
    ...snapshotCache,
    vcs,
    scratch,
    reader,
    extractor,
    graph,
    ...(indexes && { indexes }),
    digest,
    matcher,
    producer: { name: PRODUCER_NAME, version },
    engines: { ...entrypointEngines, [CODEGRAPH_PACKAGE]: codegraph, ...impactDeps.angularEngines },
    live,
    ...budget,
    ...trust,
    importOrigins,
    moduleReader,
    tokens: sourceTokens,
    memberNames,
    relations: impactDeps.relations,
    callSites: placedCallSites,
    dataEffects: staged<DataEffectReader>({ placed: async (files, options) => createJavaDataEffects(await javaParser()).placed(files, options) }, { placed: "data-effects" }),
    sourceSelection: isWritten,
    typeBindings: impactDeps.typeBindings,
    checkerInputs: createRevisionSources({ ...headDeps, sourceSelection: isTypeCheckerInput }),
    libraries: createJdkLibrarySource(),
    ...(options.buildOutputs === undefined ? {} : { declaredOutputs: options.buildOutputs }),
  };
  const bareTrace = createTraceQueries(traceDeps);
  const trace = measurement === undefined ? bareTrace : measuredTrace(bareTrace, measurement);
  const priority = queriesFirst();
  const prime = (repo: string, repoId: string | undefined, trigger: "launch" | "watch", signal?: AbortSignal): Promise<void> => measuredPriming(async () => {
    const named = repoId === undefined ? await vcs.repositoryName(repo, signal) : { ok: true as const, value: repoId };
    const request = { repo, repoId: named.ok ? named.value : basename(repo), ...(signal === undefined ? {} : { signal }) };
    return primeLive({ ...traceDeps, memberNames: merged.memberNames }, request, priority.turns);
  }, trigger, measurement);
  const warming: LiveWarmingDeps = {
    live,
    matcher,
    redaction,
    ...trust,
    treeWatch: options.treeWatch ?? createTreeWatch(),
    turns: priority.turns,
    prime,
    reportWatch: measuredWatch(measurement),
    closing: options.signal,
  };
  const bareWorkspace = createWorkspaceQueries(workspaceDeps, operation);
  const workspace = measurement === undefined ? bareWorkspace : measuredWorkspace(bareWorkspace, measurement);
  // One measurement line per read: the workspace impact reports through the impact family it walks with.
  const workspaceImpact: WorkspaceImpactQueries = createCapturedWorkspaceImpactQueries({ operation, digest, impactAt: (context) => {
    const operationImpact = createImpactQueries({ ...impactDeps, preparation: context.preparation, heldLive: ({ repo, repoId }) => {
      const held = context.liveCaptures.get(repoId);
      return held?.repo === repo && held.repoId === repoId ? held : undefined;
    } });
    return measurement === undefined ? operationImpact : measuredImpact(operationImpact, measurement);
  } });
  const consumerSources = composeConsumerSources({ operation, heads: headDeps, digest, engines: { ...headDeps.engines, ...impactDeps.angularEngines }, importOrigins, memberNames, modules: moduleReader, callSites: placedCallSites, frameworks, ...(impactDeps.typeBindings === undefined ? {} : { typeBindings: impactDeps.typeBindings }), checkerInputs: createRevisionSources({ ...headDeps, sourceSelection: isTypeCheckerInput }), ...(options.buildOutputs === undefined ? {} : { declaredOutputs: options.buildOutputs }) });
  const bareContractConsequences = composeContractConsequences({ sources: consumerSources, heads: headDeps, contracts, javaParser });
  const contractConsequences = measurement === undefined ? bareContractConsequences : measuredContractConsequences(bareContractConsequences, measurement);
  const bareDecisions = createCapturedDecisionQueries({ operation, defaults, vcs, digest });
  const decisions = measurement === undefined ? bareDecisions : measuredDecisions(bareDecisions, measurement);
  const { counted } = priority;
  return { version, entrypoints: counted(entrypoints), impact: counted(impact), outline: counted(outline), trace: counted(trace), workspace: counted(workspace), workspaceImpact: counted(workspaceImpact), contractConsequences: counted(contractConsequences), decisions: counted(decisions), redaction, repositoryName: (repo, signal) => vcs.repositoryName(repo, signal), canonicalRepositoryRoot: (repo, signal) => vcs.canonicalRoot(repo, signal), warmLive: (repo, signal, repoId) => warmLive(warming, repo, signal, repoId) };
}

/** The CLI's composition: the library's options, the link to the per-user daemon when it is on, and where diagnostics go. */
export interface CliOptions extends CompositionOptions {
  daemon?: DaemonLink;
  report?: (line: string) => void;
}

export function composeCli(options: CliOptions = {}): (argv: readonly string[], io: CliIo) => Promise<number> {
  let standard: ReturnType<typeof cliOver> | undefined;
  return async (argv, io) => {
    const directory = takeCacheFlag(argv.slice(1))?.directory;
    if (directory === undefined) return (standard ??= cliOver(options))(argv, io);
    const refusal = await cacheDirectoryRefusal(directory);
    if (refusal !== null) {
      io.err(refusal);
      return EXIT_CODE.usage;
    }
    return cliOver({ ...options, indexCache: directory, cacheDirectory: directory })(argv, io);
  };
}

function cliOver(options: CliOptions): (argv: readonly string[], io: CliIo) => Promise<number> {
  const local = composeQueries(options);
  const { daemon } = options;
  const queries = daemon === undefined ? local : daemonBackedQueries(local, {
    link: daemon,
    startsDaemon: false,
    configuration: () => ({ ...(options.indexCache !== undefined && { indexCache: options.indexCache }), ...(options.cacheDirectory !== undefined && { cacheDirectory: options.cacheDirectory }), ...(options.trustDirectory !== undefined && { trustDirectory: options.trustDirectory }) }),
    ...(options.measure !== undefined && { measure: options.measure }),
    report: options.report ?? (() => undefined),
  });
  const vcs = createGitVcs();
  const store = createFixedLayerStore();
  const install = createInstall({
    vcs,
    trust: createTrustRecords(options.trustDirectory ?? null),
    exclude: createGitLocalExclude(),
    store,
    defaults: createWorkspaceDefaults(store),
    layer: createFixedLayerAdmin({ entrypoints: local.entrypoints, store, redaction: local.redaction }),
  });
  const signal = options.signal ?? new AbortController().signal;
  const warmInBackground = daemon === undefined ? undefined : async ({ repo, buildOutputs }: { repo: string; buildOutputs: readonly DeclaredBuildOutput[] }): Promise<void> => {
    const named = await local.repositoryName(repo, signal);
    const configuration = mcpConfiguration({ indexCache: options.indexCache, trustDirectory: options.trustDirectory, launch: { repo, outputs: buildOutputs } });
    await requestWarm(daemon, repo, named.ok ? named.value : basename(repo), configuration);
  };
  return (argv, io) => run(argv, io, { ...queries, install, mcpCommand: mcpCommandFor(ownEntrypoint()), signal, ...(warmInBackground !== undefined && { warmInBackground }) });
}

const MCP_PACKAGE = "ye-ast-mcp";

/** The entrypoint beside the running module: `main.ts` from a source checkout, `main.js` from the published build. */
function ownEntrypoint(): string {
  const own = fileURLToPath(import.meta.url);
  return join(dirname(own), `main${extname(own)}`);
}

/** The command that starts this build: an installed package is reached by name, a source checkout through `tsx`. */
export function mcpCommandFor(entrypoint: string): readonly string[] {
  return entrypoint.includes(`${sep}node_modules${sep}`) ? ["npx", "--yes", MCP_PACKAGE] : ["npx", "--yes", "tsx", entrypoint];
}

function reportingFaultOnce(records: TrustRecordReader, redaction: Redaction, report: ((line: string) => void) | undefined): TrustRecordReader {
  let reported = false;
  return {
    read: async (root) => {
      const result = await records.read(root);
      if (!result.ok && !reported) {
        reported = true;
        report?.(redaction.redact(`ye-ast: trust record ignored, running untrusted (${result.fault.kind}): ${result.fault.detail}`));
      }
      return result;
    },
  };
}
