import { contentFingerprint } from "../../domain/map/entrypoint-map.ts";
import type { DeclaredScope, IndexOrigin } from "../../domain/shared/fact.ts";
import type { PathSelection } from "../../domain/shared/scope.ts";
import type { Result } from "../../domain/shared/result.ts";
import { isWritten, liveExport } from "../../domain/snapshot/live-export.ts";
import { retentionDiscards, type LiveRetentionPolicy, type LiveScopeUsage } from "../../domain/snapshot/live-retention.ts";
import type { CodeGraph } from "../../ports/code-graph.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
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
}

export type { LiveFailure, LiveUnavailable } from "../../ports/live-queries.port.ts";

/** The mirror as one query reads it, valid until `openLive` returns: its lock is held until then. */
export interface LiveTree {
  /**
   * The directory the extractors and the engine read: the index tree when the query reads the store, the mirror
   * itself otherwise, since both hold every path the export writes.
   */
  root: string;
  export: CommitExport;
  stateId: string;
  /** Files the store does not hold; empty when the query asked for no store. */
  notHeld: readonly string[];
  /** Where the store came from; set when the query asked for a store. */
  origin: IndexOrigin | undefined;
  location: MirrorLocation;
}

export interface OpenLive {
  repo: string;
  scope: DeclaredScope;
  /** The scope's selection, applied to the listing as it is to an export. */
  selected: PathSelection;
  /** True when the answer reads the store: the refresh then brings it up to date or builds it. */
  store: boolean;
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

/** Whether the store a committed state names can still be opened: the state is a claim, and the open is the proof. */
function storeServes(deps: LiveDeps, root: string): boolean {
  const opened = deps.graph.open(root);
  if (!opened.ok) return false;
  opened.value.close();
  return true;
}

function mirrorFailure(fault: MirrorFault): Result<never, LiveFailure> {
  return fault.kind === "aborted" ? unavailable(fault.detail) : { ok: false, fault: { kind: "live-mirror-failed", detail: `${fault.kind}: ${fault.detail}` } };
}

function sameVersions(a: MirrorVersions, b: MirrorVersions): boolean {
  return a.codegraph === b.codegraph && a.store === b.store && a.staging === b.staging;
}

const sorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort(compareText);

/**
 * One live query (RFC-0010 "Live head"): takes the mirror's lock, brings the mirror up to date with the working tree,
 * runs `use` on it and releases the lock whatever `use` does, then says whether the tree moved meanwhile. Nothing here
 * runs a program the repository names or reads a file outside the mirror's own copy. Once the answer is built it sweeps
 * the mirrors of other scopes, as RFC-0010 "Retention" describes.
 */
export async function openLive<A>(deps: LiveDeps, request: OpenLive, use: (tree: LiveTree) => Promise<A>): Promise<Result<A, LiveFailure>> {
  const { mirror, workingTree, digest } = deps;
  const { repo, scope, signal } = request;
  const location: MirrorLocation = { repo, scope: digest.of(JSON.stringify(scope)) };

  if (signal?.aborted) return aborted();
  const lock = await mirror.lock(location, signal);
  if (!lock.ok) return signal?.aborted ? aborted() : mirrorFailure(lock.fault);
  let outcome: Result<{ answered: A; reflected: { state: Pick<MirrorState, "manifest" | "skipped">; stateId: string } }, LiveFailure>;
  try {
    outcome = await (async () => {
      if (signal?.aborted) return aborted();
      const refreshed = await refresh(deps, request, location);
      if (signal?.aborted) return aborted();
      if (!refreshed.ok) return refreshed;
      const { tree, state } = refreshed.value;
      await mirror.touch(location);
      if (signal?.aborted) return aborted();
      const answered = await use(tree);
      return { ok: true, value: { answered, reflected: { state, stateId: tree.stateId } } };
    })();
  } finally {
    await lock.value.release();
  }

  if (signal?.aborted) return aborted();
  if (!outcome.ok) return outcome;
  const { answered, reflected } = outcome.value;
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
  await sweep(deps, repo, location.scope);
  if (signal?.aborted) return aborted();
  return { ok: true, value: answered };
}

/**
 * Discards what the retention policy names, once per query and after the answer: it measures the live directory, decides
 * in the core and removes one mirror at a time. It never fails the query it follows, and what it cannot read or remove
 * the mirror keeps.
 */
async function sweep(deps: LiveDeps, repo: string, current: string): Promise<void> {
  try {
    const measured = await deps.mirror.usage(repo);
    if (!measured.ok) return;
    const scopes: LiveScopeUsage[] = measured.value.scopes.map((scope) => ({
      scope: scope.scope,
      bytes: scope.bytes,
      lastUsedMs: scope.lastUsedMs,
      locked: scope.locked,
      versionsMatch: scope.versions !== null && sameVersions(scope.versions, deps.versions),
    }));
    const discards = retentionDiscards({ scopes, debris: measured.value.debris }, current, deps.retention, deps.now());
    for (const scope of discards.scopes) await deps.mirror.discardIfIdle({ repo, scope });
    if (discards.debris.length > 0) await deps.mirror.discardDebris(repo, discards.debris);
  } catch {
    return;
  }
}

interface Refreshed {
  tree: LiveTree;
  state: MirrorState;
}

async function refresh(deps: LiveDeps, request: OpenLive, location: MirrorLocation): Promise<Result<Refreshed, LiveFailure>> {
  const { mirror, workingTree, graph, digest, versions } = deps;
  const { signal } = request;

  const recorded = await mirror.readState(location);
  if (!recorded.ok) return mirrorFailure(recorded.fault);
  let state = recorded.value;
  if (state === null || !sameVersions(state.versions, versions)) {
    const discarded = await mirror.discard(location);
    if (!discarded.ok) return mirrorFailure(discarded.fault);
    state = null;
  }

  const listing = await workingTree.list(location.repo, signal);
  if (!listing.ok) return listing.fault.kind === "aborted" ? unavailable(listing.fault.detail) : listing;
  if (listing.value.objectFormat !== "sha1") {
    return { ok: false, fault: { kind: "unsupported-object-format", detail: `the repository uses the ${listing.value.objectFormat} object format; only sha1 is read` } };
  }
  const paths = listing.value.paths.filter((entry) => request.selected(entry.path));

  const reconciled = await mirror.reconcile(location, paths, state?.manifest ?? [], state?.pending ?? [], signal);
  if (!reconciled.ok) return mirrorFailure(reconciled.fault);
  const { manifest, skipped, changed } = reconciled.value;
  const exported = liveExport(manifest, skipped);
  const stateId = digest.of(contentFingerprint(exported, isWritten));

  // The store's universe is the export's written set, never the listing: a test file the export does not write must not
  // reach the engine, or the live answer would diverge from the commit's (RFC-0010 "The mirror").
  const written = exported.files.filter((file) => file.written).map((file) => file.path);
  const writtenSet = new Set(written);
  const held = state?.indexed ?? [];
  let staging = sorted([...(state?.pending ?? []), ...changed].filter((path) => writtenSet.has(path)));
  let pruning = held.filter((path) => !writtenSet.has(path));
  let behind = sorted([...staging, ...pruning]);

  const current: MirrorState = {
    versions,
    manifest,
    skipped,
    notHeld: state?.notHeld ?? [],
    indexed: held,
    fullBuildStateId: state?.fullBuildStateId ?? "",
    stateId,
    pending: behind,
  };

  // A committed state records what the engine last built; only opening the store proves it is still there. A store that
  // was removed, truncated or left unreadable behind such a state is rebuilt here, under the lock this refresh already
  // holds, instead of answering `unknown` with `index-unavailable` to every later query (RFC-0005 "First index").
  const claimsBuild = current.fullBuildStateId !== "" && behind.length === 0;
  if (request.store && claimsBuild && !storeServes(deps, mirror.indexRoot(location))) {
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
    location,
  });

  const needsBuild = current.fullBuildStateId === "";
  if (!request.store || (!needsBuild && behind.length === 0)) {
    if (moved) {
      const writtenState = await mirror.writeState(location, current);
      if (!writtenState.ok) return mirrorFailure(writtenState.fault);
    }
    return { ok: true, value: { tree: tree(current), state: current } };
  }

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
  let full = needsBuild;
  let notHeld: readonly string[];
  if (needsBuild) {
    const built = await graph.buildMirror(indexRoot, signal);
    if (!built.ok) return unavailable(built.fault.detail);
    notHeld = built.value.filesNotIndexed;
  } else {
    const synced = await graph.syncMirror(indexRoot, behind, signal);
    if (synced.ok) {
      notHeld = sorted([...synced.value.filesNotIndexed, ...synced.value.filesFailed]);
    } else if (synced.fault.kind === "aborted") {
      return unavailable(synced.fault.detail);
    } else {
      const rebuilt = await graph.buildMirror(indexRoot, signal);
      if (!rebuilt.ok) return unavailable(rebuilt.fault.detail);
      notHeld = rebuilt.value.filesNotIndexed;
      full = true;
    }
  }
  const committed: MirrorState = { ...current, notHeld: sorted(notHeld), indexed: sorted(written), fullBuildStateId: full ? stateId : current.fullBuildStateId, pending: [] };
  const writtenState = await mirror.writeState(location, committed);
  if (!writtenState.ok) return mirrorFailure(writtenState.fault);
  return { ok: true, value: { tree: tree(committed), state: committed } };
}

/** The fault a query answers for a failed live open, with an unfinished refresh as `aborted` for the families that have no `unknown` to answer. */
export function asFault(failure: LiveFailure): LiveFault | VcsFault {
  return failure.kind === "unavailable" ? { kind: "aborted", detail: failure.detail } : failure;
}
