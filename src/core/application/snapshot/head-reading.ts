import { heldPaths } from "../navigation/snapshot-files.ts";
import { scopeNotice } from "./scope-selection.ts";
import type { ScopeFault } from "../../ports/scope-fault.port.ts";
import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { contentFingerprint, declaredScope } from "../../domain/map/entrypoint-map.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import type { DeclaredConfig, DeclaredScope, Fact, FactBase, IndexOrigin, SnapshotRef, TrustMode, UnknownFact } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { WORKSPACE_SCOPE, exportSelection, pathSelection, type PathSelection, type ScopeRequest } from "../../domain/shared/scope.ts";
import type { CodeGraph, CodeGraphFault, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { IndexCache } from "../../ports/index-cache.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { LiveFault, LiveSelector } from "../../ports/live-queries.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { CommitExport, Vcs, VcsFault } from "../../ports/vcs.port.ts";
import { openLive, type LiveDeps, type LiveTree, type LiveFailure, type OpenLive } from "../live/live-tree.ts";
import { ABORTED, extractExport, readSources, factBaseOf, LIVE_REQUIRES_TRUSTED, trustOf, withScratch, type CommitExtraction, type PreparedCommit, type ReadScope, type SnapshotReaderDeps } from "./read-snapshot.ts";
import { prepareCommit } from "./prepared-snapshot.ts";
import { pinLiveSnapshot } from "./live-snapshot.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";

/** What reading the head of a query needs: the snapshot reader plus the index of what it exported. */
export interface HeadReaderDeps extends SnapshotReaderDeps {
  graph: CodeGraph;
  /** Keeps full indexes by content; without it every call builds its own and discards it. */
  indexes?: IndexCache;
  matcher: PathMatcher;
  /** What a live query reads; without it a live query is refused as under `untrusted`. */
  live?: LiveDeps;
  heldLive?: ((request: { repo: string; repoId: string }) => HeldLive | undefined) | undefined;
}

/** A capture belongs to the callback holding its live lease. */
export interface HeldLive {
  readonly kind: "live";
  readonly trust: "trusted";
  readonly repo: string;
  readonly repoId: string;
  readonly scope: DeclaredScope;
  readonly head: string;
  readonly tree: LiveTree;
  readonly deps: Pick<HeadReaderDeps, "vcs" | "reader" | "extractor" | "graph" | "matcher" | "live">;
  /** The capture's open parse hold, which owns the trees of the sources it kept. */
  readonly hold?: ParseHold;
  sources(signal?: AbortSignal): Promise<Result<Pick<CommitExtraction, "export" | "sources">, VcsFault>>;
  extract(signal?: AbortSignal): Promise<Result<CommitExtraction, VcsFault>>;
  retained?: PreparedCommit["retained"];
  facts?: PreparedCommit["facts"];
}

/**
 * Pins one live capture under its mirror lock: reads its sources (ADR-0144), so nothing its consumers run afterwards reads
 * the mirror. Consumers of a capture share one operation signal; independent operations create their own capture.
 */
export async function pinHeldLive(input: { repo: string; repoId: string; scope: DeclaredScope; head: string; tree: LiveTree; trust: "trusted"; deps: HeadReaderDeps; hold?: ParseHold }, signal?: AbortSignal): Promise<Result<HeldLive, VcsFault>> {
  const { hold, ...held } = input;
  const { vcs, reader, extractor, graph, matcher, live } = held.deps;
  const captureDeps = { vcs, reader, extractor, graph, matcher, ...(live === undefined ? {} : { live }) };
  const readers = await pinLiveSnapshot(held.deps, { repo: held.repo, scope: held.scope, trust: held.trust, root: held.tree.root, export: held.tree.export }, hold, signal);
  if (!readers.ok) return readers;
  return { ok: true, value: { ...held, ...(hold === undefined ? {} : { hold }), deps: captureDeps, kind: "live", ...readers.value } };
}

/** The held capture as the readers of a snapshot take it: nothing to write, since the mirror already holds the files. */
export function preparedLive(held: Pick<HeldLive, "tree" | "sources" | "extract" | "retained" | "facts" | "hold">): PreparedCommit {
  const { tree, sources, extract, retained, facts, hold } = held;
  return { root: tree.root, materialize: async () => ({ ok: true, value: undefined }), tree: { export: tree.export }, sources, extract, hold, ...(retained === undefined ? {} : { retained }), ...(facts === undefined ? {} : { facts }) };
}

export interface LiveCaptureSelection {
  repo: string;
  repoId: string;
  /**
   * The HEAD the caller planned with: the capture is refused when HEAD names another commit once the mirror is up to
   * date. Absent, the capture takes the HEAD it reads then, so a query that needs HEAD only for its answer reads it once.
   */
  head?: string | undefined;
  scope: DeclaredScope;
  trust: "trusted";
  synthesized?: OpenLive["synthesized"];
  declined?: OpenLive["declined"];
  onStale?: OpenLive["onStale"];
  onStalenessUnavailable?: OpenLive["onStalenessUnavailable"];
}

/**
 * Pins every selected tree, one mirror lock at a time in root order, and runs the callback on the pinned captures with no
 * lock held (ADR-0144). Roots must already be canonical where required.
 */
export async function withLiveCaptures<T>(deps: HeadReaderDeps, selections: readonly LiveCaptureSelection[], signal: AbortSignal | undefined, use: (captures: ReadonlyMap<string, HeldLive>) => Promise<T>): Promise<Result<T, { repoId: string; cause: LiveFailure }>> {
  if (new Set(selections.map((s) => s.repo)).size !== selections.length || new Set(selections.map((s) => s.repoId)).size !== selections.length) throw new TypeError("duplicate live capture selection");
  if (selections.length === 0) {
    if (signal?.aborted) return { ok: false, fault: { repoId: "", cause: { kind: "aborted", detail: "live query aborted" } } };
    const value = await use(new Map());
    return signal?.aborted ? { ok: false, fault: { repoId: "", cause: { kind: "aborted", detail: "live query aborted" } } } : { ok: true, value };
  }
  if (deps.live === undefined) throw new TypeError("live dependencies required");
  const live = deps.live;
  const hold = deps.holds?.open();
  try {
    const ordered = [...selections].sort((a, b) => compareText(a.repo, b.repo));
    const captures = new Map<string, HeldLive>();
    let cancellation: { repoId: string; cause: LiveFailure } | undefined;
    const postludes: { repoId: string; run: () => void | Promise<void> }[] = [];
    const acquire = async (index: number): Promise<Result<T, { repoId: string; cause: LiveFailure }>> => {
      if (signal?.aborted) return { ok: false, fault: { repoId: ordered[index]?.repoId ?? "", cause: { kind: "aborted", detail: "live query aborted" } } };
      if (index === ordered.length) return { ok: true, value: await use(captures) };
      const selection = ordered[index]!;
      const selected = exportSelection(selection.scope, deps.matcher.matches, isExtractorConfiguration);
      const opened = await openLive(live, { repo: selection.repo, scope: selection.scope, selected, store: true, synthesized: selection.synthesized, declined: selection.declined, signal,
        ...(selection.onStale === undefined ? {} : { onStale: (notice) => { postludes.push({ repoId: selection.repoId, run: () => selection.onStale!(notice) }); } }),
        ...(selection.onStalenessUnavailable === undefined ? {} : { onStalenessUnavailable: (notice) => { postludes.push({ repoId: selection.repoId, run: () => selection.onStalenessUnavailable!(notice) }); } }),
      }, async (_tree, pinned: Result<HeldLive, LiveFailure>): Promise<Result<T, { repoId: string; cause: LiveFailure }>> => {
        if (signal?.aborted) return { ok: false, fault: { repoId: selection.repoId, cause: { kind: "aborted", detail: "live query aborted" } } };
        if (!pinned.ok) return { ok: false, fault: { repoId: selection.repoId, cause: pinned.fault } };
        captures.set(selection.repoId, pinned.value);
        return acquire(index + 1);
      }, async (tree): Promise<Result<HeldLive, LiveFailure>> => {
        const head = await deps.vcs.resolveCommit(selection.repo, LIVE_HEAD, signal);
        if (signal?.aborted) return { ok: false, fault: { kind: "aborted", detail: "live query aborted" } };
        if (!head.ok) return head;
        if (selection.head !== undefined && head.value !== selection.head) return { ok: false, fault: { kind: "live-mirror-failed", detail: "repository HEAD changed during live capture" } };
        return pinHeldLive({ ...selection, head: head.value, tree, deps, ...(hold === undefined ? {} : { hold }) }, signal);
      });
      if (opened.ok) return opened.value;
      const failure = { repoId: selection.repoId, cause: opened.fault };
      if (signal?.aborted) return { ok: false, fault: cancellation ??= failure };
      return { ok: false, fault: failure };
    };
    const result = await acquire(0);
    if (signal?.aborted) return { ok: false, fault: cancellation ?? { repoId: result.ok ? ordered[0]!.repoId : result.fault.repoId, cause: { kind: "aborted", detail: "live query aborted" } } };
    for (const postlude of postludes) {
      await postlude.run();
      if (signal?.aborted) return { ok: false, fault: { repoId: postlude.repoId, cause: { kind: "aborted", detail: "live query aborted" } } };
    }
    return result;
  } finally {
    hold?.release();
  }
}

export async function withLiveCapture<T, E>(deps: HeadReaderDeps, request: Extract<Revisioned, { live: true }>, options: {
  use(capture: HeldLive): Promise<Result<T, E>>;
  unavailable(context: { head: string; scope: DeclaredScope }): Promise<Result<T, E>>;
  beforeHead?(): Promise<Result<void, VcsFault>>;
  beforeOpen?(head: string): Promise<Result<void, VcsFault>>;
  /** Gives the capture up as `unavailable` before it takes the mirror lock or refreshes (`OpenLive.declined`). */
  declined?: OpenLive["declined"];
}): Promise<Result<T, E | VcsFault | LiveFault | ScopeFault>> {
  const { repo, repoId, signal } = request;
  const scope = liveScope(request.scope);
  if (signal?.aborted) return ABORTED;
  if (deps.heldLive !== undefined) {
    const held = deps.heldLive({ repo, repoId });
    if (held === undefined || held.kind !== "live" || held.trust !== "trusted" || held.repo !== repo || held.repoId !== repoId || held.tree.location.repo !== repo || canonicalJson(held.scope) !== canonicalJson(scope) || held.deps.vcs !== deps.vcs || held.deps.reader !== deps.reader || held.deps.extractor !== deps.extractor || held.deps.graph !== deps.graph || held.deps.matcher !== deps.matcher || held.deps.live === undefined || held.deps.live !== deps.live || held.tree.location.scope !== held.deps.live.digest.of(JSON.stringify(scope))) {
      return { ok: false, fault: { kind: "live-mirror-failed", detail: "held live capture does not match the request" } };
    }
    if (request.synthesized === true && held.tree.unparsedSinceBuild.length > 0) {
      return { ok: false, fault: { kind: "live-mirror-failed", detail: "held live capture holds stale synthesized edges" } };
    }
    const base = await options.beforeHead?.();
    if (signal?.aborted) return ABORTED;
    if (base !== undefined && !base.ok) return base;
    const prepared = await options.beforeOpen?.(held.head);
    if (signal?.aborted) return ABORTED;
    if (prepared !== undefined && !prepared.ok) return prepared;
    const answer = await options.use(held);
    return signal?.aborted ? ABORTED : answer;
  }
  const trust = await trustOf(deps, repo);
  if (trust !== "trusted" || deps.live === undefined) return LIVE_REQUIRES_TRUSTED;
  const base = await options.beforeHead?.();
  if (signal?.aborted) return ABORTED;
  if (base !== undefined && !base.ok) return base;
  if (options.beforeOpen === undefined) return captureWithHeadInside(deps, request, scope, options);
  const head = await deps.vcs.resolveCommit(repo, LIVE_HEAD, signal);
  if (!head.ok) return head;
  const prepared = await options.beforeOpen?.(head.value);
  if (signal?.aborted) return ABORTED;
  if (prepared !== undefined && !prepared.ok) return prepared;
  const opened = await withLiveCaptures(deps, [{ repo, repoId, scope, head: head.value, trust: "trusted", synthesized: request.synthesized, declined: options.declined, onStale: request.onStale }], signal, (captures) => options.use(captures.get(repoId)!));
  if (opened.ok) return opened.value;
  if (opened.fault.cause.kind === "unavailable") {
    const answer = await options.unavailable({ head: head.value, scope });
    return signal?.aborted ? ABORTED : answer;
  }
  return { ok: false, fault: opened.fault.cause };
}

/**
 * A live capture with nothing to do between HEAD and the open reads HEAD once, under the lock and after the refresh. A
 * failed open answers as it did when HEAD was read before the lock: an unreadable HEAD's fault comes first.
 */
async function captureWithHeadInside<T, E>(deps: HeadReaderDeps, request: Extract<Revisioned, { live: true }>, scope: DeclaredScope, options: Pick<Parameters<typeof withLiveCapture<T, E>>[2], "use" | "unavailable" | "declined">): Promise<Result<T, E | VcsFault | LiveFault | ScopeFault>> {
  const { repo, repoId, signal } = request;
  const opened = await withLiveCaptures(deps, [{ repo, repoId, scope, trust: "trusted", synthesized: request.synthesized, declined: options.declined, onStale: request.onStale }], signal, (captures) => options.use(captures.get(repoId)!));
  if (opened.ok) return opened.value;
  const { cause } = opened.fault;
  if (signal?.aborted) return cause.kind === "unavailable" ? ABORTED : { ok: false, fault: cause };
  const head = await deps.vcs.resolveCommit(repo, LIVE_HEAD, signal);
  if (!head.ok) return head;
  if (cause.kind === "unavailable") {
    const answer = await options.unavailable({ head: head.value, scope });
    return signal?.aborted ? ABORTED : answer;
  }
  return { ok: false, fault: cause };
}

/** What one operation adds to the fact base of every fact it answers. */
export interface FactSpec {
  declaredConfig: DeclaredConfig;
  engines: Readonly<Record<string, string>>;
}

export interface HeadIndex {
  store: CodeGraphReader;
  summary: Pick<IndexSummary, "filesNotIndexed">;
  /**
   * The digest of what the index was built from, for an index the index cache keeps by content: the snapshot's content
   * and the store's versions. Derived facts that read the index are kept under it; without it they are kept by none.
   */
  digest?: string;
  /** The committed store generation a live capture pinned the store at; the kept stage outputs are kept under it in memory (ADR-0150). */
  generation?: string;
}

/** What opening a head's index answers; `fault` is the export fault that kept the index from being built. */
export type HeadOpening = HeadIndex | "aborted" | "unavailable" | { fault: VcsFault };

function exportFailure(fault: VcsFault): "aborted" | { fault: VcsFault } {
  return fault.kind === "aborted" ? "aborted" : { fault };
}

/** The head of a query as the operation reads it: a commit's export or the mirror, with the means to index it. */
export interface HeadReading<Tree extends Pick<CommitExtraction, "export"> = CommitExtraction> {
  tree: Tree;
  prepared?: PreparedCommit;
  /** The read's open parse hold, which owns the trees of the sources it kept; absent where nothing is held. */
  hold?: ParseHold | undefined;
  selected: PathSelection;
  /** The fact base for `content`; `store` is true for a fact that read the index, which records where it came from. */
  base(content: string, store?: boolean): FactBase;
  /** The head's index; the caller closes its store. */
  open(): Promise<HeadOpening>;
}

/** A revisioned request: the repository, what it selects, and the revision or the live tree it reads. */
export type Revisioned = { repo: string; source?: string; repoId: string; scope?: ScopeRequest; signal?: AbortSignal; [WORKSPACE_SCOPE]?: true; synthesized?: OpenLive["synthesized"] } & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

/** A live query reads the working tree against the commit HEAD names. */
const LIVE_HEAD = "HEAD";

/**
 * The files of the index's universe the store did not hold, limited to what the head export staged: the engine reads
 * the whole mirror and a commit's whole listing, so a path the export never wrote could not be read by this answer.
 */
function notHeldInExport(notHeld: readonly string[], exported: CommitExport): Pick<IndexSummary, "filesNotIndexed"> {
  const staged = new Set(exported.files.filter((file) => file.written).map((file) => file.path));
  return { filesNotIndexed: notHeld.filter((path) => staged.has(path)) };
}

export interface HeadReader {
  /** Reads a head export and its index without loading sources or extracting entrypoints; `root` holds the exported files. */
  atExport<V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export">>, root: string) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault | ScopeFault>>;
  atSources<V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export" | "sources">>) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault | ScopeFault>>;
  /** The one place a revisioned operation reads its head, at a commit or on the live tree, so its body is written once. */
  atHead<V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault | ScopeFault>>;
  /** The fact base of a snapshot: a commit's carries the host's export budget, the live tree reads none. */
  factBase(trust: TrustMode, snapshot: SnapshotRef, content: string, spec: FactSpec, scope: DeclaredScope, origin: IndexOrigin | undefined): FactBase;
  /** The head's index; the caller closes its store. A kept index is reused without writing the snapshot; a build writes it first. */
  indexHead(head: Pick<PreparedCommit, "root" | "tree" | "materialize">, directory: () => Promise<string>, signal: AbortSignal | undefined): Promise<HeadOpening>;
  /** The head of a live query: the capture pinned under the mirror lock, its store the one the capture pinned. */
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
    return { ...factBaseOf(deps, { repoId: snapshot.repo, sha, trust, scope, content, declaredConfig, engines: spec.engines, ...(origin === undefined ? {} : { origin }) }), snapshot };
  };

  const indexHead = async (head: Pick<PreparedCommit, "root" | "tree" | "materialize">, directory: () => Promise<string>, signal: AbortSignal | undefined): Promise<HeadOpening> => {
    const { root, tree } = head;
    let exportFault: VcsFault | undefined;
    if (deps.indexes !== undefined) {
      const prepare = async (): Promise<Result<void, CodeGraphFault>> => {
        const ready = await head.materialize(signal);
        if (ready.ok) return ready;
        exportFault = ready.fault;
        return { ok: false, fault: { kind: ready.fault.kind === "aborted" ? "aborted" : "stage-failed", detail: ready.fault.detail } };
      };
      const content = deps.digest.of(contentFingerprint(tree.export, deps.sourceSelection));
      const kept = await deps.indexes.obtain({ content, snapshot: root, prepare, signal });
      if (kept.ok) return { store: kept.value.store, summary: notHeldInExport(kept.value.summary.filesNotIndexed, tree.export), digest: deps.digest.of(canonicalJson({ content, versions: kept.value.store.versions })) };
      if (exportFault !== undefined) return exportFailure(exportFault);
      if (kept.fault.kind === "aborted") return "aborted";
      if (kept.fault.kind !== "cache-unavailable") return "unavailable";
    }
    const ready = await head.materialize(signal);
    if (!ready.ok) return exportFailure(ready.fault);
    const storeDirectory = await directory();
    const indexed = await deps.graph.index(root, storeDirectory, signal);
    if (!indexed.ok) return indexed.fault.kind === "aborted" ? "aborted" : "unavailable";
    const opened = deps.graph.open(storeDirectory);
    return opened.ok ? { store: opened.value, summary: notHeldInExport(indexed.value.filesNotIndexed, tree.export) } : "unavailable";
  };

  const liveReading = <Tree extends Pick<CommitExtraction, "export">>(tree: LiveTree, extraction: Tree, trust: TrustMode, scope: DeclaredScope, selected: PathSelection, head: string, repoId: string, spec: FactSpec, hold?: ParseHold): HeadReading<Tree> => {
    const snapshot: SnapshotRef = { repo: repoId, kind: "live", head, stateId: tree.stateId };
    return {
      tree: extraction,
      ...(hold === undefined ? {} : { hold }),
      selected,
      base: (content, store = false) => factBase(trust, snapshot, content, spec, scope, store ? tree.origin : undefined),
      open: async () => (tree.store === undefined ? "unavailable" : { store: tree.store, summary: notHeldInExport(tree.notHeld, extraction.export), ...(tree.generation === undefined ? {} : { generation: tree.generation }) }),
    };
  };

  const unavailableLive = (trust: TrustMode, scope: DeclaredScope, head: string, repoId: string, spec: FactSpec): UnknownFact => {
    const unread = deps.digest.of(JSON.stringify([head]));
    return { ...factBase(trust, { repo: repoId, kind: "live", head, stateId: unread }, unread, spec, scope, undefined), status: "unknown", reason: "index-unavailable" };
  };

  const atSnapshot = async <V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export">>, root: string) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault | ScopeFault>> => {
    const { repo, repoId, signal } = request;
    if (request.live === true) {
      return withLiveCapture<Fact<V>, E | VcsFault | ScopeFault>(deps, request, { use: async (held) => {
        if (signal?.aborted) return ABORTED;
        const { tree, scope, head } = held;
        const selected = pathSelection(scope, deps.matcher.matches);
        const prepared = preparedLive(held);
        const notice = scopeNotice(scope, deps.matcher.matches, request[WORKSPACE_SCOPE] ? undefined : heldPaths(tree.export)?.filter(selected));
        if (!notice.ok) return notice;
        const reading = liveReading(tree, prepared.tree, "trusted", scope, selected, head, repoId, spec, held.hold);
        return read({ ...reading, base: (content, store) => ({ ...reading.base(content, store), ...(notice.value === undefined ? {} : { scopeSelection: notice.value }) }), prepared }, tree.root);
      }, unavailable: async ({ head, scope }) => ({ ok: true, value: unavailableLive("trusted", scope, head, repoId, spec) }) });
    }

    const scope = declaredScope(request.scope);
    const selected = pathSelection(scope, deps.matcher.matches);
    const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
    const source = request.source ?? repo;
    const head = await vcs.resolveCommit(source, request.revision, signal);
    if (!head.ok) return head;
    const trust = await trustOf(deps, repo);
    const snapshot: SnapshotRef = { repo: repoId, kind: "sha", sha: head.value };
    return withScratch(deps, async (readScope) => {
      const prepared = await prepareCommit(deps, source, head.value, readScope, exported, { scope, trust }, signal);
      if (!prepared.ok) return prepared;
      const { root: headDirectory, tree: headTree } = prepared.value;
      const notice = scopeNotice(scope, deps.matcher.matches, request[WORKSPACE_SCOPE] ? undefined : heldPaths(headTree.export)?.filter(selected));
      if (!notice.ok) return notice;
      return read({
        tree: headTree,
        prepared: prepared.value,
        hold: prepared.value.hold,
        selected,
        base: (content, store = false) => ({ ...factBase(trust, snapshot, content, spec, scope, store ? { kind: "full" } : undefined), ...(notice.value === undefined ? {} : { scopeSelection: notice.value }) }),
        open: () => indexHead(prepared.value, readScope.directory, signal),
      }, headDirectory);
    });
  };

  const atHead = <V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault | ScopeFault>> => atSnapshot<V, E | VcsFault>(request, spec, async (head, root) => {
    const extracted = head.prepared === undefined ? await extractExport(deps, root, head.tree.export, request.signal) : await head.prepared.extract(request.signal);
    return extracted.ok ? read({ ...head, tree: extracted.value }) : extracted;
  });

  const atSources = <V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading<Pick<CommitExtraction, "export" | "sources">>) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | VcsFault | LiveFault | ScopeFault>> => atSnapshot<V, E | VcsFault>(request, spec, async (head, root) => {
    const loaded = head.prepared === undefined ? await readSources(deps, root, head.tree.export, request.signal) : await head.prepared.sources(request.signal);
    return loaded.ok ? read({ ...head, tree: loaded.value }) : loaded;
  });

  return { atHead, atSources, atExport: atSnapshot, factBase, indexHead, liveReading, unavailableLive };
}
