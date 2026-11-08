import { createDeclarationEvidenceReader } from "../core/adapters/typescript/declaration-evidence.adapter.ts";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { ImpactQueriesDeps } from "../core/application/impact/impact-queries.ts";
import type { HeadReaderDeps } from "../core/application/snapshot/head-reading.ts";
import type { WorkspaceQueriesDeps } from "../core/application/topology/workspace-queries.ts";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type CliIo } from "../cli/main.ts";
import { createEntrypointQueries } from "../core/application/entrypoints/entrypoint-queries.ts";
import { trustOf } from "../core/application/snapshot/read-snapshot.ts";
import { openLive, type LiveDeps } from "../core/application/live/live-tree.ts";
import { exportSelection } from "../core/domain/shared/scope.ts";
import { WRITTEN_UNIVERSE_VERSION, isWritten, liveScope } from "../core/domain/snapshot/live-export.ts";
import { isExtractorConfiguration } from "../core/domain/languages/configuration.ts";
import type { IndexRetentionPolicy } from "../core/ports/index-cache.port.ts";
import type { LiveRetentionPolicy } from "../core/domain/snapshot/live-retention.ts";
import { createFixedLayerAdmin } from "../core/application/fixed-layer/fixed-layer-admin.ts";
import { createInstall } from "../core/application/install/install.ts";
import { createImpactQueries } from "../core/application/impact/impact-queries.ts";
import { createOutlineQueries } from "../core/application/outline/outline-queries.ts";
import { createTraceQueries } from "../core/application/trace/trace-queries.ts";
import { createWorkspaceQueries, createWorkspaceReadOperation } from "../core/application/topology/workspace-queries.ts";
import { createCapturedWorkspaceImpactQueries } from "../core/application/topology/workspace-impact.ts";
import { createCapturedDecisionQueries } from "../core/application/decisions/decision-queries.ts";
import { createIndexCache } from "../core/adapters/codegraph/cached-index.adapter.ts";
import { createCodeGraph, SUPPORTED_STORE } from "../core/adapters/codegraph/codegraph.adapter.ts";
import { STAGING_RULES_VERSION } from "../core/adapters/codegraph/stage-snapshot.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createFixedLayerStore } from "../core/adapters/fs/fixed-layer-store.adapter.ts";
import { createWorkspaceDefaults } from "../core/adapters/fs/workspace-defaults.adapter.ts";
import { createTrustRecords } from "../core/adapters/fs/trust-record.adapter.ts";
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
import { createHttpCallSites } from "../core/adapters/typescript/http-call-sites.adapter.ts";
import { createPatternRedaction } from "../core/adapters/redaction/pattern-redaction.adapter.ts";
import { createJavaCallSites } from "../core/adapters/spring/java-call-sites.adapter.ts";
import { createSpringRoutesExtractor } from "../core/adapters/spring/spring-routes.adapter.ts";
import { createJavaRecordsReader } from "../core/adapters/tree-sitter/java-records.adapter.ts";
import type { UnmodelledConstructsReader } from "../core/ports/unmodelled-constructs.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createJavaMemberNames } from "../core/adapters/tree-sitter/java-member-names.adapter.ts";
import { createJavaTrivia } from "../core/adapters/tree-sitter/java-trivia.adapter.ts";
import { createTypeScriptMemberNames } from "../core/adapters/typescript/declared-member-names.adapter.ts";
import { createTypeScriptTrivia } from "../core/adapters/typescript/source-trivia.adapter.ts";
import type { DeclaredMemberNamesReader } from "../core/ports/declared-member-names.port.ts";
import type { SourceTrivia } from "../core/ports/source-trivia.port.ts";
import { createAngularDeclarationReader } from "../core/adapters/typescript/angular-declarations.adapter.ts";
import { createAngularRoutesExtractor } from "../core/adapters/typescript/angular-routes.adapter.ts";
import { createDynamicLoadReader } from "../core/adapters/typescript/dynamic-loads.adapter.ts";
import { composeAngularRelations } from "./angular-relations.ts";
import { composeConsumerSources, composeContractConsequences } from "./consumer-queries.ts";
import { sortFindings } from "../core/domain/entrypoints/finding-order.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import { compareCallPlaces, type CallSiteReader, type PlacedCallSiteReader } from "../core/domain/topology/call-site.ts";
import type { EntrypointExtractor, SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import { createJavaNameBindings } from "../core/adapters/spring/java-name-bindings.adapter.ts";
import { importOriginsByLanguage } from "./import-origins-by-language.ts";
import { createModuleDependenciesReader } from "../core/adapters/typescript/module-dependencies.adapter.ts";
import { createJavaImportsReader } from "../core/adapters/spring/java-imports.adapter.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { ModuleDependenciesReader } from "../core/ports/module-dependencies.port.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { TraceQueries } from "../core/ports/trace-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { ContractConsequencesQueries } from "../core/ports/contract-consequences-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { RemoteRefresh } from "../core/ports/remote-refresh.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import type { TrustRecordReader } from "../core/ports/trust-record.port.ts";
import type { ExportBudget, Vcs } from "../core/ports/vcs.port.ts";
import { installedVersion, ownVersion } from "./installed-versions.ts";
import { measuredContractConsequences, measuredDecisions, measuredDerivedFacts, measuredStages, measuredEntrypoints, measuredGraph, measuredImpact, measuredIndexDiscard, measuredLiveMirror, measuredOutline, measuredSnapshotCache, measuredTrace, measuredWorkspace, type MeasurementSink } from "./measurement.ts";

const PRODUCER_NAME = "ye-ast";
export const LIVE_STAGING_VERSION = `${STAGING_RULES_VERSION}:${WRITTEN_UNIVERSE_VERSION}`;
const ENTRYPOINT_ENGINES = ["web-tree-sitter", "tree-sitter-java", "typescript"] as const;
const TEMPLATE_ENGINE = "@angular/compiler";
const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph";
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_CACHE_BYTES = 32 * 1024 * 1024;

/** What a host keeps of the live tree unless it overrides it (RFC-0010 "Retention"): three scopes, 14 days, 512 MiB. */
const LIVE_RETENTION: LiveRetentionPolicy = { keepScopes: 3, unusedForMs: 14 * DAY_MS, maxBytes: 512 * 1024 * 1024 };

/** What a host keeps of the full-index cache unless it overrides it (ADR-0027): the live tree's bound of unused time and of logical bytes. */
const INDEX_RETENTION: IndexRetentionPolicy = { unusedForMs: LIVE_RETENTION.unusedForMs, maxBytes: LIVE_RETENTION.maxBytes };

export interface CompositionOptions {
  /** Directory that holds the temporary exports; the system temporary directory by default. */
  scratchRoot?: string;
  /** Aborted when the process is asked to stop; never aborted by default. */
  signal?: AbortSignal;
  /** What one export may take from a commit; unbounded unless the host sets it. */
  exportBudget?: ExportBudget;
  /** Directory that keeps full indexes between calls; every call builds and discards its own when absent. */
  indexCache?: string;
  /** UTF-8 bytes retained as serialized snapshot entries, keys included; 32 MiB by default, zero disables retention. */
  snapshotCacheBytes?: number;
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
  /** How many live mirrors stay and for how long; the defaults of RFC-0010 "Retention" unless a host overrides them. */
  liveRetention?: LiveRetentionPolicy;
}

export interface ComposedQueries {
  version: string;
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  trace: TraceQueries;
  workspace: WorkspaceQueries;
  workspaceImpact: WorkspaceImpactQueries;
  /** What changing the contract of an operation, by hypothesis or between two revisions, does to the code that consumes it (RFC-0022, RFC-0023). */
  contractConsequences: ContractConsequencesQueries;
  decisions: DecisionQueries;
  redaction: Redaction;
  /** The name a repository answers to: the directory name of its main worktree, which every linked worktree shares. */
  repositoryName: Vcs["repositoryName"];
  /** Canonical filesystem root of the selected worktree. */
  canonicalRepositoryRoot: Vcs["canonicalRoot"];
  /**
   * Builds the live mirror of `repo` for the default scope when it is `trusted` and has none, so the first live query
   * finds it ready. Resolves to a redacted line describing why it could not, or `null`; it never rejects.
   */
  warmLive(repo: string, signal?: AbortSignal): Promise<string | null>;
}

export function composeQueries(options: Omit<CompositionOptions, "signal"> = {}): ComposedQueries {
  const version = ownVersion();
  const redaction = createPatternRedaction();
  const measurement = options.measure === undefined ? undefined : { sink: options.measure, redaction };
  const holds = createJavaTreeHolds();
  const javaParser = () => createJavaParser(holds);
  const staged = <T extends object>(port: T, stages: { readonly [K in keyof T]?: string }): T => (measurement === undefined ? port : measuredStages(port, stages, measurement));
  const angular = createAngularRoutesExtractor();
  const contracts = createContractRoutes();
  const extractor = staged<EntrypointExtractor>({
    extract: async (files, libraries) => {
      const spring = await createSpringRoutesExtractor(await javaParser(), contracts).extract(files, libraries);
      return sortFindings([...spring, ...(await angular.extract(files))]);
    },
  }, { extract: "entrypoints" });
  const typescriptCallSites = createHttpCallSites();
  const typescriptTrivia = createTypeScriptTrivia();
  const javaTrivia = createJavaTrivia(javaParser);
  const sourceTrivia: SourceTrivia = {
    triviaLines: async (file) => new Set([...(await typescriptTrivia.triviaLines(file)), ...(await javaTrivia.triviaLines(file))]),
  };
  const typescriptMemberNames = createTypeScriptMemberNames();
  const javaMemberNames = createJavaMemberNames(javaParser);
  const memberNames: DeclaredMemberNamesReader = {
    memberNames: async (file, facts) => {
      const [typescript, java] = [await typescriptMemberNames.memberNames(file, facts), await javaMemberNames.memberNames(file)];
      return {
        names: [...new Set([...typescript.names, ...java.names])].sort(compareText),
        functionValueCalls: [...typescript.functionValueCalls, ...java.functionValueCalls],
        callables: [...typescript.callables, ...java.callables],
        receiverBindings: [...typescript.receiverBindings, ...java.receiverBindings],
        functionValues: [...typescript.functionValues, ...java.functionValues],
        calls: [...typescript.calls ?? [], ...java.calls ?? []],
      };
    },
  };
  const callSites = staged<CallSiteReader>({
    of: async (files, repo, libraries) => {
      const java = await createJavaCallSites(await javaParser()).of(files, repo, libraries);
      return [...(await typescriptCallSites.of(files, repo)), ...java].sort(compareCallPlaces);
    },
  }, { of: "call-sites" });
  const placedCallSites = staged<PlacedCallSiteReader>({
    placed: async (files, repo) => {
      const java = await createJavaCallSites(await javaParser()).placed(files, repo);
      return [...(await typescriptCallSites.placed(files, repo)), ...java].sort(({ site: a }, { site: b }) => compareCallPlaces(a, b));
    },
  }, { placed: "call-sites" });
  const vcs = staged(createGitVcs(), { exportCommit: "export", listCommit: "export", materializeCommit: "materialize" });
  const scratch = createTempScratchDirectory(options.scratchRoot);
  const reader = createFsSourceReader();
  const digest = createSha256Digest();
  const matcher = createPathMatcher();
  const snapshotCache = { snapshotCache: createSnapshotDataCache(options.snapshotCacheBytes ?? SNAPSHOT_CACHE_BYTES, measurement === undefined ? undefined : measuredSnapshotCache(measurement)) };
  const entrypointEngines = Object.fromEntries(ENTRYPOINT_ENGINES.map((name) => [name, installedVersion(name)]));
  const budget = options.exportBudget && { budget: options.exportBudget };
  const trust = options.trustDirectory === undefined ? undefined : { trust: reportingFaultOnce(createTrustRecords(options.trustDirectory), redaction, options.reportTrustFault) };
  const graph = measurement === undefined ? createCodeGraph() : measuredGraph(createCodeGraph(), measurement);
  const codegraph = installedVersion(CODEGRAPH_PACKAGE);
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
  };
  const bareEntrypoints = createEntrypointQueries({ vcs, scratch, holds, reader, extractor, digest, matcher, producer: { name: PRODUCER_NAME, version }, engines: entrypointEngines, live, ...snapshotCache, ...budget, ...trust });
  const entrypoints = measurement === undefined ? bareEntrypoints : measuredEntrypoints(bareEntrypoints, measurement);
  const indexes = options.indexCache === undefined ? undefined : createIndexCache({ directory: options.indexCache, graph, digest, codegraph, retention: options.indexRetention ?? INDEX_RETENTION, ...(measurement && { onDiscard: measuredIndexDiscard(measurement) }) });
  const moduleDependencies = staged(createModuleDependenciesReader(), { extract: "module-dependencies" });
  let javaImportsReader: Promise<ModuleDependenciesReader> | undefined;
  const javaImports = staged<ModuleDependenciesReader>({ extract: async (sources, options) => (await (javaImportsReader ??= javaParser().then(createJavaImportsReader))).extract(sources, options) }, { extract: "java-imports" });
  const importOrigins = (sources: readonly SourceFile[], paths?: readonly string[], facts?: DerivedFacts) => {
    const reader = importOriginsByLanguage([createImportOrigins(sources, facts === undefined ? {} : { facts }), createJavaNameBindings(javaParser, sources, paths)]);
    return staged(measurement === undefined || facts === undefined ? reader : measuredDerivedFacts(reader, facts, "import-origins", measurement), { origins: "import-origins", rootOrigins: "root-origins" });
  };
  const unmodelled = staged<UnmodelledConstructsReader>({ extract: async (sources) => createJavaRecordsReader(await javaParser()).extract(sources) }, { extract: "java-records" });
  const impactDeps: ImpactQueriesDeps = {
    vcs,
    scratch,
    holds,
    reader,
    extractor,
    ...snapshotCache,
    angular: staged(createAngularDeclarationReader(), { read: "angular-declarations" }),
    contracts,
    relations: staged(composeAngularRelations(), { extract: "relations" }),
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
    sourceTrivia,
    moduleDependencies,
    moduleReaders: [moduleDependencies, javaImports],
    declarationEvidence: createDeclarationEvidenceReader(),
    unmodelled,
    sourceSelection: isWritten,
  };
  const bareImpact = createImpactQueries(impactDeps);
  const warmLive = async (repo: string, signal?: AbortSignal): Promise<string | null> => {
    try {
      if ((await trustOf(trust ?? {}, repo)) !== "trusted") return null;
      const scope = liveScope();
      const warmed = await openLive(live, { repo, scope, selected: exportSelection(scope, matcher.matches, isExtractorConfiguration), store: true, signal }, async () => undefined);
      return warmed.ok ? null : redaction.redact(`ye-ast: live index not built (${warmed.fault.kind}): ${warmed.fault.detail}`);
    } catch (error) {
      return redaction.redact(`ye-ast: live index not built: ${redaction.redactError(error)}`);
    }
  };
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
  const bareOutline = createOutlineQueries({ ...headDeps, moduleReaders: [moduleDependencies, javaImports], unmodelled, importOrigins, memberNames });
  const outline = measurement === undefined ? bareOutline : measuredOutline(bareOutline, measurement);
  const bareTrace = createTraceQueries({
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
    engines: { ...entrypointEngines, [CODEGRAPH_PACKAGE]: codegraph, ...impactDeps.angularEngines },
    live,
    ...budget,
    ...trust,
    importOrigins,
    moduleDependencies,
    sourceTrivia,
    memberNames,
    relations: impactDeps.relations,
    callSites: placedCallSites,
    sourceSelection: isWritten,
  });
  const trace = measurement === undefined ? bareTrace : measuredTrace(bareTrace, measurement);
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
  const consumerSources = composeConsumerSources({ operation, heads: headDeps, digest, engines: { ...headDeps.engines, ...impactDeps.angularEngines }, importOrigins, memberNames, modules: moduleDependencies });
  const bareContractConsequences = composeContractConsequences({ sources: consumerSources, heads: headDeps, contracts, javaParser });
  const contractConsequences = measurement === undefined ? bareContractConsequences : measuredContractConsequences(bareContractConsequences, measurement);
  const bareDecisions = createCapturedDecisionQueries({ operation, defaults, vcs, digest });
  const decisions = measurement === undefined ? bareDecisions : measuredDecisions(bareDecisions, measurement);
  return { version, entrypoints, impact, outline, trace, workspace, workspaceImpact, contractConsequences, decisions, redaction, repositoryName: (repo, signal) => vcs.repositoryName(repo, signal), canonicalRepositoryRoot: (repo, signal) => vcs.canonicalRoot(repo, signal), warmLive };
}

export function composeCli(options: CompositionOptions = {}): (argv: readonly string[], io: CliIo) => Promise<number> {
  const queries = composeQueries(options);
  const vcs = createGitVcs();
  const store = createFixedLayerStore();
  const install = createInstall({
    vcs,
    trust: createTrustRecords(options.trustDirectory ?? null),
    exclude: createGitLocalExclude(),
    store,
    defaults: createWorkspaceDefaults(store),
    layer: createFixedLayerAdmin({ entrypoints: queries.entrypoints, store, redaction: queries.redaction }),
  });
  return (argv, io) => run(argv, io, { ...queries, install, mcpCommand: mcpCommandFor(ownEntrypoint()), signal: options.signal ?? new AbortController().signal });
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
