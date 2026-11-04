import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { isInMapScope } from "../../domain/map/entrypoint-map.ts";
import { sortedEngines, SCHEMA, type DeclaredConfig, type DeclaredScope, type FactBase, type Finding, type IndexOrigin, type Producer, type TrustMode } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { PathSelection } from "../../domain/shared/scope.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { EntrypointExtractor, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { LiveFault } from "../../ports/live-queries.port.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { SourceReader } from "../../ports/source-reader.port.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import type { CommitExport, ExportBudget, Vcs, VcsFault } from "../../ports/vcs.port.ts";

export const ABORTED: Result<never, VcsFault> = { ok: false, fault: { kind: "aborted", detail: "interrupted by the caller" } };

/** What reading a revision into an extracted snapshot needs; every query family starts here. */
export interface SnapshotReaderDeps {
  vcs: Vcs;
  preparation?: SnapshotPreparation;
  snapshotCache?: SnapshotDataCache;
  scratch: ScratchDirectory;
  reader: SourceReader;
  extractor: EntrypointExtractor;
  digest: Digest;
  producer: Producer;
  /** What the export may take from a commit, when the host bounds it; the repository cannot raise it. */
  budget?: ExportBudget;
  /** The user's declarations; without one every repository is read `untrusted`. */
  trust?: TrustRecordReader;
}

/** The mode the user declared for `repo`, `untrusted` when there is none or the record is unusable (ADR-0010 decision 6). */
export async function trustOf(deps: Pick<SnapshotReaderDeps, "trust">, repo: string): Promise<TrustMode> {
  const declared = await deps.trust?.read(repo);
  return (declared?.ok && declared.value) || "untrusted";
}

/** The trust the host declared for a repository: absent when it declared none, or when the record cannot be read. */
export async function declaredTrustOf(deps: Pick<SnapshotReaderDeps, "trust">, repo: string): Promise<TrustMode | undefined> {
  const declared = await deps.trust?.read(repo);
  return declared?.ok ? declared.value : undefined;
}

export const LIVE_REQUIRES_TRUSTED: Result<never, LiveFault> = {
  ok: false,
  fault: { kind: "live-requires-trusted", detail: "a live query reads the working tree and needs a trusted repository: run `ye-ast init --trust trusted`" },
};

export interface CommitExtraction {
  export: CommitExport;
  /** The exported files in map scope, as read. */
  sources: readonly SourceFile[];
  findings: readonly Finding<Entrypoint>[];
}

export interface SnapshotData {
  sources: readonly SourceFile[];
  findings?: readonly Finding<Entrypoint>[];
}

/** Serialized immutable data only: no scratch paths, compiler trees, readers or in-flight work. */
export interface SnapshotDataCache {
  get(key: string): SnapshotData | undefined;
  put(key: string, data: SnapshotData): void;
}

export interface PreparedCommit {
  root: string;
  tree: Pick<CommitExtraction, "export">;
  sources(signal?: AbortSignal): Promise<Result<Pick<CommitExtraction, "export" | "sources">, VcsFault>>;
  extract(signal?: AbortSignal): Promise<Result<CommitExtraction, VcsFault>>;
}

export interface SnapshotPreparation {
  obtain(key: string, deps: SnapshotReaderDeps, build: (root: string) => Promise<Result<PreparedCommit, VcsFault>>): Promise<Result<PreparedCommit, VcsFault>>;
}

/** Runs `use` with a way to make temporary directories, and removes every one of them afterwards, newest first. */
export async function withScratch<T>(scratch: ScratchDirectory, use: (directory: () => Promise<string>) => Promise<T>): Promise<T> {
  const directories: string[] = [];
  try {
    return await use(async () => {
      const created = await scratch.create();
      directories.push(created);
      return created;
    });
  } finally {
    for (const created of directories.toReversed()) await scratch.remove(created);
  }
}

/** Exports selected map-scope files, preserving the listing and cuts used by every snapshot consumer. */
export async function exportCommit(
  deps: Pick<SnapshotReaderDeps, "vcs" | "budget">,
  repo: string,
  sha: string,
  destination: string,
  selected: PathSelection,
  signal?: AbortSignal,
): Promise<Result<CommitExport, VcsFault>> {
  const listed = await deps.vcs.exportCommit(repo, sha, destination, { write: (path) => selected(path) && isInMapScope(path), ...(deps.budget && { budget: deps.budget }) }, signal);
  if (!listed.ok) return listed;
  if (signal?.aborted) return ABORTED;
  return { ok: true, value: { ...listed.value, files: listed.value.files.filter((file) => selected(file.path)), skipped: listed.value.skipped.filter((entry) => selected(entry.path)) } };
}

export async function extractCommit(
  deps: Pick<SnapshotReaderDeps, "vcs" | "reader" | "extractor" | "budget">,
  repo: string,
  sha: string,
  destination: string,
  selected: PathSelection,
  signal?: AbortSignal,
): Promise<Result<CommitExtraction, VcsFault>> {
  const exported = await exportCommit(deps, repo, sha, destination, selected, signal);
  return exported.ok ? extractExport(deps, destination, exported.value, signal) : exported;
}

/** Reads the files `exported` marks written from `root` and extracts the entrypoints from them; `extractCommit` and a live query share it. */
export async function extractExport(
  deps: Pick<SnapshotReaderDeps, "reader" | "extractor">,
  root: string,
  exported: CommitExport,
  signal?: AbortSignal,
): Promise<Result<CommitExtraction, VcsFault>> {
  const read = await readSources(deps, root, exported, signal);
  return read.ok ? extractSources(deps, read.value, signal) : read;
}

export async function readSources(
  deps: Pick<SnapshotReaderDeps, "reader">,
  root: string,
  exported: CommitExport,
  signal?: AbortSignal,
): Promise<Result<Pick<CommitExtraction, "export" | "sources">, VcsFault>> {
  if (signal?.aborted) return ABORTED;
  const sources = await deps.reader.read(root, exported.files.filter((file) => file.written).map((file) => file.path));
  return signal?.aborted ? ABORTED : { ok: true, value: { export: exported, sources } };
}

export async function extractSources(
  deps: Pick<SnapshotReaderDeps, "extractor">,
  tree: Pick<CommitExtraction, "export" | "sources">,
  signal?: AbortSignal,
): Promise<Result<CommitExtraction, VcsFault>> {
  if (signal?.aborted) return ABORTED;
  const findings = await deps.extractor.extract(tree.sources);
  return signal?.aborted ? ABORTED : { ok: true, value: { ...tree, findings } };
}

/** What one fact states about the revision it read; the rest is derived. */
export interface FactBaseRequest {
  repoId: string;
  sha: string;
  trust: TrustMode;
  scope: DeclaredScope;
  /** The fingerprint of the exported tree or trees, before the digest. */
  content: string;
  declaredConfig: DeclaredConfig;
  engines: Readonly<Record<string, string>>;
  /** Where the index the fact read came from; absent when it read none. */
  origin?: IndexOrigin;
  /** The type root a resolution read; absent when none answered. */
  typeRoot?: { identity: string };
}

/** The one builder of a fact's inputs, which RFC-0002 rule 5 makes the only invalidation key. */
export function factBaseOf(deps: Pick<SnapshotReaderDeps, "digest" | "producer">, request: FactBaseRequest): FactBase {
  const { digest, producer } = deps;
  return {
    schema: SCHEMA,
    snapshot: { repo: request.repoId, kind: "sha", sha: request.sha },
    producer,
    inputs: {
      trust: request.trust,
      scope: digest.of(JSON.stringify(request.scope)),
      declaredScope: request.scope,
      content: digest.of(request.content),
      config: digest.of(canonicalJson(request.declaredConfig)),
      declaredConfig: request.declaredConfig,
      ...(request.origin === undefined ? {} : { origin: request.origin }),
      ...(request.typeRoot === undefined ? {} : { typeRoot: request.typeRoot }),
      engines: sortedEngines(request.engines),
    },
    evidence: [],
  };
}
