import { createDeclarationEvidenceReader } from "../core/adapters/typescript/declaration-evidence.adapter.ts";
import type { ImpactQueriesDeps } from "../core/application/impact/impact-queries.ts";
import type { WorkspaceQueriesDeps } from "../core/application/topology/workspace-queries.ts";
import { type LiveDeps } from "../core/application/live/live-tree.ts";
import { isWritten } from "../core/domain/snapshot/live-export.ts";
import { createImpactQueries } from "../core/application/impact/impact-queries.ts";
import { createWorkspaceQueries, createWorkspaceReadOperation } from "../core/application/topology/workspace-queries.ts";
import { createCapturedWorkspaceImpactQueries } from "../core/application/topology/workspace-impact.ts";
import { createCodeGraph, SUPPORTED_STORE } from "../core/adapters/codegraph/codegraph.adapter.ts";
import { LIVE_STAGING_VERSION } from "./compose.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createLiveMirror, defaultLiveMirrorDeps } from "../core/adapters/fs/live-mirror.adapter.ts";
import { createFsSourceReader } from "../core/adapters/fs/fs-source-reader.adapter.ts";
import { createTempScratchDirectory } from "../core/adapters/fs/temp-scratch-directory.adapter.ts";
import { createPathMatcher } from "../core/adapters/fs/path-matcher.adapter.ts";
import { createGitVcs } from "../core/adapters/git/git-vcs.adapter.ts";
import { createGitWorkingTree } from "../core/adapters/git/git-working-tree.adapter.ts";
import { createContractRoutes } from "../core/adapters/openapi/contract-document.adapter.ts";
import { createWorkspaceEvidence } from "../core/adapters/workspace/outward-names.adapter.ts";
import { createHttpCallSites } from "../core/adapters/typescript/http-call-sites.adapter.ts";
import { createJavaCallSites } from "../core/adapters/spring/java-call-sites.adapter.ts";
import { createSpringRoutesExtractor } from "../core/adapters/spring/spring-routes.adapter.ts";
import { createJavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createAngularDeclarationReader } from "../core/adapters/typescript/angular-declarations.adapter.ts";
import { createAngularRoutesExtractor } from "../core/adapters/typescript/angular-routes.adapter.ts";
import { createDynamicLoadReader } from "../core/adapters/typescript/dynamic-loads.adapter.ts";
import { composeAngularRelations } from "./angular-relations.ts";
import { sortFindings } from "../core/domain/entrypoints/finding-order.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { CallSiteReader } from "../core/domain/topology/call-site.ts";
import type { EntrypointExtractor, SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import { createModuleDependenciesReader } from "../core/adapters/typescript/module-dependencies.adapter.ts";
import type { TrustRecordReader } from "../core/ports/trust-record.port.ts";
import { installedVersion, ownVersion } from "./installed-versions.ts";

export function realWorkspaceFixture(scratchRoot: string, roots: readonly string[], sleep?: typeof defaultLiveMirrorDeps.sleep) {
  const version = ownVersion();
  const angular = createAngularRoutesExtractor();
  const contracts = createContractRoutes();
  const extracted: string[][] = [];
  const extractor: EntrypointExtractor = {
    extract: async (files, libraries) => {
      extracted.push(files.map(({ path }) => path));
      const spring = await createSpringRoutesExtractor(await createJavaParser(), contracts).extract(files, libraries);
      return sortFindings([...spring, ...await angular.extract(files)]);
    },
  };
  const typescriptCallSites = createHttpCallSites();
  const callSites: CallSiteReader = { of: async (files, repo, libraries) => {
    const java = await createJavaCallSites(await createJavaParser()).of(files, repo, libraries);
    return [...await typescriptCallSites.of(files, repo), ...java].sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol));
  } };
  const vcs = createGitVcs();
  const scratch = createTempScratchDirectory(scratchRoot);
  const fsReader = createFsSourceReader();
  const reads: { root: string; files: readonly SourceFile[] }[] = [];
  let guardOriginal = false;
  const reader = { read: async (root: string, paths: readonly string[]) => {
    if (guardOriginal && roots.includes(root)) throw new Error(`original source read after capture: ${root}`);
    const files = await fsReader.read(root, paths);
    reads.push({ root, files });
    return files;
  } };
  const digest = createSha256Digest();
  const matcher = createPathMatcher();
  const graph = createCodeGraph();
  const codegraph = installedVersion("@colbymchenry/codegraph");
  const engines = Object.fromEntries(["web-tree-sitter", "tree-sitter-java", "typescript"].map((name) => [name, installedVersion(name)]));
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, ...(sleep === undefined ? {} : { sleep }), writes: isWritten });
  const active = new Set<string>();
  const realLock = mirror.lock;
  mirror.lock = async (location, signal) => {
    const result = await realLock(location, signal);
    if (!result.ok) return result;
    active.add(location.repo);
    return { ok: true, value: { release: async () => { try { await result.value.release(); } finally { active.delete(location.repo); } } } };
  };
  const live: LiveDeps = { workingTree: createGitWorkingTree(), mirror, graph, digest,
    versions: { codegraph, store: JSON.stringify(SUPPORTED_STORE), staging: LIVE_STAGING_VERSION },
    retention: { keepScopes: 3, unusedForMs: 14 * 24 * 60 * 60 * 1000, maxBytes: 512 * 1024 * 1024 }, now: () => 1 };
  const trust: TrustRecordReader = { read: async (root) => ({ ok: true, value: roots.includes(root) ? "trusted" : undefined }) };
  const common = { vcs, scratch, reader, extractor, digest, matcher, graph, live, trust, producer: { name: "ye-ast", version }, engines };
  const impactDeps: ImpactQueriesDeps = { ...common, engines: { ...engines, "@colbymchenry/codegraph": codegraph },
    angular: createAngularDeclarationReader(), contracts, relations: composeAngularRelations(), dynamicLoads: createDynamicLoadReader(),
    angularEngines: { "@angular/compiler": installedVersion("@angular/compiler") },
    importOrigins: (sources) => createImportOrigins(sources), moduleDependencies: createModuleDependenciesReader(), declarationEvidence: createDeclarationEvidenceReader() };
  const workspaceDeps: WorkspaceQueriesDeps = { ...common, callSites, evidence: createWorkspaceEvidence() };
  const operation = createWorkspaceReadOperation(workspaceDeps);
  const discoveries: import("../core/ports/workspace-queries.port.ts").WorkspaceRead[] = [];
  const recordingOperation: typeof operation = { withRead: (request, use) => operation.withRead(request, (read, context) => { discoveries.push(read); return use(read, context); }) };
  const impact = createCapturedWorkspaceImpactQueries({ operation: recordingOperation, digest, impactAt: (context) => createImpactQueries({ ...impactDeps, preparation: context.preparation, heldLive: ({ repo, repoId }) => {
    const held = context.liveCaptures.get(repoId);
    return held?.repo === repo && held.repoId === repoId ? held : undefined;
  } }) });
  return { graph, impact, workspace: createWorkspaceQueries(workspaceDeps, recordingOperation), vcs, mirror, active, reads, extracted, discoveries, guard: () => { guardOriginal = true; } };
}
