import type { LibrarySource } from "../../domain/topology/library-source.ts";
import { declaredScope } from "../../domain/map/entrypoint-map.ts";
import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import type { SnapshotRef } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { WorkspaceReplayContext } from "../../domain/topology/workspace-replay.ts";
import type { WorkspaceLiveNotice } from "../../ports/live-queries.port.ts";
import { withLiveCaptures, type HeadReaderDeps, type HeldLive } from "../snapshot/head-reading.ts";
import type { Result } from "../../domain/shared/result.ts";
import { exportSelection } from "../../domain/shared/scope.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import type { WorkspaceFault } from "../../ports/workspace-repos.port.ts";
import { withSnapshotPreparation } from "../snapshot/prepared-snapshot.ts";
import { ABORTED, LIVE_REQUIRES_TRUSTED, trustOf, type SnapshotPreparation } from "../snapshot/read-snapshot.ts";
import { planWorkspace, type CommittedPlan, type LivePlan, type WorkspacePlan, type WorkspacePlanningRequest } from "./workspace-plan.ts";
import type { SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { RemoteRefresh } from "../../ports/remote-refresh.port.ts";

interface WorkspaceSnapshotDeps extends SnapshotReaderDeps {
  matcher: PathMatcher;
  defaults?: WorkspaceDefaults;
  refresh?: RemoteRefresh;
  graph?: HeadReaderDeps["graph"];
  live?: HeadReaderDeps["live"];
}

/** Preflight metadata only; no working-tree lease is held. */
export interface LivePreflight extends LivePlan {
  readonly canonical: string;
  readonly head: string;
  readonly scope: ReturnType<typeof liveScope>;
  readonly trust: "trusted";
}

export interface WorkspaceSnapshotContext {
  readonly librarySources?: ReadonlyMap<string, readonly LibrarySource[]>;
  readonly plan: WorkspacePlan;
  readonly plans: readonly CommittedPlan[];
  readonly livePlans: readonly LivePreflight[];
  readonly scope: ReturnType<typeof declaredScope>;
  readonly selection: ReturnType<typeof exportSelection>;
  readonly preparation: SnapshotPreparation;
  readonly liveCaptures: ReadonlyMap<string, HeldLive>;
  readonly selectedSnapshots: readonly SnapshotRef[];
  readonly signal: AbortSignal | undefined;
}

export interface WorkspaceSnapshotRead<T> {
  readonly value: T;
  readonly workspaceReplay?: WorkspaceReplayContext;
  readonly workspaceLive?: readonly WorkspaceLiveNotice[];
}

export async function withWorkspaceSnapshots<T, F = never>(deps: WorkspaceSnapshotDeps, request: WorkspacePlanningRequest, use: (context: WorkspaceSnapshotContext) => Promise<Result<T, F>>): Promise<Result<WorkspaceSnapshotRead<T>, WorkspaceFault | F>> {
  if (request.signal?.aborted) return ABORTED;
  const canonical: { plan: LivePlan; root: string }[] = [];
  const planned = await planWorkspace(deps, request, { preflightLive: async (live) => {
    for (const plan of live) {
      if (request.signal?.aborted) return ABORTED;
      const root = await deps.vcs.canonicalRoot(plan.declared, request.signal);
      if (request.signal?.aborted) return ABORTED;
      if (!root.ok) return root;
      canonical.push({ plan, root: root.value });
    }
    const roots = new Map<string, string>();
    for (const { plan, root } of canonical) {
      const previous = roots.get(root);
      if (previous !== undefined) return { ok: false, fault: { kind: "duplicate-workspace-source", detail: JSON.stringify([previous, plan.repoId]) } };
      roots.set(root, plan.repoId);
    }
    for (const { root } of canonical) {
      if (request.signal?.aborted) return ABORTED;
      const trust = await trustOf(deps, root);
      if (request.signal?.aborted) return ABORTED;
      if (trust !== "trusted") return LIVE_REQUIRES_TRUSTED;
    }
    return { ok: true, value: undefined };
  } });
  if (request.signal?.aborted) return ABORTED;
  if (!planned.ok) return planned;
  const livePlans: LivePreflight[] = [];
  for (const { plan, root } of canonical) {
    const head = await deps.vcs.resolveCommit(root, "HEAD", request.signal);
    if (request.signal?.aborted) return ABORTED;
    if (!head.ok) return head;
    livePlans.push({ ...plan, canonical: root, head: head.value, scope: liveScope(request.scope), trust: "trusted" });
  }
  const committed = planned.value.plans.filter((plan): plan is CommittedPlan => plan.kind !== "live");
  const plans: CommittedPlan[] = [];
  for (const plan of committed) {
    if (plan.kind === "unavailable") { plans.push(plan); continue; }
    const resolved = await deps.vcs.resolveCommit(plan.at.source, plan.at.revision, request.signal);
    if (request.signal?.aborted) return ABORTED;
    if (!resolved.ok) {
      if (plan.at.pinnedSha !== undefined && resolved.fault.kind === "unknown-revision") {
        plans.push({ kind: "unavailable", repoId: plan.at.repoId, sha: plan.at.pinnedSha });
        continue;
      }
      return resolved;
    }
    plans.push({ kind: "read", at: { ...plan.at, revision: resolved.value } });
  }
  const scope = declaredScope(request.scope);
  const selection = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
  const observations: WorkspaceLiveNotice[] = [];
  const committedSnapshots: SnapshotRef[] = plans.map((plan) => plan.kind === "read"
    ? { repo: plan.at.repoId, kind: "sha", sha: plan.at.revision }
    : { repo: plan.repoId, kind: "sha", sha: plan.sha });
  const actual = new Map<string, Extract<SnapshotRef, { kind: "live" }>>();
  const invoke = async (preparation: SnapshotPreparation): Promise<Result<{ value: T; snapshots: readonly SnapshotRef[] }, WorkspaceFault | F>> => {
    if (request.signal?.aborted) return ABORTED;
    const usingCaptures = async (liveCaptures: ReadonlyMap<string, HeldLive>): Promise<Result<{ value: T; snapshots: readonly SnapshotRef[] }, WorkspaceFault | F>> => {
      for (const plan of livePlans) {
        const held = liveCaptures.get(plan.repoId)!;
        const snapshot = { repo: plan.repoId, kind: "live" as const, head: held.head, stateId: held.tree.stateId };
        actual.set(plan.repoId, snapshot);
        if (plan.expected !== undefined && (plan.expected.head !== snapshot.head || plan.expected.stateId !== snapshot.stateId)) {
          return { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "workspace replay context does not match the current live capture" } };
        }
      }
      const snapshots = [...committedSnapshots, ...actual.values()].toSorted((a, b) => compareText(a.repo, b.repo));
      const result = await use({ plan: planned.value, plans, livePlans, scope, selection, preparation, liveCaptures, selectedSnapshots: snapshots, signal: request.signal });
      if (request.signal?.aborted) return ABORTED;
      return result.ok ? { ok: true, value: { value: result.value, snapshots } } : result;
    };
    if (livePlans.length === 0) return usingCaptures(new Map());
    if (deps.graph === undefined || deps.live === undefined) return { ok: false, fault: { kind: "workspace-capture-unavailable", repo: livePlans[0]!.repoId, detail: "live capture unavailable", cause: { kind: "live-mirror-failed", detail: "live capture dependencies unavailable" } } };
    const captured = await withLiveCaptures({ ...deps, graph: deps.graph, live: deps.live }, livePlans.map((plan) => ({
      repo: plan.canonical, repoId: plan.repoId, head: plan.head, scope: plan.scope, trust: plan.trust,
      onStale: (notice) => { const snapshot = actual.get(plan.repoId); if (snapshot !== undefined) observations.push({ kind: "stale", repo: plan.repoId, snapshot, notice }); },
      onStalenessUnavailable: (notice) => {
        const snapshot = actual.get(plan.repoId);
        if (snapshot === undefined) return;
        const cause = notice.stage === "listing" ? notice.cause : { kind: "live-mirror-failed" as const, detail: `${notice.cause.kind}: ${notice.cause.detail}` };
        observations.push({ kind: "staleness-unavailable", repo: plan.repoId, snapshot, cause });
      },
    })), request.signal, usingCaptures);
    if (request.signal?.aborted || (!captured.ok && captured.fault.cause.kind === "aborted")) return ABORTED;
    if (!captured.ok) return { ok: false, fault: { kind: "workspace-capture-unavailable", detail: "live capture unavailable", repo: captured.fault.repoId, cause: captured.fault.cause } };
    return captured.value;
  };
  const result = await (deps.preparation === undefined ? withSnapshotPreparation(deps, invoke) : invoke(deps.preparation));
  if (request.signal?.aborted) return ABORTED;
  if (!result.ok) return result;
  const workspaceReplay = planned.value.declaration === undefined ? undefined : { version: 1 as const, declaration: planned.value.declaration, snapshots: result.value.snapshots };
  observations.sort((a, b) => compareText(a.repo, b.repo));
  return { ok: true, value: { value: result.value.value, ...(workspaceReplay === undefined ? {} : { workspaceReplay }), ...(observations.length === 0 ? {} : { workspaceLive: observations }) } };
}
