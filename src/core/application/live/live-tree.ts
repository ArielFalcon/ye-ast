import { contentFingerprint } from "../../domain/map/entrypoint-map.ts";
import type { DeclaredScope, IndexOrigin } from "../../domain/shared/fact.ts";
import type { PathSelection } from "../../domain/shared/scope.ts";
import type { Result } from "../../domain/shared/result.ts";
import { isWritten, liveExport } from "../../domain/snapshot/live-export.ts";
import { retentionDiscards, type LiveRetentionPolicy, type LiveScopeUsage } from "../../domain/snapshot/live-retention.ts";
import type { CodeGraph, CodeGraphFault, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { IndexCache } from "../../ports/index-cache.port.ts";
import type { LiveFault, LiveFailure, LiveUnavailable, LiveStaleNotice } from "../../ports/live-queries.port.ts";
import type { LiveMirror, MirrorFault, MirrorLocation, MirrorState, MirrorVersions } from "../../ports/live-mirror.port.ts";
import type { CommitExport, VcsFault } from "../../ports/vcs.port.ts";
import type { WorkingTree } from "../../ports/working-tree.port.ts";
import { compareText } from "../../domain/shared/code-node.ts";

export interface LiveDeps {
  workingTree: WorkingTree;
  mirror: LiveMirror;
  graph: CodeGraph;
  digest: Digest;
  /** The engines the mirror is valid for; a recorded state built by others is discarded. */
  versions: MirrorVersions;
  /** How many mirrors stay and for how long; composition supplies the values. */
  retention: LiveRetentionPolicy;
  /** The clock the sweep reads, supplied by composition: the core reads no wall clock. */
  now: () => number;
  /** A token no other commit of any mirror, in this process or another, has used: the store generation a build or sync commits. */
  newStoreGeneration: () => string;
  /** Full indexes kept by content: a full build of the mirror copies the one its content names, built there when absent (ADR-0129). */
  indexes?: IndexCache | undefined;
}

export type { LiveFailure, LiveUnavailable } from "../../ports/live-queries.port.ts";

/**
 * The mirror as one query pinned it under its lock (ADR-0144): its export and the store at the generation the refresh
 * committed. The answer reads only these, and what the `pin` of `openLive` read, so a later sync cannot change it.
 */
export interface LiveTree {
  /**
   * The directory the extractors and the engine read: the index tree when the query reads the store, the mirror
   * itself otherwise, since both hold every path the export writes. Only the `pin` of `openLive` reads it: a later sync
   * rewrites it.
   */
  root: string;
  export: CommitExport;
  stateId: string;
  /** Files the store does not hold; empty when the query asked for no store. */
  notHeld: readonly string[];
  /** Where the store came from; set when the query asked for a store. */
  origin: IndexOrigin | undefined;
  /** The store generation `store` was pinned at (ADR-0125); absent when the query asked for no store or none was committed. */
  generation?: string | undefined;
  /** The paths whose synthesized edges the store holds stale (`MirrorState.unparsedSinceBuild`); empty when the query asked for no store. */
  unparsedSinceBuild: readonly string[];
  location: MirrorLocation;
  /**
   * The store at the committed generation, read whole under the lock; absent when the query asked for no store or it
   * could not be opened. Every reading of the tree shares it: closing it does nothing, and `openLive` releases it when it
   * returns.
   */
  store?: CodeGraphReader | undefined;
}

export interface OpenLive {
  repo: string;
  scope: DeclaredScope;
  /** The scope's selection, applied to the listing as it is to an export. */
  selected: PathSelection;
  /** True when the answer reads the store: the refresh then brings it up to date or builds it. */
  store: boolean;
  /**
   * True when the answer reads the edges the engine synthesizes from files it does not parse (an Angular template's
   * renders and router links): a store a sync left stale for them is built in full.
   */
  synthesized?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onStale?: ((notice: LiveStaleNotice) => void) | undefined;
  onStalenessUnavailable?: ((notice: { stateId: string } & ({ stage: "listing"; cause: VcsFault } | { stage: "comparison"; cause: MirrorFault })) => void | Promise<void>) | undefined;
}

function aborted(): Result<never, VcsFault> {
  return { ok: false, fault: { kind: "aborted", detail: "live query aborted" } };
}

function unavailable(detail: string): Result<never, LiveUnavailable> {
  return { ok: false, fault: { kind: "unavailable", detail } };
}

/**
 * The store a committed state names, if it can still be opened: the state is a claim, and the open is the proof. It is
 * opened at the committed generation, so the reader holds it whole; a state that names none does not serve.
 */
function storeServes(deps: LiveDeps, root: string, state: MirrorState): CodeGraphReader | undefined {
  const generation = committedGeneration(state);
  if (generation === undefined) return undefined;
  const opened = deps.graph.open(root, generation);
  return opened.ok ? opened.value : undefined;
}

/** A view of the pinned reader that every reading of the tree may close without closing it for the others. */
function shared(reader: CodeGraphReader): CodeGraphReader {
  return {
    versions: reader.versions,
    symbolsInFiles: (files) => reader.symbolsInFiles(files),
    symbolsByIds: (ids) => reader.symbolsByIds(ids),
    declarationsNamed: (names) => reader.declarationsNamed(names),
    incomingEdges: (targets, kinds) => reader.incomingEdges(targets, kinds),
    outgoingEdges: (sources, kinds) => reader.outgoingEdges(sources, kinds),
    unresolvedReferences: (files) => reader.unresolvedReferences(files),
    close: () => undefined,
  };
}

/** The store generation a state commits; none while a refresh left paths pending, since the store may then be mid-write. */
function committedGeneration(state: MirrorState): string | undefined {
  return state.pending.length === 0 && state.storeGeneration !== "" ? state.storeGeneration : undefined;
}

/**
 * The repositories each process's live dependencies already swept. The sweep runs on the first answer a process gives
 * for a repository and after a refresh that created, discarded or fully built a mirror; otherwise the live directory
 * did not change in a way this process caused, and measuring it again would cost every query a `readdir` and a `stat`
 * per entry.
 */
const swept = new WeakMap<LiveDeps, Set<string>>();

function mirrorFailure(fault: MirrorFault): Result<never, LiveFailure> {
  return fault.kind === "aborted" ? unavailable(fault.detail) : { ok: false, fault: { kind: "live-mirror-failed", detail: `${fault.kind}: ${fault.detail}` } };
}

function sameVersions(a: MirrorVersions, b: MirrorVersions): boolean {
  return a.codegraph === b.codegraph && a.store === b.store && a.staging === b.staging;
}

const sorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort(compareText);

/**
 * One live query (RFC-0010 "Live head", ADR-0144): takes the mirror's lock, brings the mirror up to date with the working
 * tree, pins the store at the generation the refresh committed, runs `pin` on the tree and releases the lock whatever
 * happens; then runs `use` on the pinned tree and what `pin` answered, outside the lock, releases the pinned store
 * whatever `use` does, and says whether the tree moved meanwhile. `pin` reads what the answer needs from the mirror's
 * files: nothing `use` runs may read them or open the store, since a later sync rewrites both. Nothing here runs a
 * program the repository names or reads a file outside the mirror's own copy. Once the answer is built it sweeps the
 * mirrors of other scopes, as RFC-0010 "Retention" describes, when this process has not swept the repository yet or the
 * refresh created, discarded or fully built a mirror.
 */
export async function openLive<A, P = undefined>(deps: LiveDeps, request: OpenLive, use: (tree: LiveTree, pinned: P) => Promise<A>, pin?: (tree: LiveTree) => Promise<P>): Promise<Result<A, LiveFailure>> {
  const { mirror, workingTree, digest } = deps;
  const { repo, scope, signal } = request;
  const location: MirrorLocation = { repo, scope: digest.of(JSON.stringify(scope)) };

  if (signal?.aborted) return aborted();
  const lock = await mirror.lock(location, signal);
  if (!lock.ok) return signal?.aborted ? aborted() : mirrorFailure(lock.fault);
  const pinnedStore: PinnedStore = { reader: undefined };
  let answered: A;
  let reflected: { state: Pick<MirrorState, "manifest" | "skipped">; stateId: string };
  let reshaped: boolean;
  try {
    const pinned = await (async (): Promise<Result<{ tree: LiveTree; pinned: P; state: MirrorState; reshaped: boolean }, LiveFailure>> => {
      try {
        if (signal?.aborted) return aborted();
        const refreshed = await refresh(deps, request, location, pinnedStore);
        if (signal?.aborted) return aborted();
        if (!refreshed.ok) return refreshed;
        const { reader } = pinnedStore;
        const tree: LiveTree = reader === undefined ? { ...refreshed.value.tree, generation: undefined } : { ...refreshed.value.tree, store: shared(reader) };
        await mirror.touch(location);
        if (signal?.aborted) return aborted();
        const read = (await pin?.(tree)) as P;
        if (signal?.aborted) return aborted();
        return { ok: true, value: { tree, pinned: read, state: refreshed.value.state, reshaped: refreshed.value.reshaped } };
      } finally {
        await lock.value.release();
      }
    })();
    if (signal?.aborted) return aborted();
    if (!pinned.ok) return pinned;
    answered = await use(pinned.value.tree, pinned.value.pinned);
    reflected = { state: pinned.value.state, stateId: pinned.value.tree.stateId };
    reshaped = pinned.value.reshaped;
  } finally {
    pinnedStore.reader?.close();
    pinnedStore.reader = undefined;
  }

  if (signal?.aborted) return aborted();
  if (request.onStale !== undefined || request.onStalenessUnavailable !== undefined) {
    const listing = await workingTree.list(repo, signal);
    if (signal?.aborted) return aborted();
    if (!listing.ok) {
      await request.onStalenessUnavailable?.({ stateId: reflected.stateId, stage: "listing", cause: listing.fault });
    } else {
      const moved = await mirror.changedSince(location, listing.value.paths.filter((entry) => request.selected(entry.path)), reflected.state, signal);
      if (signal?.aborted) return aborted();
      if (!moved.ok) await request.onStalenessUnavailable?.({ stateId: reflected.stateId, stage: "comparison", cause: moved.fault });
      else if (moved.value.length > 0) await request.onStale?.({ stateId: reflected.stateId, changed: moved.value });
    }
  }
  if (signal?.aborted) return aborted();
  const repositories = swept.get(deps) ?? new Set<string>();
  swept.set(deps, repositories);
  if (reshaped || !repositories.has(repo)) {
    if (await sweep(deps, repo, location.scope)) repositories.add(repo);
    if (signal?.aborted) return aborted();
  }
  return { ok: true, value: answered };
}

/**
 * Discards what the retention policy names, after the answer: it measures the live directory, decides in the core and
 * removes one mirror at a time. It never fails the query it follows, and what it cannot read or remove the mirror keeps.
 * It answers whether the live directory was measured, so a sweep that could not read it runs again on the next answer.
 */
async function sweep(deps: LiveDeps, repo: string, current: string): Promise<boolean> {
  try {
    const measured = await deps.mirror.usage(repo);
    if (!measured.ok) return false;
    const scopes: LiveScopeUsage[] = measured.value.scopes.map((scope) => ({
      scope: scope.scope,
      bytes: scope.bytes,
      lastUsedMs: scope.lastUsedMs,
      locked: scope.locked,
      versionsMatch: scope.versions !== null && sameVersions(scope.versions, deps.versions),
    }));
    const discards = retentionDiscards({ scopes, debris: measured.value.debris }, current, deps.retention, deps.now());
    for (const scope of discards.scopes) {
      await deps.mirror.discardIfIdle({ repo, scope });
      deps.graph.retireMirror(deps.mirror.indexRoot({ repo, scope }));
    }
    if (discards.debris.length > 0) await deps.mirror.discardDebris(repo, discards.debris);
    return true;
  } catch {
    return false;
  }
}

/**
 * The store the query pins, opened under the lock at a committed generation: the reader that proved an unchanged store,
 * or the one a build or sync just committed. `openLive` closes it when the query returns.
 */
interface PinnedStore {
  reader: CodeGraphReader | undefined;
}

interface Refreshed {
  tree: LiveTree;
  state: MirrorState;
  /** The refresh created, discarded or fully built the mirror, which changes what the retention sweep measures. */
  reshaped: boolean;
}

async function refresh(deps: LiveDeps, request: OpenLive, location: MirrorLocation, pinned: PinnedStore): Promise<Result<Refreshed, LiveFailure>> {
  const { mirror, workingTree, graph, digest, versions } = deps;
  const { signal } = request;

  const recorded = await mirror.readState(location);
  if (!recorded.ok) return mirrorFailure(recorded.fault);
  let state = recorded.value;
  const created = state === null || !sameVersions(state.versions, versions);
  if (created) {
    const discarded = await mirror.discard(location);
    if (!discarded.ok) return mirrorFailure(discarded.fault);
    graph.retireMirror(mirror.indexRoot(location));
    state = null;
  }

  const listing = await workingTree.list(location.repo, signal);
  if (!listing.ok) return listing.fault.kind === "aborted" ? unavailable(listing.fault.detail) : listing;
  if (listing.value.objectFormat !== "sha1") {
    return { ok: false, fault: { kind: "unsupported-object-format", detail: `the repository uses the ${listing.value.objectFormat} object format; only sha1 is read` } };
  }
  const paths = listing.value.paths.filter((entry) => request.selected(entry.path));

  const reconciled = await mirror.reconcile(location, paths, state?.manifest ?? [], signal);
  if (!reconciled.ok) return mirrorFailure(reconciled.fault);
  const { manifest, skipped, changed } = reconciled.value;
  const exported = liveExport(manifest, skipped);
  const stateId = digest.of(contentFingerprint(exported, isWritten));

  // The store's universe is the export's written set, never the listing: a test file the export does not write must not
  // reach the engine, or the live answer would diverge from the commit's (RFC-0010 "The mirror").
  const writtenFiles = exported.files.filter((file) => file.written);
  const written = writtenFiles.map((file) => file.path);
  const writtenSet = new Set(written);
  const held = state?.indexed ?? [];
  let staging = sorted([...(state?.pending ?? []), ...changed].filter((path) => writtenSet.has(path)));
  let pruning = sorted([...held, ...(state?.pending ?? [])].filter((path) => !writtenSet.has(path)));
  let behind = sorted([...staging, ...pruning]);

  const current: MirrorState = {
    versions,
    manifest,
    skipped,
    notHeld: state?.notHeld ?? [],
    indexed: held,
    fullBuildStateId: state?.fullBuildStateId ?? "",
    unparsedSinceBuild: state?.unparsedSinceBuild ?? [],
    stateId,
    pending: behind,
    storeGeneration: state?.storeGeneration ?? "",
  };

  // A committed state records what the engine last built; only opening the store proves it is still there. A store that
  // was removed, truncated or left unreadable behind such a state is rebuilt here, under the lock this refresh already
  // holds, instead of answering `unknown` with `index-unavailable` to every later query (RFC-0005 "First index").
  const claimsBuild = current.fullBuildStateId !== "" && behind.length === 0;
  pinned.reader = request.store && claimsBuild ? storeServes(deps, mirror.indexRoot(location), current) : undefined;
  if (request.store && claimsBuild && pinned.reader === undefined) {
    current.fullBuildStateId = "";
    staging = sorted(written);
    pruning = [];
    behind = sorted(written);
    current.pending = behind;
  }

  const moved = state === null || JSON.stringify([state.manifest, state.skipped]) !== JSON.stringify([manifest, skipped]) || state.pending.length !== behind.length;
  const tree = (heldState: MirrorState): LiveTree => ({
    root: request.store ? mirror.indexRoot(location) : mirror.root(location),
    export: exported,
    stateId,
    notHeld: request.store ? heldState.notHeld : [],
    origin: request.store ? (heldState.fullBuildStateId === stateId ? { kind: "full" } : { kind: "sync", base: heldState.fullBuildStateId }) : undefined,
    generation: request.store ? committedGeneration(heldState) : undefined,
    unparsedSinceBuild: request.store ? heldState.unparsedSinceBuild : [],
    location,
  });

  if (request.store && request.synthesized === true && current.unparsedSinceBuild.length > 0) current.fullBuildStateId = "";
  const needsBuild = current.fullBuildStateId === "";
  if (!request.store || (!needsBuild && behind.length === 0)) {
    if (moved) {
      const writtenState = await mirror.writeState(location, current);
      if (!writtenState.ok) return mirrorFailure(writtenState.fault);
    }
    return { ok: true, value: { tree: tree(current), state: current, reshaped: created } };
  }
  pinned.reader?.close();
  pinned.reader = undefined;

  // A refresh that only copied files keeps the generation, since it left the store as it was; one that begins to write
  // the store clears it until it commits, so a reader or a worker that finds the write unfinished trusts nothing kept.
  const committedBefore = current.storeGeneration;
  current.storeGeneration = "";
  const begun = await mirror.writeState(location, current);
  if (!begun.ok) return mirrorFailure(begun.fault);
  const indexRoot = mirror.indexRoot(location);
  if (staging.length > 0) {
    const staged = await mirror.materialize(location, staging, indexRoot, signal);
    if (!staged.ok) return mirrorFailure(staged.fault);
  }
  if (pruning.length > 0) {
    const pruned = await mirror.prune(location, pruning, signal);
    if (!pruned.ok) return mirrorFailure(pruned.fault);
  }
  const next = deps.newStoreGeneration();
  let full = needsBuild;
  let notHeld: readonly string[];
  let unparsed: readonly string[] = [];
  if (needsBuild) {
    const built = await buildInFull(deps, location, writtenFiles, stateId, signal);
    if (!built.ok) return unavailable(built.fault.detail);
    notHeld = built.value.filesNotIndexed;
  } else {
    const synced = await graph.syncMirror(indexRoot, behind, signal, { held: committedBefore, next });
    if (!synced.ok && synced.fault.kind === "aborted") return unavailable(synced.fault.detail);
    unparsed = synced.ok ? sorted([...new Set([...current.unparsedSinceBuild, ...synced.value.filesUnparsed])]) : [];
    const staleForAnswer = request.synthesized === true && unparsed.length > 0;
    if (synced.ok && !staleForAnswer) {
      notHeld = sorted([...synced.value.filesNotIndexed, ...synced.value.filesFailed]);
    } else {
      const rebuilt = await buildInFull(deps, location, writtenFiles, stateId, signal);
      if (!rebuilt.ok) return unavailable(rebuilt.fault.detail);
      notHeld = rebuilt.value.filesNotIndexed;
      full = true;
    }
  }
  const committed: MirrorState = { ...current, notHeld: sorted(notHeld), indexed: sorted(written), fullBuildStateId: full ? stateId : current.fullBuildStateId, unparsedSinceBuild: full ? [] : unparsed, pending: [], storeGeneration: next };
  const writtenState = await mirror.writeState(location, committed);
  if (!writtenState.ok) return mirrorFailure(writtenState.fault);
  pinned.reader = storeServes(deps, indexRoot, committed);
  return { ok: true, value: { tree: tree(committed), state: committed, reshaped: created || full } };
}

/**
 * Builds the index tree's store in full. With an index cache it is the kept index of the tree's content, built and
 * published there as a commit's is when absent, then copied into the mirror; a sync-derived store never reaches the cache.
 * The tree is published only once it is shown to hold exactly the written files, byte for byte, since it sits inside
 * the repository and its recorded state is only a claim. A tree that departs from them, a check, a cache or a copy that
 * fails builds the mirror in place, unpublished, and a written file the tree lacks is one the store does not hold (ADR-0129).
 */
async function buildInFull(deps: LiveDeps, location: MirrorLocation, writtenFiles: readonly { path: string; blob: string }[], stateId: string, signal: AbortSignal | undefined): Promise<Result<IndexSummary, CodeGraphFault>> {
  const indexRoot = deps.mirror.indexRoot(location);
  let missing: readonly string[] = [];
  if (deps.indexes !== undefined) {
    const checked = await deps.mirror.verifyIndexTree(location, writtenFiles, signal);
    if (!checked.ok && checked.fault.kind === "aborted") return { ok: false, fault: { kind: "aborted", detail: checked.fault.detail } };
    if (checked.ok) missing = checked.value.missing;
    const exact = checked.ok && missing.length === 0 && checked.value.foreign.length === 0;
    const kept = exact ? await deps.indexes.obtain({ content: stateId, snapshot: indexRoot, signal }) : undefined;
    if (kept !== undefined && !kept.ok && kept.fault.kind === "aborted") return kept;
    if (kept?.ok) {
      try {
        const adopted = await deps.graph.adoptMirror(indexRoot, kept.value.directory, signal);
        if (adopted.ok || adopted.fault.kind === "aborted") return adopted;
      } finally {
        kept.value.store.close();
      }
    }
  }
  const built = await deps.graph.buildMirror(indexRoot, signal);
  return built.ok && missing.length > 0 ? { ok: true, value: { ...built.value, filesNotIndexed: sorted([...built.value.filesNotIndexed, ...missing]) } } : built;
}

/** The fault a query answers for a failed live open, with an unfinished refresh as `aborted` for the families that have no `unknown` to answer. */
export function asFault(failure: LiveFailure): LiveFault | VcsFault {
  return failure.kind === "unavailable" ? { kind: "aborted", detail: failure.detail } : failure;
}
