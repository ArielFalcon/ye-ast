import { contentFingerprint } from "../../domain/map/entrypoint-map.ts";
import type { DeclaredScope, IndexOrigin } from "../../domain/shared/fact.ts";
import type { PathSelection } from "../../domain/shared/scope.ts";
import type { Result } from "../../domain/shared/result.ts";
import { liveExport } from "../../domain/snapshot/live-export.ts";
import type { CodeGraph } from "../../ports/code-graph.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { LiveFault, LiveStaleNotice } from "../../ports/live-queries.port.ts";
import type { LiveMirror, MirrorFault, MirrorLocation, MirrorState, MirrorVersions } from "../../ports/live-mirror.port.ts";
import type { CommitExport, VcsFault } from "../../ports/vcs.port.ts";
import type { WorkingTree } from "../../ports/working-tree.port.ts";

export interface LiveDeps {
  workingTree: WorkingTree;
  mirror: LiveMirror;
  graph: CodeGraph;
  digest: Digest;
  /** The engines the mirror is valid for; a recorded state built by others is discarded. */
  versions: MirrorVersions;
}

/** The refresh did not finish: the deadline or an interruption cut it, or the engine could not build the index. */
export interface LiveUnavailable {
  kind: "unavailable";
  detail: string;
}

export type LiveFailure = LiveFault | VcsFault | LiveUnavailable;

/** The mirror as one query reads it, valid until `openLive` returns: its lock is held until then. */
export interface LiveTree {
  /** The directory the extractors and the engine read. */
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
}

function unavailable(detail: string): Result<never, LiveUnavailable> {
  return { ok: false, fault: { kind: "unavailable", detail } };
}

function mirrorFailure(fault: MirrorFault): Result<never, LiveFailure> {
  return fault.kind === "aborted" ? unavailable(fault.detail) : { ok: false, fault: { kind: "live-mirror-failed", detail: `${fault.kind}: ${fault.detail}` } };
}

function sameVersions(a: MirrorVersions, b: MirrorVersions): boolean {
  return a.codegraph === b.codegraph && a.store === b.store && a.staging === b.staging;
}

const sorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * One live query (RFC-0010 "Live head"): takes the mirror's lock, brings the mirror up to date with the working tree,
 * runs `use` on it and releases the lock whatever `use` does, then says whether the tree moved meanwhile. Nothing here
 * runs a program the repository names or reads a file outside the mirror's own copy.
 */
export async function openLive<A>(deps: LiveDeps, request: OpenLive, use: (tree: LiveTree) => Promise<A>): Promise<Result<A, LiveFailure>> {
  const { mirror, workingTree, digest } = deps;
  const { repo, scope, signal } = request;
  const location: MirrorLocation = { repo, scope: digest.of(JSON.stringify(scope)) };

  const lock = await mirror.lock(location, signal);
  if (!lock.ok) return mirrorFailure(lock.fault);
  let answered: A;
  let reflected: { state: Pick<MirrorState, "manifest" | "skipped">; stateId: string };
  try {
    const refreshed = await refresh(deps, request, location);
    if (!refreshed.ok) return refreshed;
    const { tree, state } = refreshed.value;
    answered = await use(tree);
    reflected = { state, stateId: tree.stateId };
  } finally {
    await lock.value.release();
  }

  if (request.onStale !== undefined && signal?.aborted !== true) {
    const listing = await workingTree.list(repo, signal);
    if (listing.ok) {
      const moved = await mirror.changedSince(location, listing.value.paths.filter((entry) => request.selected(entry.path)), reflected.state, signal);
      if (moved.ok && moved.value.length > 0) request.onStale({ stateId: reflected.stateId, changed: moved.value });
    }
  }
  return { ok: true, value: answered };
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
  if (state !== null && !sameVersions(state.versions, versions)) {
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
  const stateId = digest.of(contentFingerprint(exported));
  const behind = sorted([...(state?.pending ?? []), ...changed]);

  const current: MirrorState = {
    versions,
    manifest,
    skipped,
    notHeld: state?.notHeld ?? [],
    fullBuildStateId: state?.fullBuildStateId ?? "",
    stateId,
    pending: behind,
  };
  const moved = state === null || JSON.stringify([state.manifest, state.skipped]) !== JSON.stringify([manifest, skipped]) || state.pending.length !== behind.length;
  const tree = (held: MirrorState): LiveTree => ({
    root: mirror.root(location),
    export: exported,
    stateId,
    notHeld: request.store ? held.notHeld : [],
    origin: request.store ? (held.fullBuildStateId === stateId ? { kind: "full" } : { kind: "sync", base: held.fullBuildStateId }) : undefined,
    location,
  });

  const needsBuild = current.fullBuildStateId === "";
  if (!request.store || (!needsBuild && behind.length === 0)) {
    if (moved) {
      const written = await mirror.writeState(location, current);
      if (!written.ok) return mirrorFailure(written.fault);
    }
    return { ok: true, value: { tree: tree(current), state: current } };
  }

  const begun = await mirror.writeState(location, current);
  if (!begun.ok) return mirrorFailure(begun.fault);
  const root = mirror.root(location);
  let full = needsBuild;
  let notHeld: readonly string[];
  if (needsBuild) {
    const built = await graph.buildMirror(root, signal);
    if (!built.ok) return unavailable(built.fault.detail);
    notHeld = built.value.filesNotIndexed;
  } else {
    const synced = await graph.syncMirror(root, behind, signal);
    if (synced.ok) {
      notHeld = sorted([...synced.value.filesNotIndexed, ...synced.value.filesFailed]);
    } else if (synced.fault.kind === "aborted") {
      return unavailable(synced.fault.detail);
    } else {
      const rebuilt = await graph.buildMirror(root, signal);
      if (!rebuilt.ok) return unavailable(rebuilt.fault.detail);
      notHeld = rebuilt.value.filesNotIndexed;
      full = true;
    }
  }
  const committed: MirrorState = { ...current, notHeld: sorted(notHeld), fullBuildStateId: full ? stateId : current.fullBuildStateId, pending: [] };
  const written = await mirror.writeState(location, committed);
  if (!written.ok) return mirrorFailure(written.fault);
  return { ok: true, value: { tree: tree(committed), state: committed } };
}

/** The fault a query answers for a failed live open, with an unfinished refresh as `aborted` for the families that have no `unknown` to answer. */
export function asFault(failure: LiveFailure): LiveFault | VcsFault {
  return failure.kind === "unavailable" ? { kind: "aborted", detail: failure.detail } : failure;
}
