import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, realpath, rm } from "node:fs/promises";
import type { CodeGraph as SdkGraph, Edge, Node } from "@colbymchenry/codegraph";
import type { Result } from "../../domain/shared/result.ts";
import {
  INDEX_STORE_DIRECTORY,
  type CodeGraph,
  type CodeGraphFault,
  type CodeGraphReader,
  type GraphEdge,
  type GraphNodeId,
  type GraphSymbol,
  type GraphUnresolvedReference,
  type IndexSummary,
  type MirrorSyncSummary,
  type StoreVersions,
} from "../../ports/code-graph.port.ts";
import { isEngineEntry } from "../../ports/staging-rules.ts";
import { removeStaged, stageSnapshot } from "./stage-snapshot.ts";
import { readStoredVersions, SUPPORTED_STORE, unsupportedVersions } from "./store-version.ts";

export { SUPPORTED_STORE };

type Sdk = typeof import("@colbymchenry/codegraph");

export interface IndexerRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CodeGraphDeps {
  /** The environment the indexer's own is derived from; only the variables the engine needs to run are passed on. */
  environment: NodeJS.ProcessEnv;
  /** The compiled library inside the platform package installed in `node_modules`, or `null` when it is not there. */
  resolveBundle(): string | null;
  loadSdk(bundle: string): Sdk;
  /** Runs the indexer child process to its end. Aborting `signal` kills it. */
  runIndexer(command: string, args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<IndexerRun>;
}

/**
 * The sibling script of the running module, with that module's own extension: the emitted `.js` of a published build, or
 * the `.ts` of a source checkout. A literal `.ts` here names a file the published build never carries.
 */
export function siblingScript(moduleUrl: string, name: string): string {
  return fileURLToPath(new URL(`./${name}${extname(fileURLToPath(moduleUrl))}`, moduleUrl));
}

const CHILD_SCRIPT = siblingScript(import.meta.url, "index-snapshot.child");
const SYNC_SCRIPT = siblingScript(import.meta.url, "sync-mirror.child");
const INHERITED_VARIABLES = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot"] as const;
const ABORTED: Result<never, CodeGraphFault> = { ok: false, fault: { kind: "aborted", detail: "interrupted by the caller" } };
const STDERR_DETAIL_BYTES = 2000;
const NO_LIMIT = -1;
const ENGINE_VARIABLES = { DO_NOT_TRACK: "1", CODEGRAPH_DIR: INDEX_STORE_DIRECTORY } as const;

export const defaultCodeGraphDeps: CodeGraphDeps = {
  environment: process.env,
  resolveBundle,
  loadSdk: (bundle) => createRequire(import.meta.url)(bundle) as Sdk,
  runIndexer: (command, args, env, signal) =>
    new Promise((settle) => {
      const child = spawn(command, args, { env, signal, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => settle({ code: null, stdout, stderr: `${stderr}${error.message}` }));
      child.on("close", (code) => settle({ code, stdout, stderr }));
    }),
};

/**
 * Loads the library from the platform package that sits beside the main package in `node_modules`, never through the
 * main package's entry point, which falls back to a bundle cached outside the lockfile.
 */
function resolveBundle(): string | null {
  try {
    const main = createRequire(import.meta.url).resolve("@colbymchenry/codegraph/package.json");
    return createRequire(main).resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/lib/dist/index.js`);
  } catch {
    return null;
  }
}

export function createCodeGraph(deps: CodeGraphDeps = defaultCodeGraphDeps): CodeGraph {
  function openGraph(store: string): Result<{ sdk: Sdk; graph: SdkGraph; versions: StoreVersions }, CodeGraphFault> {
    const bundle = deps.resolveBundle();
    if (bundle === null) return platformPackageMissing();
    try {
      const sdk = deps.loadSdk(bundle);
      const root = resolve(store);
      const opened = withEngineEnvironment(() => {
        if (!sdk.CodeGraph.isInitialized(root)) return null;
        return { stored: readStoredVersions(sdk, root), graph: sdk.CodeGraph.openSync(root, { readOnly: true }) };
      });
      if (opened === null) return fault("store-unreadable", `${root} holds no codegraph store`);
      const { stored, graph } = opened;
      const codegraph = graph.getIndexBuildInfo().version;
      const unsupported = unsupportedVersions(stored, codegraph);
      if (unsupported !== null) {
        graph.close();
        return { ok: false, fault: unsupported };
      }
      return { ok: true, value: { sdk, graph, versions: { codegraph: codegraph!, schema: stored.schema!, extraction: stored.extraction! } } };
    } catch (error) {
      return fault("store-unreadable", errorDetail(error));
    }
  }

  function open(store: string): Result<CodeGraphReader, CodeGraphFault> {
    const opened = openGraph(store);
    return opened.ok ? { ok: true, value: createReader(opened.value.graph, opened.value.versions) } : opened;
  }

  async function index(snapshot: string, store: string, signal?: AbortSignal): Promise<Result<IndexSummary, CodeGraphFault>> {
    if (signal?.aborted) return ABORTED;
    const bundle = deps.resolveBundle();
    if (bundle === null) return platformPackageMissing();
    const root = resolve(store);
    const staged = await stageSnapshot(snapshot, root);
    if (!staged.ok) return staged;
    if (signal?.aborted) return ABORTED;
    const run = await deps.runIndexer(process.execPath, ["--liftoff-only", CHILD_SCRIPT, bundle, root], await indexerEnvironment(deps.environment, root), signal);
    if (signal?.aborted) return ABORTED;
    const report = readReport(run);
    if (!report.ok) return report;
    await removeStaged(root, staged.value.entries);
    const opened = openGraph(root);
    if (!opened.ok) return opened;
    const { sdk, graph, versions } = opened.value;
    try {
      const filesNotIndexed = unindexedFiles(sdk, staged.value.files, graph.getFiles());
      const { filesIndexed, filesSkipped, filesErrored } = report.value;
      return { ok: true, value: { filesIndexed, filesSkipped, filesErrored, filesNotIndexed, versions } };
    } catch (error) {
      return fault("store-unreadable", errorDetail(error));
    } finally {
      graph.close();
    }
  }

  async function buildMirror(mirror: string, signal?: AbortSignal): Promise<Result<IndexSummary, CodeGraphFault>> {
    if (signal?.aborted) return ABORTED;
    const bundle = deps.resolveBundle();
    if (bundle === null) return platformPackageMissing();
    const root = resolve(mirror);
    const listed = await listMirror(root);
    if (!listed.ok) return listed;
    await rm(join(root, INDEX_STORE_DIRECTORY), { recursive: true, force: true });
    const run = await deps.runIndexer(process.execPath, ["--liftoff-only", CHILD_SCRIPT, bundle, root], await indexerEnvironment(deps.environment, root), signal);
    if (signal?.aborted) return ABORTED;
    const report = readReport(run);
    if (!report.ok) return report;
    const summarized = summarize(root, listed.value);
    if (!summarized.ok) return summarized;
    const { filesIndexed, filesSkipped, filesErrored } = report.value;
    const { filesNotIndexed, versions } = summarized.value;
    return { ok: true, value: { filesIndexed, filesSkipped, filesErrored, filesNotIndexed, versions } };
  }

  async function syncMirror(mirror: string, paths: readonly string[], signal?: AbortSignal): Promise<Result<MirrorSyncSummary, CodeGraphFault>> {
    if (paths.length === 0) return fault("index-failed", "a mirror sync needs at least one path");
    if (signal?.aborted) return ABORTED;
    const bundle = deps.resolveBundle();
    if (bundle === null) return platformPackageMissing();
    const root = resolve(mirror);
    const listed = await listMirror(root);
    if (!listed.ok) return listed;
    const args = ["--liftoff-only", SYNC_SCRIPT, bundle, root, ...paths];
    const run = await deps.runIndexer(process.execPath, args, await indexerEnvironment(deps.environment, root), signal);
    if (signal?.aborted) return ABORTED;
    const report = readSyncReport(run);
    if (!report.ok) return report;
    const summarized = summarize(root, listed.value);
    if (!summarized.ok) return summarized;
    const filesFailed = [...report.value.filesFailed].sort(compareText);
    const { filesNotIndexed, filesStored, versions } = summarized.value;
    return { ok: true, value: { filesIndexed: filesStored, filesSkipped: 0, filesErrored: filesFailed.length, filesNotIndexed, versions, filesFailed } };
  }

  function summarize(root: string, files: readonly string[]): Result<{ filesNotIndexed: readonly string[]; filesStored: number; versions: StoreVersions }, CodeGraphFault> {
    const opened = openGraph(root);
    if (!opened.ok) return opened;
    const { sdk, graph, versions } = opened.value;
    try {
      const indexed = graph.getFiles();
      return { ok: true, value: { filesNotIndexed: unindexedFiles(sdk, files, indexed), filesStored: indexed.length, versions } };
    } catch (error) {
      return fault("store-unreadable", errorDetail(error));
    } finally {
      graph.close();
    }
  }

  return { index, buildMirror, syncMirror, open };
}

async function listMirror(root: string): Promise<Result<readonly string[], CodeGraphFault>> {
  const files: string[] = [];
  try {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name).slice(root.length + 1).split(sep).join("/");
      if (isEngineEntry(path)) continue;
      if (entry.isFile()) files.push(path);
      else if (!entry.isDirectory()) return { ok: false, fault: { kind: "stage-failed", detail: `${path} is neither a regular file nor a directory` } };
    }
  } catch (error) {
    return fault("stage-failed", errorDetail(error));
  }
  return { ok: true, value: files };
}

async function indexerEnvironment(host: NodeJS.ProcessEnv, root: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_VARIABLES) {
    if (host[name] !== undefined) env[name] = host[name];
  }
  return {
    ...env,
    ...ENGINE_VARIABLES,
    NODE_DISABLE_COMPILE_CACHE: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: await realpath(dirname(root)),
  };
}

/**
 * The library reads these variables from this process whenever it resolves a store path; they are set for the
 * synchronous call alone and restored, so a host embedding the library keeps its own settings.
 */
function withEngineEnvironment<T>(call: () => T): T {
  const host = process.env;
  const previous = Object.keys(ENGINE_VARIABLES).map((name) => [name, host[name]] as const);
  Object.assign(host, ENGINE_VARIABLES);
  try {
    return call();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete host[name];
      else host[name] = value;
    }
  }
}

function unindexedFiles(sdk: Sdk, staged: readonly string[], indexed: readonly { path: string }[]): readonly string[] {
  const stored = new Set(indexed.map((file) => file.path));
  return staged.filter((path) => !stored.has(path) && sdk.isLanguageSupported(sdk.detectLanguage(path))).sort(compareText);
}

interface IndexReport {
  success: boolean;
  indexState: string | null;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  errors: readonly string[];
}

function readReport(run: IndexerRun): Result<IndexReport, CodeGraphFault> {
  if (run.code !== 0) return fault("index-failed", `the indexer ended with ${run.code ?? "a signal"}: ${run.stderr.slice(-STDERR_DETAIL_BYTES)}`);
  let report: IndexReport;
  try {
    report = JSON.parse(run.stdout) as IndexReport;
  } catch {
    return fault("index-failed", "the indexer printed no report");
  }
  if (!report.success || report.indexState !== "complete") {
    return fault("index-failed", `the index is ${report.indexState ?? "unknown"}: ${report.errors.join("; ")}`);
  }
  return { ok: true, value: report };
}

function readSyncReport(run: IndexerRun): Result<{ filesFailed: readonly string[] }, CodeGraphFault> {
  if (run.code !== 0) return fault("index-failed", `the sync ended with ${run.code ?? "a signal"}: ${run.stderr.slice(-STDERR_DETAIL_BYTES)}`);
  let report: { lockUnavailable?: boolean; filesFailed?: readonly string[] };
  try {
    report = JSON.parse(run.stdout) as typeof report;
  } catch {
    return fault("index-failed", "the sync printed no report");
  }
  if (report.lockUnavailable) return fault("index-failed", "the store is locked by another writer");
  return { ok: true, value: { filesFailed: report.filesFailed ?? [] } };
}

function createReader(graph: SdkGraph, versions: StoreVersions): CodeGraphReader {
  const symbolsByIds = (ids: readonly GraphNodeId[]): readonly GraphSymbol[] => [...graph.getNodesByIds(unique(ids)).values()].map(toSymbol).sort(compareSymbols);
  return {
    versions,
    symbolsInFiles: (files) => graph.getNodesInFiles(unique(files)).map(toSymbol).sort(compareSymbols),
    symbolsByIds,
    declarationsNamed: (names) => unique(names).flatMap((name) => graph.getNodesByName(name)).map(toSymbol).sort(compareSymbols),
    incomingEdges: (targets, kinds) => {
      if (kinds?.length === 0) return [];
      return graph.getIncomingEdgesTo(unique(targets), kinds as Edge["kind"][] | undefined).map(toEdge).sort(compareEdges);
    },
    outgoingEdges: (sources, kinds) => {
      if (kinds?.length === 0) return [];
      return graph.getOutgoingEdgesFrom(unique(sources), kinds as Edge["kind"][] | undefined).map(toEdge).sort(compareOutgoingEdges);
    },
    unresolvedReferences: (files): readonly GraphUnresolvedReference[] =>
      unique(files)
        .flatMap((file) => graph.getUnresolvedReferencesInFile(file, NO_LIMIT))
        .map((reference) => ({
          from: reference.fromNodeId as GraphNodeId,
          name: reference.referenceName,
          kind: reference.referenceKind,
          file: reference.filePath ?? "",
          line: reference.line,
          column: reference.column,
          candidates: reference.candidates ?? [],
        }))
        .sort(compareReferences),
    close: () => graph.close(),
  };
}

function toSymbol(node: Node): GraphSymbol {
  return {
    id: node.id as GraphNodeId,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    file: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
  };
}

function toEdge(edge: Edge): GraphEdge {
  const { confidence, synthesizedBy } = edge.metadata ?? {};
  return {
    source: edge.source as GraphNodeId,
    target: edge.target as GraphNodeId,
    kind: edge.kind,
    line: edge.line ?? null,
    column: edge.column ?? null,
    confidence: typeof confidence === "number" ? confidence : null,
    provenance: edge.provenance ?? null,
    synthesizedBy: typeof synthesizedBy === "string" ? synthesizedBy : null,
  };
}

function compareSymbols(a: GraphSymbol, b: GraphSymbol): number {
  return compareText(a.file, b.file) || a.startLine - b.startLine || a.endLine - b.endLine || compareText(a.qualifiedName, b.qualifiedName) || compareText(a.id, b.id);
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    compareText(a.target, b.target) ||
    compareText(a.kind, b.kind) ||
    (a.line ?? -1) - (b.line ?? -1) ||
    (a.column ?? -1) - (b.column ?? -1) ||
    compareText(a.source, b.source)
  );
}

function compareOutgoingEdges(a: GraphEdge, b: GraphEdge): number {
  return compareText(a.source, b.source) || compareText(a.kind, b.kind) || (a.line ?? -1) - (b.line ?? -1) || (a.column ?? -1) - (b.column ?? -1) || compareText(a.target, b.target);
}

function compareReferences(a: GraphUnresolvedReference, b: GraphUnresolvedReference): number {
  return compareText(a.file, b.file) || a.line - b.line || a.column - b.column || compareText(a.name, b.name) || compareText(a.kind, b.kind) || compareText(a.from, b.from);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function platformPackageMissing(): Result<never, CodeGraphFault> {
  return fault("platform-package-missing", `@colbymchenry/codegraph-${process.platform}-${process.arch} is not installed in node_modules`);
}

function fault(kind: CodeGraphFault["kind"], detail: string): Result<never, CodeGraphFault> {
  return { ok: false, fault: { kind, detail } };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
