import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type CliIo } from "../cli/main.ts";
import { createEntrypointQueries } from "../core/application/entrypoints/entrypoint-queries.ts";
import { trustOf } from "../core/application/snapshot/read-snapshot.ts";
import { openLive, type LiveDeps } from "../core/application/live/live-tree.ts";
import { declaredScope } from "../core/domain/map/entrypoint-map.ts";
import { exportSelection, pathSelection } from "../core/domain/shared/scope.ts";
import { isWritten, liveScope } from "../core/domain/snapshot/live-export.ts";
import { isExtractorConfiguration } from "../core/domain/languages/configuration.ts";
import type { LiveRetentionPolicy } from "../core/domain/snapshot/live-retention.ts";
import { createFixedLayerAdmin } from "../core/application/fixed-layer/fixed-layer-admin.ts";
import { createInstall } from "../core/application/install/install.ts";
import { createImpactQueries } from "../core/application/impact/impact-queries.ts";
import { createOutlineQueries } from "../core/application/outline/outline-queries.ts";
import { createWorkspaceQueries } from "../core/application/topology/workspace-queries.ts";
import { createWorkspaceImpactQueries } from "../core/application/topology/workspace-impact.ts";
import { createDecisionQueries } from "../core/application/decisions/decision-queries.ts";
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
import { createJavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createAngularDeclarationReader } from "../core/adapters/typescript/angular-declarations.adapter.ts";
import { createAngularRoutesExtractor } from "../core/adapters/typescript/angular-routes.adapter.ts";
import { createDynamicLoadReader } from "../core/adapters/typescript/dynamic-loads.adapter.ts";
import { composeAngularRelations } from "./angular-relations.ts";
import { EDGE_POLICY } from "../core/domain/impact/edge-policy.ts";
import { sortFindings } from "../core/domain/entrypoints/finding-order.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { CallSiteReader } from "../core/domain/topology/call-site.ts";
import type { EntrypointExtractor, SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import { createTypeResolution } from "../core/adapters/typescript/type-resolution.adapter.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { RemoteRefresh } from "../core/ports/remote-refresh.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import type { TrustRecordReader } from "../core/ports/trust-record.port.ts";
import type { ExportBudget, Vcs } from "../core/ports/vcs.port.ts";
import { installedVersion, ownVersion } from "./installed-versions.ts";
import { measuredDecisions, measuredEntrypoints, measuredGraph, measuredImpact, measuredOutline, measuredWorkspace, type MeasurementSink } from "./measurement.ts";

const PRODUCER_NAME = "ye-ast";
const ENTRYPOINT_ENGINES = ["web-tree-sitter", "tree-sitter-java", "typescript"] as const;
const TEMPLATE_ENGINE = "@angular/compiler";
const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph";
const POLICY_DIGEST_LENGTH = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a host keeps of the live tree unless it overrides it (RFC-0010 "Retention"): three scopes, 14 days, 512 MiB. */
const LIVE_RETENTION: LiveRetentionPolicy = { keepScopes: 3, unusedForMs: 14 * DAY_MS, maxBytes: 512 * 1024 * 1024 };

export interface CompositionOptions {
  /** Directory that holds the temporary exports; the system temporary directory by default. */
  scratchRoot?: string;
  /** Aborted when the process is asked to stop; never aborted by default. */
  signal?: AbortSignal;
  /** What one export may take from a commit; unbounded unless the host sets it. */
  exportBudget?: ExportBudget;
  /** Directory that keeps full indexes between calls; every call builds and discards its own when absent. */
  indexCache?: string;
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
  /** How many live mirrors stay and for how long; the defaults of RFC-0010 "Retention" unless a host overrides them. */
  liveRetention?: LiveRetentionPolicy;
  /**
   * Directory holding the declarations of the dependencies a type layer reads, laid out like a `node_modules` tree
   * (ADR-0018). Without it no type information answers, and every fact is the one ye-ast gives today.
   */
  typeRoot?: string;
}

export interface ComposedQueries {
  version: string;
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  workspace: WorkspaceQueries;
  workspaceImpact: WorkspaceImpactQueries;
  decisions: DecisionQueries;
  redaction: Redaction;
  /** The name a repository answers to: the directory name of its main worktree, which every linked worktree shares. */
  repositoryName: Vcs["repositoryName"];
  /**
   * Builds the live mirror of `repo` for the default scope when it is `trusted` and has none, so the first live query
   * finds it ready. Resolves to a redacted line describing why it could not, or `null`; it never rejects.
   */
  warmLive(repo: string, signal?: AbortSignal): Promise<string | null>;
}

export function composeQueries(options: Omit<CompositionOptions, "signal"> = {}): ComposedQueries {
  const version = ownVersion();
  const angular = createAngularRoutesExtractor();
  const contracts = createContractRoutes();
  const extractor: EntrypointExtractor = {
    extract: async (files) => {
      const spring = await createSpringRoutesExtractor(await createJavaParser(), contracts).extract(files);
      return sortFindings([...spring, ...(await angular.extract(files))]);
    },
  };
  const typescriptCallSites = createHttpCallSites();
  const callSites: CallSiteReader = {
    of: async (files, repo, libraries) => {
      const java = await createJavaCallSites(await createJavaParser()).of(files, repo, libraries);
      return [...(await typescriptCallSites.of(files, repo)), ...java].sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol));
    },
  };
  const vcs = createGitVcs();
  const scratch = createTempScratchDirectory(options.scratchRoot);
  const reader = createFsSourceReader();
  const digest = createSha256Digest();
  const matcher = createPathMatcher();
  const entrypointEngines = Object.fromEntries(ENTRYPOINT_ENGINES.map((name) => [name, installedVersion(name)]));
  const budget = options.exportBudget && { budget: options.exportBudget };
  const redaction = createPatternRedaction();
  const measurement = options.measure === undefined ? undefined : { sink: options.measure, redaction };
  const trust = options.trustDirectory === undefined ? undefined : { trust: reportingFaultOnce(createTrustRecords(options.trustDirectory), redaction, options.reportTrustFault) };
  const graph = measurement === undefined ? createCodeGraph() : measuredGraph(createCodeGraph(), measurement);
  const codegraph = installedVersion(CODEGRAPH_PACKAGE);
  const live: LiveDeps = {
    workingTree: createGitWorkingTree(),
    mirror: createLiveMirror({ ...defaultLiveMirrorDeps, writes: isWritten }),
    graph,
    digest,
    versions: { codegraph, store: JSON.stringify(SUPPORTED_STORE), staging: STAGING_RULES_VERSION },
    retention: options.liveRetention ?? LIVE_RETENTION,
    now: () => Date.now(),
  };
  const bareEntrypoints = createEntrypointQueries({ vcs, scratch, reader, extractor, digest, matcher, producer: { name: PRODUCER_NAME, version }, engines: entrypointEngines, live, ...budget, ...trust });
  const entrypoints = measurement === undefined ? bareEntrypoints : measuredEntrypoints(bareEntrypoints, measurement);
  const indexes = options.indexCache === undefined ? undefined : createIndexCache({ directory: options.indexCache, graph, digest, codegraph });
  const typeRoot =
    options.typeRoot === undefined
      ? undefined
      : {
          identity: digest.of(`type-root\u0000${options.typeRoot}`),
          resolution: (sources: readonly SourceFile[]) => createTypeResolution({ sources: sources.map(({ path, content }) => ({ path, text: content })), typeRoot: options.typeRoot as string }),
        };
  const bareImpact = createImpactQueries({
    vcs,
    scratch,
    reader,
    extractor,
    angular: createAngularDeclarationReader(),
    relations: composeAngularRelations(),
    dynamicLoads: createDynamicLoadReader(),
    graph,
    ...(indexes && { indexes }),
    digest,
    matcher,
    producer: { name: PRODUCER_NAME, version: `${version}+edge-policy.${digest.of(JSON.stringify(EDGE_POLICY)).slice(0, POLICY_DIGEST_LENGTH)}` },
    engines: { ...entrypointEngines, [CODEGRAPH_PACKAGE]: codegraph },
    angularEngines: { [TEMPLATE_ENGINE]: installedVersion(TEMPLATE_ENGINE) },
    live,
    ...budget,
    ...trust,
    ...(typeRoot === undefined ? {} : { typeRoot }),
    importOrigins: (sources: readonly SourceFile[]) => createImportOrigins(sources),
  });
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
  const bareOutline = createOutlineQueries({
    vcs,
    scratch,
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
  });
  const outline = measurement === undefined ? bareOutline : measuredOutline(bareOutline, measurement);
  const defaults = createWorkspaceDefaults(createFixedLayerStore());
  const refresh = options.refresh ?? (options.cacheDirectory === undefined ? undefined : createRemoteRefresh({ ...defaultRemoteRefreshDeps, cacheDirectory: options.cacheDirectory, digest }));
  const bareWorkspace = createWorkspaceQueries({
    vcs,
    scratch,
    reader,
    extractor,
    digest,
    matcher,
    callSites,
    evidence: createWorkspaceEvidence(),
    producer: { name: PRODUCER_NAME, version },
    engines: entrypointEngines,
    defaults,
    ...(refresh === undefined ? {} : { refresh }),
    ...budget,
    ...trust,
  });
  const workspace = measurement === undefined ? bareWorkspace : measuredWorkspace(bareWorkspace, measurement);
  // The workspace impact is measured through the impact family it walks with; handing it the measured workspace would
  // write a second line for the read it shares with that walk.
  const workspaceImpact = createWorkspaceImpactQueries({ workspace: bareWorkspace, impact, defaults, ...trust });
  const bareDecisions = createDecisionQueries({ workspace: bareWorkspace, defaults, vcs });
  const decisions = measurement === undefined ? bareDecisions : measuredDecisions(bareDecisions, measurement);
  return { version, entrypoints, impact, outline, workspace, workspaceImpact, decisions, redaction, repositoryName: (repo, signal) => vcs.repositoryName(repo, signal), warmLive };
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
