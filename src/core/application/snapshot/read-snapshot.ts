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

export const LIVE_REQUIRES_TRUSTED: Result<never, LiveFault> = {
  ok: false,
  fault: { kind: "live-requires-trusted", detail: "a live query reads the working tree and needs a trusted repository: run `ye-ast install --trust trusted`" },
};

export interface CommitExtraction {
  export: CommitExport;
  /** The exported files in map scope, as read. */
  sources: readonly SourceFile[];
  findings: readonly Finding<Entrypoint>[];
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

/**
 * Exports the selected files in map scope of the commit `sha` into `destination`, an empty directory, and extracts the
 * entrypoints from them. A path `selected` rejects is dropped from the export, so nothing downstream lists, hashes or
 * cuts it.
 */
export async function extractCommit(
  deps: Pick<SnapshotReaderDeps, "vcs" | "reader" | "extractor" | "budget">,
  repo: string,
  sha: string,
  destination: string,
  selected: PathSelection,
  signal?: AbortSignal,
): Promise<Result<CommitExtraction, VcsFault>> {
  const { vcs } = deps;
  const listed = await vcs.exportCommit(repo, sha, destination, { write: (path) => selected(path) && isInMapScope(path), ...(deps.budget && { budget: deps.budget }) }, signal);
  if (!listed.ok) return listed;
  const exported: CommitExport = { ...listed.value, files: listed.value.files.filter((file) => selected(file.path)), skipped: listed.value.skipped.filter((entry) => selected(entry.path)) };
  if (signal?.aborted) return ABORTED;
  return extractExport(deps, destination, exported, signal);
}

/** Reads the files `exported` marks written from `root` and extracts the entrypoints from them; `extractCommit` and a live query share it. */
export async function extractExport(
  deps: Pick<SnapshotReaderDeps, "reader" | "extractor">,
  root: string,
  exported: CommitExport,
  signal?: AbortSignal,
): Promise<Result<CommitExtraction, VcsFault>> {
  const sources = await deps.reader.read(
    root,
    exported.files.filter((file) => file.written).map((file) => file.path),
  );
  if (signal?.aborted) return ABORTED;
  const findings = await deps.extractor.extract(sources);
  if (signal?.aborted) return ABORTED;
  return { ok: true, value: { export: exported, sources, findings } };
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
      engines: sortedEngines(request.engines),
    },
    evidence: [],
  };
}
