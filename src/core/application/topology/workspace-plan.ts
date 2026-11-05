import { isWorkspaceReplayContext } from "../../domain/topology/workspace-replay.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { SnapshotRef } from "../../domain/shared/fact.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import { resolveRemoteSnapshot, type RemoteFreshness, type RepositoryResolution } from "../../domain/topology/remote-snapshot.ts";
import type { RemoteRefresh } from "../../ports/remote-refresh.port.ts";
import { DEFAULT_REVISION, type VcsFault } from "../../ports/vcs.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { SnapshotChoice, WorkspaceFault, WorkspaceRepositoryRequest } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceRefresh, WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import { ABORTED, trustOf, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";
import { withAuthorizedRemotes, workspaceInForce, type WorkspaceInForce } from "./workspace-defaults.ts";

export type { SnapshotChoice };
export type WorkspacePlanningMember = WorkspaceRepositoryRequest;
export type WorkspacePlanningRequest = Omit<WorkspaceRequest, "repo" | "repos"> & { repo: WorkspacePlanningMember; repos?: readonly WorkspacePlanningMember[] };

type ReplaySnapshot = Extract<SnapshotRef, { kind: "sha" | "live" }>;
type LiveSnapshot = Extract<SnapshotRef, { kind: "live" }>;

interface WorkspacePlanDeps extends Pick<SnapshotReaderDeps, "vcs" | "trust" | "digest"> {
  defaults?: WorkspaceDefaults;
  refresh?: RemoteRefresh;
}

/** Where one repository's commit is read, and where its remotes and trust are declared. */
export interface ReadSource {
  /** The declared clone, or the mirror that holds the pinned sha. */
  readonly source: string;
  /** The repository the request named; remotes and trust never come from a mirror. */
  readonly declared: string;
  readonly repoId: string;
  readonly revision: string;
  /** The sha a refresh pinned, so a mirror that lacks it answers an unknown section instead of a fault. */
  readonly pinnedSha?: string;
}

/** What a refresh pinned for one repository: a mirror to read, or the sha no copy holds. */
type Pin = { kind: "read"; mirror: string; sha: string } | { kind: "unavailable"; sha: string };

/** How one repository of the request is read: its clone, a mirror, or no copy of the revision at all. */
export type CommittedPlan = { readonly kind: "read"; readonly at: ReadSource } | { readonly kind: "unavailable"; readonly repoId: string; readonly sha: string };
export type LivePlan = { readonly kind: "live"; readonly repoId: string; readonly declared: string; readonly expected?: LiveSnapshot };
export type Plan = CommittedPlan | LivePlan;

interface Refreshed {
  pins: ReadonlyMap<string, Pin>;
  refresh?: WorkspaceRefresh;
}

interface Candidate {
  declaration: WorkspaceRepositoryRequest;
  repoId: string;
  url: string;
  /** The declared clone, present only when its `origin` is the declared remote: the mirror may be seeded from it. */
  seed?: string;
}

const ORIGIN = "origin";

export interface WorkspacePlan {
  readonly asked: readonly Readonly<WorkspacePlanningMember>[];
  readonly ids: readonly string[];
  readonly membership: Readonly<WorkspaceInForce>;
  readonly declaration: string | undefined;
  readonly plans: readonly Plan[];
  readonly refresh: WorkspaceRefresh | undefined;
}

export async function planWorkspace(deps: WorkspacePlanDeps, request: WorkspacePlanningRequest, options?: { preflightLive(plans: readonly LivePlan[]): Promise<Result<void, WorkspaceFault>> }): Promise<Result<WorkspacePlan, WorkspaceFault>> {
  const { vcs } = deps;
  /**
   * Refreshes the declared remote of every trusted repository beside the trigger, once for all of them, and resolves the
   * sha each one is read at. The trigger is read locally and never refreshed; a repository that declares no remote, or
   * whose record is not `trusted`, never reaches the network.
   */
  async function refreshRemotes(repositories: readonly WorkspaceRepositoryRequest[], trigger: WorkspaceRepositoryRequest, offline: boolean, signal: AbortSignal | undefined, replay?: ReadonlyMap<string, ReplaySnapshot>): Promise<Result<Refreshed, WorkspaceFault>> {
    const local: Refreshed = { pins: new Map() };
    const { refresh } = deps;
    if (refresh === undefined || offline) return { ok: true, value: local };

    const candidates: Candidate[] = [];
    for (const declaration of repositories) {
      if (declaration.remote === undefined) continue;
      if (signal?.aborted) return ABORTED;
      const trust = await trustOf(deps, declaration.path);
      if (signal?.aborted) return ABORTED;
      if (trust !== "trusted") continue;
      const remotes = await vcs.remotes(declaration.path, signal);
      if (signal?.aborted) return ABORTED;
      if (!remotes.ok) return remotes;
      const origin = remotes.value.find((remote) => remote.name === ORIGIN && remote.url === declaration.remote);
      candidates.push({ declaration, repoId: declaration.id ?? directoryNameOf(declaration.path), url: declaration.remote, ...(origin === undefined ? {} : { seed: declaration.path }) });
    }
    if (candidates.length === 0) return { ok: true, value: local };

    const line = await triggerLine(trigger, signal);
    if (signal?.aborted) return ABORTED;
    if (!line.ok) return line;
    const answers = await refresh.refresh(candidates.map(({ url, seed }) => ({ url, ...(seed === undefined ? {} : { seed }) })), signal);
    if (signal?.aborted) return ABORTED;
    const byUrl = new Map(answers.map((answer) => [answer.url, answer]));
    const pins = new Map<string, Pin>();
    const resolution: RepositoryResolution[] = [];
    const freshness: { repo: string; url: string; freshness: RemoteFreshness }[] = [];
    for (const candidate of candidates) {
      const answer = byUrl.get(candidate.url);
      if (answer === undefined) return { ok: false, fault: { kind: "git-failed", detail: "the refresh answered nothing for a declared remote" } };
      const listing = answer.listing ?? { branches: [] };
      const observed = resolveRemoteSnapshot(candidate.repoId, candidate.declaration.revision, line.value, listing);
      const replayPin = replay?.get(candidate.repoId);
      const replaySha = replayPin?.kind === "sha" ? replayPin.sha : undefined;
      const pinned = replaySha === undefined ? observed : {
        ...resolveRemoteSnapshot(candidate.repoId, replaySha, line.value, listing),
        consulted: observed.consulted,
      };
      resolution.push(pinned);
      freshness.push({ repo: candidate.repoId, url: candidate.url, freshness: answer.freshness });
      if (replaySha !== undefined) {
        pins.set(candidate.repoId, answer.mirror === undefined ? { kind: "unavailable", sha: replaySha } : { kind: "read", mirror: answer.mirror, sha: replaySha });
        continue;
      }
      if (pinned.sha !== undefined && answer.mirror !== undefined) {
        pins.set(candidate.repoId, { kind: "read", mirror: answer.mirror, sha: pinned.sha });
        continue;
      }
      let snapshot = pinned.sha;
      if (snapshot === undefined) {
        const revision = await vcs.resolveCommit(candidate.declaration.path, candidate.declaration.revision ?? DEFAULT_REVISION, signal);
        if (signal?.aborted) return ABORTED;
        if (!revision.ok) return revision;
        snapshot = revision.value;
      }
      pins.set(candidate.repoId, { kind: "unavailable", sha: snapshot });
    }
    return {
      ok: true,
      value: {
        pins,
        refresh: {
          resolution: resolution.sort((a, b) => compareText(a.repo, b.repo)),
          freshness: freshness.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.url, b.url)),
        },
      },
    };
  }

  /** The line the trigger is on: the revision the request names, or the branch its `HEAD` points at when it names HEAD or none. */
  async function triggerLine(trigger: WorkspaceRepositoryRequest, signal: AbortSignal | undefined): Promise<Result<string | undefined, VcsFault>> {
    return trigger.revision === undefined || trigger.revision === DEFAULT_REVISION ? vcs.headBranch(trigger.path, signal) : { ok: true, value: trigger.revision };
  }

  function planOf(declaration: WorkspaceRepositoryRequest, repoId: string, pin: Pin | undefined): CommittedPlan {
    if (pin === undefined) return { kind: "read", at: { source: declaration.path, declared: declaration.path, repoId, revision: declaration.revision ?? DEFAULT_REVISION } };
    if (pin.kind === "unavailable") return { kind: "unavailable", repoId, sha: pin.sha };
    return { kind: "read", at: { source: pin.mirror, declared: declaration.path, repoId, revision: pin.sha, pinnedSha: pin.sha } };
  }

  if (!validMember(request.repo) || (request.repos !== undefined && (!Array.isArray(request.repos) || !request.repos.every(validMember)))) {
    return { ok: false, fault: { kind: "git-failed", detail: "invalid workspace selection" } };
  }
  if (request.signal?.aborted) return ABORTED;
  const trust = await trustOf(deps, request.repo.path);
  if (request.signal?.aborted) return ABORTED;
  const inForce = await workspaceInForce(request, deps.defaults, trust);
  if (request.signal?.aborted) return ABORTED;
  if (!inForce.ok) return request.replay === undefined ? inForce : { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "workspace replay context does not match the current declaration" } };
  const asked: WorkspacePlanningMember[] = [request.repo, ...inForce.value.repos as WorkspacePlanningMember[]];
  if (!asked.every(validMember)) return { ok: false, fault: { kind: "git-failed", detail: "invalid workspace selection" } };
  const ids = asked.map((repository) => repository.id ?? directoryNameOf(repository.path));
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) return { ok: false, fault: { kind: "duplicate-repository", detail: duplicate } };

  const authority = inForce.value.source === "request"
    ? await workspaceInForce({ repo: request.repo }, deps.defaults, trust)
    : inForce;
  if (request.signal?.aborted) return ABORTED;
  if (!authority.ok && request.replay !== undefined) return { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "workspace replay context does not match the current declaration" } };
  if (!authority.ok && deps.refresh !== undefined && request.offline !== true) return authority;
  const refreshable = withAuthorizedRemotes(asked.slice(1), authority.ok ? authority.value.repos : []) as WorkspacePlanningMember[];
  const declaration = authority.ok ? `ws-r1:${deps.digest.of(canonicalJson({
    source: inForce.value.source,
    trigger: ids[0],
    ...(request.repo.live === true ? { triggerLive: true } : {}),
    members: refreshable.map((repository) => ({
      repo: repository.id ?? directoryNameOf(repository.path),
      ...(repository.live === true ? { live: true } : { revision: repository.revision ?? DEFAULT_REVISION }),
      remote: repository.remote ?? null,
    })).toSorted((a, b) => compareText(a.repo, b.repo)),
    gateways: [...inForce.value.gateways].toSorted((a, b) => compareText(a.prefix, b.prefix) || compareText(a.repo, b.repo)),
  }))}` : undefined;
  const replay = request.replay === undefined ? undefined : replayPins(request.replay, declaration, ids, asked);
  if (request.replay !== undefined && replay === undefined) return { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "workspace replay context does not match the current declaration" } };
  const livePlans: LivePlan[] = asked.flatMap((member, index) => {
    if (member.live !== true) return [];
    const repoId = ids[index]!;
    const expected = replay?.get(repoId);
    return [{ kind: "live", repoId, declared: member.path, ...(expected?.kind === "live" ? { expected } : {}) }];
  });
  if (request.signal?.aborted) return ABORTED;
  if (options !== undefined) {
    const checked = await options.preflightLive(livePlans);
    if (request.signal?.aborted) return ABORTED;
    if (!checked.ok) return checked;
  }
  const refreshed = await refreshRemotes(refreshable.filter((member) => member.live !== true), request.repo, request.offline === true, request.signal, replay);
  if (request.signal?.aborted) return ABORTED;
  if (!refreshed.ok) return refreshed;

  const plans = asked.map((member, index) => {
    const repoId = ids[index]!;
    const expected = replay?.get(repoId);
    if (member.live === true) return { kind: "live" as const, repoId, declared: member.path, ...(expected?.kind === "live" ? { expected } : {}) };
    const selected = expected?.kind === "sha" ? { ...member, revision: expected.sha } : member;
    return planOf(selected, repoId, index === 0 ? undefined : refreshed.value.pins.get(repoId));
  });
  return { ok: true, value: { asked, ids, membership: inForce.value, declaration, plans, refresh: refreshed.value.refresh } };
}

function validMember(value: unknown): value is WorkspacePlanningMember {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const member = value as Record<string, unknown>;
  const nonempty = (item: unknown) => typeof item === "string" && item.trim().length > 0;
  if (!nonempty(member.path)) return false;
  for (const key of ["id", "remote", "revision"]) if (member[key] !== undefined && !nonempty(member[key])) return false;
  if ("live" in member && (member.live !== true || "revision" in member)) return false;
  return true;
}

function replayPins(value: unknown, declaration: string | undefined, ids: readonly string[], asked: readonly WorkspacePlanningMember[]): Map<string, ReplaySnapshot> | undefined {
  if (!isWorkspaceReplayContext(value) || value.declaration !== declaration || value.snapshots.length !== ids.length) return undefined;
  const expected = new Map(ids.map((id, index) => [id, asked[index]!.live === true ? "live" : "sha"]));
  const pins = new Map<string, ReplaySnapshot>();
  for (const snapshot of value.snapshots) {
    if ((snapshot.kind !== "sha" && snapshot.kind !== "live") || expected.get(snapshot.repo) !== snapshot.kind) return undefined;
    pins.set(snapshot.repo, snapshot);
  }
  return pins;
}
