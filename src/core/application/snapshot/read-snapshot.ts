import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { isInMapScope } from "../../domain/map/entrypoint-map.ts";
import { sortedEngines, SCHEMA, type DeclaredConfig, type DeclaredScope, type FactBase, type Finding, type IndexOrigin, type Producer, type TrustMode } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { PathSelection } from "../../domain/shared/scope.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { EntrypointExtractor, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { LiveFault } from "../../ports/live-queries.port.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { ParseHold, ParseHolds } from "../../ports/parse-holds.port.ts";
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
  sourceSelection?: PathSelection;
  /** What the export may take from a commit, when the host bounds it; the repository cannot raise it. */
  budget?: ExportBudget;
  /** The user's declarations; without one every repository is read `untrusted`. */
  trust?: TrustRecordReader;
  /** Where each snapshot read keeps the trees parsed from its sources until it ends; without it every parse is the reader's own. */
  holds?: ParseHolds;
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
  /** The serialized output of one reader over the sources of another entry; such an entry holds no sources itself. */
  output?: unknown;
}

/** What the cache decided for one derived fact: whether it holds it, its charge, and how many entries it evicted. */
export interface FactAdmission {
  admitted: boolean;
  entryBytes: number;
  evicted: number;
}

/** Serialized immutable data only: no scratch paths, compiler trees, readers or in-flight work. */
export interface SnapshotDataCache {
  get(key: string): SnapshotData | undefined;
  put(key: string, data: SnapshotData): void;
  /** A derived fact (ADR-0035), parsed afresh; facts share the budget and the eviction order and write no `cache` line. */
  getFact(key: string): unknown;
  putFact(key: string, json: string): FactAdmission;
  /** The bytes the cache holds now, and how many of them are derived facts. */
  usage(): { factBytes: number; retainedBytes: number };
}

export interface PreparedCommit {
  /** Holds the exported files once `materialize` answered `ok`; before that it may be empty. */
  root: string;
  /**
   * Writes the exported files under `root`, once: later calls answer the first one's result. Every reader of `root`
   * (the index builder, the source reader) calls it first; a snapshot served from retained data never does.
   */
  materialize(signal?: AbortSignal): Promise<Result<void, VcsFault>>;
  tree: Pick<CommitExtraction, "export">;
  sources(signal?: AbortSignal): Promise<Result<Pick<CommitExtraction, "export" | "sources">, VcsFault>>;
  extract(signal?: AbortSignal): Promise<Result<CommitExtraction, VcsFault>>;
  /**
   * What `produce` answers over this snapshot's sources, kept between requests under `slot`, which names every input
   * besides the sources the output depends on. Absent where nothing is retained.
   */
  retained?<T>(slot: string, produce: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** The derived facts of this snapshot's files, kept between requests by content (ADR-0035). Absent where nothing is retained. */
  facts?: DerivedFacts;
}

export interface SnapshotPreparation {
  obtain(key: string, deps: SnapshotReaderDeps, build: (root: string, keep: ReadScope["keep"]) => Promise<Result<PreparedCommit, VcsFault>>): Promise<Result<PreparedCommit, VcsFault>>;
}

/** What one snapshot read holds until it ends: the temporary directories it makes and the trees parsed from the sources it keeps. */
export interface ReadScope {
  directory(): Promise<string>;
  /** The sources as the read's own, each parsed at most once until the read ends (ADR-0040). */
  keep(sources: readonly SourceFile[]): SourceFile[];
  /** The read's open parse hold, which owns every tree the read kept until `release`; absent where nothing is held. */
  hold?: ParseHold;
}

/** Runs `use` in a read scope, then frees the trees it held and removes every directory it made, newest first, whether `use` answers or throws. */
export async function withScratch<T>(deps: Pick<SnapshotReaderDeps, "scratch" | "holds">, use: (scope: ReadScope) => Promise<T>): Promise<T> {
  const directories: string[] = [];
  const hold = deps.holds?.open();
  try {
    return await use({
      async directory() {
        const created = await deps.scratch.create();
        directories.push(created);
        return created;
      },
      keep: (sources) => hold?.keep(sources) ?? [...sources],
      ...(hold === undefined ? {} : { hold }),
    });
  } finally {
    hold?.release();
    for (const created of directories.toReversed()) await deps.scratch.remove(created);
  }
}

/** A listed export and the means to write the files it marked written; a Vcs that lists and writes apart writes only on demand. */
export interface ExportListing {
  export: CommitExport;
  /** Writes the files under the destination the listing was made for; a Vcs that wrote them while listing answers `ok`. */
  materialize(signal?: AbortSignal): Promise<Result<void, VcsFault>>;
}

/** Lists the selected map-scope files, preserving the listing and cuts used by every snapshot consumer; writes them only when the Vcs lists apart. */
export async function listExport(
  deps: Pick<SnapshotReaderDeps, "vcs" | "budget" | "sourceSelection">,
  repo: string,
  sha: string,
  destination: string,
  selected: PathSelection,
  signal?: AbortSignal,
): Promise<Result<ExportListing, VcsFault>> {
  const { vcs } = deps;
  const plan = { write: (path: string) => selected(path) && (deps.sourceSelection ?? isInMapScope)(path), ...(deps.budget && { budget: deps.budget }) };
  const apart = vcs.listCommit && vcs.materializeCommit ? { list: vcs.listCommit.bind(vcs), write: vcs.materializeCommit.bind(vcs) } : undefined;
  const listed = apart ? await apart.list(repo, sha, plan, signal) : await vcs.exportCommit(repo, sha, destination, plan, signal);
  if (!listed.ok) return listed;
  if (signal?.aborted) return ABORTED;
  const exported: CommitExport = { ...listed.value, files: listed.value.files.filter((file) => selected(file.path)), skipped: listed.value.skipped.filter((entry) => selected(entry.path)) };
  return { ok: true, value: { export: exported, materialize: apart ? (later) => apart.write(repo, exported.files, destination, later) : async () => ({ ok: true, value: undefined }) } };
}

/** Exports selected map-scope files into `destination`, preserving the listing and cuts used by every snapshot consumer. */
export async function exportCommit(
  deps: Pick<SnapshotReaderDeps, "vcs" | "budget" | "sourceSelection">,
  repo: string,
  sha: string,
  destination: string,
  selected: PathSelection,
  signal?: AbortSignal,
): Promise<Result<CommitExport, VcsFault>> {
  const listed = await listExport(deps, repo, sha, destination, selected, signal);
  if (!listed.ok) return listed;
  const written = await listed.value.materialize(signal);
  if (!written.ok) return written;
  return signal?.aborted ? ABORTED : { ok: true, value: listed.value.export };
}

export async function extractCommit(
  deps: Pick<SnapshotReaderDeps, "vcs" | "reader" | "extractor" | "budget" | "sourceSelection">,
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
