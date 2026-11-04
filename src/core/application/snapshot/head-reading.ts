import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { contentFingerprint, declaredScope } from "../../domain/map/entrypoint-map.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import type { DeclaredConfig, DeclaredScope, Fact, FactBase, IndexOrigin, SnapshotRef, TrustMode, UnknownFact } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { exportSelection, pathSelection, type PathSelection, type ScopeRequest } from "../../domain/shared/scope.ts";
import type { CodeGraph, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { IndexCache } from "../../ports/index-cache.port.ts";
import type { LiveFault, LiveSelector } from "../../ports/live-queries.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { CommitExport, Vcs, VcsFault } from "../../ports/vcs.port.ts";
import { openLive, type LiveDeps, type LiveTree } from "../live/live-tree.ts";
import { ABORTED, extractExport, readSources, factBaseOf, LIVE_REQUIRES_TRUSTED, trustOf, withScratch, type CommitExtraction, type PreparedCommit, type SnapshotReaderDeps } from "./read-snapshot.ts";
import { prepareCommit } from "./prepared-snapshot.ts";

/** What reading the head of a query needs: the snapshot reader plus the index of what it exported. */
export interface HeadReaderDeps extends SnapshotReaderDeps {
  graph: CodeGraph;
  /** Keeps full indexes by content; without it every call builds its own and discards it. */
  indexes?: IndexCache;
  matcher: PathMatcher;
  /** What a live query reads; without it a live query is refused as under `untrusted`. */
  live?: LiveDeps;
  /** The type root a fact records as an input when it settles references with a compiler, so the fact invalidates with it. */
  typeRoot?: { identity: string };
}

/** What one operation adds to the fact base of every fact it answers. */
export interface FactSpec {
  declaredConfig: DeclaredConfig;
  engines: Readonly<Record<string, string>>;
}

export interface HeadIndex {
  store: CodeGraphReader;
  summary: Pick<IndexSummary, "filesNotIndexed">;
}

/** The head of a query as the operation reads it: a commit's export or the mirror, with the means to index it. */
export interface HeadReading<Tree extends Pick<CommitExtraction, "export"> = CommitExtraction> {
  tree: Tree;
  prepared?: PreparedCommit;
  selected: PathSelection;
  /** The fact base for `content`; `store` is true for a fact that read the index, which records where it came from. */
  base(content: string, store?: boolean): FactBase;
  /** The head's index; the caller closes its store. */
  open(): Promise<HeadIndex | "aborted" | "unavailable">;
}

/** A revisioned request: the repository, what it selects, and the revision or the live tree it reads. */
export type Revisioned = { repo: string; source?: string; repoId: string; scope?: ScopeRequest; signal?: AbortSignal } & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

/** A live query reads the working tree against the commit HEAD names. */
const LIVE_HEAD = "HEAD";

/**
 * The files of the index's universe the store did not hold, limited to what the head export staged: the engine reads
 * the whole mirror and a commit's whole listing, so a path the export never wrote could not be read by this answer.
 */
export function notHeldInExport(notHeld: readonly string[], exported: CommitExport): Pick<IndexSummary, "filesNotIndexed"> {
  const staged = new Set(exported.files.filter((file) => file.written).map((file) => file.path));
  return { filesNotIndexed: notHeld.filter((path) => staged.has(path)) };
}

export interface HeadReader {
  /** Reads a head export and its index without loading sources or extracting entrypoints. */
  atExport<V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export">>) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault>>;
  atSources<V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export" | "sources">>) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault>>;
  /** The one place a revisioned operation reads its head, at a commit or on the live tree, so its body is written once. */
  atHead<V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault>>;
  /** The fact base of a snapshot: a commit's carries the host's export budget, the live tree reads none. */
  factBase(trust: TrustMode, snapshot: SnapshotRef, content: string, spec: FactSpec, scope: DeclaredScope, origin: IndexOrigin | undefined): FactBase;
  /** The head's index; the caller closes its store. */
  indexHead(headTree: Pick<CommitExtraction, "export">, headDirectory: string, directory: () => Promise<string>, signal: AbortSignal | undefined): Promise<HeadIndex | "aborted" | "unavailable">;
  /** The head of a live query: the mirror under the lock, its store opened where the engine left it. */
  liveReading<Tree extends Pick<CommitExtraction, "export">>(tree: LiveTree, extraction: Tree, trust: TrustMode, scope: DeclaredScope, selected: PathSelection, head: string, repoId: string, spec: FactSpec): HeadReading<Tree>;
  /** What a live query answers when the refresh did not finish: `unknown`, with a state id of nothing read. */
  unavailableLive(trust: TrustMode, scope: DeclaredScope, head: string, repoId: string, spec: FactSpec): UnknownFact;
}

export function createHeadReader(deps: HeadReaderDeps): HeadReader {
  const { vcs } = deps;
  const exportBudget: Pick<DeclaredConfig, "exportBudget"> = deps.budget === undefined ? {} : { exportBudget: { maxEntries: deps.budget.maxEntries, maxBytes: deps.budget.maxBytes } };

  const factBase = (trust: TrustMode, snapshot: SnapshotRef, content: string, spec: FactSpec, scope: DeclaredScope, origin: IndexOrigin | undefined): FactBase => {
    const sha = snapshot.kind === "sha" ? snapshot.sha : snapshot.kind === "live" ? snapshot.head : "";
    const declaredConfig: DeclaredConfig = { ...(snapshot.kind === "sha" ? exportBudget : {}), ...spec.declaredConfig };
    const typeRoot = deps.typeRoot === undefined ? {} : { typeRoot: { identity: deps.typeRoot.identity } };
    return { ...factBaseOf(deps, { repoId: snapshot.repo, sha, trust, scope, content, declaredConfig, engines: spec.engines, ...(origin === undefined ? {} : { origin }), ...typeRoot }), snapshot };
  };

  const indexHead = async (headTree: Pick<CommitExtraction, "export">, headDirectory: string, directory: () => Promise<string>, signal: AbortSignal | undefined): Promise<HeadIndex | "aborted" | "unavailable"> => {
    if (deps.indexes !== undefined) {
      const kept = await deps.indexes.obtain({ content: deps.digest.of(contentFingerprint(headTree.export, deps.sourceSelection)), snapshot: headDirectory, signal });
      if (kept.ok) return { store: kept.value.store, summary: notHeldInExport(kept.value.summary.filesNotIndexed, headTree.export) };
      if (kept.fault.kind === "aborted") return "aborted";
      if (kept.fault.kind !== "cache-unavailable") return "unavailable";
    }
    const storeDirectory = await directory();
    const indexed = await deps.graph.index(headDirectory, storeDirectory, signal);
    if (!indexed.ok) return indexed.fault.kind === "aborted" ? "aborted" : "unavailable";
    const opened = deps.graph.open(storeDirectory);
    return opened.ok ? { store: opened.value, summary: notHeldInExport(indexed.value.filesNotIndexed, headTree.export) } : "unavailable";
  };

  const liveReading = <Tree extends Pick<CommitExtraction, "export">>(tree: LiveTree, extraction: Tree, trust: TrustMode, scope: DeclaredScope, selected: PathSelection, head: string, repoId: string, spec: FactSpec): HeadReading<Tree> => {
    const snapshot: SnapshotRef = { repo: repoId, kind: "live", head, stateId: tree.stateId };
    return {
      tree: extraction,
      selected,
      base: (content, store = false) => factBase(trust, snapshot, content, spec, scope, store ? tree.origin : undefined),
      open: async () => {
        const opened = deps.graph.open(tree.root);
        return opened.ok ? { store: opened.value, summary: notHeldInExport(tree.notHeld, extraction.export) } : "unavailable";
      },
    };
  };

  const unavailableLive = (trust: TrustMode, scope: DeclaredScope, head: string, repoId: string, spec: FactSpec): UnknownFact => {
    const unread = deps.digest.of(JSON.stringify([head]));
    return { ...factBase(trust, { repo: repoId, kind: "live", head, stateId: unread }, unread, spec, scope, undefined), status: "unknown", reason: "index-unavailable" };
  };

  const atSnapshot = async <V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export">>, root: string) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault>> => {
    const { repo, repoId, signal } = request;
    if (request.live === true) {
      const trust = await trustOf(deps, repo);
      if (trust !== "trusted" || deps.live === undefined) return LIVE_REQUIRES_TRUSTED;
      const head = await vcs.resolveCommit(repo, LIVE_HEAD, signal);
      if (!head.ok) return head;
      const scope = liveScope(request.scope);
      const selected = pathSelection(scope, deps.matcher.matches);
      const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
      const opened = await openLive(deps.live, { repo, scope, selected: exported, store: true, signal, onStale: request.onStale }, async (tree) => {
        if (signal?.aborted) return ABORTED;
        return read(liveReading(tree, { export: tree.export }, trust, scope, selected, head.value, repoId, spec), tree.root);
      });
      if (opened.ok) return opened.value;
      const { fault } = opened;
      return fault.kind === "unavailable" ? { ok: true, value: unavailableLive(trust, scope, head.value, repoId, spec) } : { ok: false, fault };
    }

    const scope = declaredScope(request.scope);
    const selected = pathSelection(scope, deps.matcher.matches);
    const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
    const source = request.source ?? repo;
    const head = await vcs.resolveCommit(source, request.revision, signal);
    if (!head.ok) return head;
    const trust = await trustOf(deps, repo);
    const snapshot: SnapshotRef = { repo: repoId, kind: "sha", sha: head.value };
    return withScratch(deps.scratch, async (directory) => {
      const prepared = await prepareCommit(deps, source, head.value, directory, exported, { scope, trust }, signal);
      if (!prepared.ok) return prepared;
      const { root: headDirectory, tree: headTree } = prepared.value;
      return read({
        tree: headTree,
        prepared: prepared.value,
        selected,
        base: (content, store = false) => factBase(trust, snapshot, content, spec, scope, store ? { kind: "full" } : undefined),
        open: () => indexHead(headTree, headDirectory, directory, signal),
      }, headDirectory);
    });
  };

  const atHead = <V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault>> => atSnapshot<V, E | VcsFault>(request, spec, async (head, root) => {
    const extracted = head.prepared === undefined ? await extractExport(deps, root, head.tree.export, request.signal) : await head.prepared.extract(request.signal);
    return extracted.ok ? read({ ...head, tree: extracted.value }) : extracted;
  });

  const atSources = <V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export" | "sources">>) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault>> => atSnapshot<V, E | VcsFault>(request, spec, async (head, root) => {
    const loaded = head.prepared === undefined ? await readSources(deps, root, head.tree.export, request.signal) : await head.prepared.sources(request.signal);
    return loaded.ok ? read({ ...head, tree: loaded.value }) : loaded;
  });

  return { atHead, atSources, atExport: atSnapshot, factBase, indexHead, liveReading, unavailableLive };
}
