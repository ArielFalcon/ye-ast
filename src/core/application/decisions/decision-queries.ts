import { decisionsOf, type DecisionInput, type DecisionOrigin, type DecisionRepository } from "../../domain/decisions/decision-set.ts";
import { declaredGateways } from "../topology/workspace-join.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { provenanceOf, type CompleteFact, type Fact, type FactBase, type PartialFact } from "../../domain/shared/fact.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { OutwardName } from "../../domain/topology/outward-name.ts";
import { compareUnresolvedCallSites } from "../../domain/topology/call-site.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import { isRemoteAddress, type WorkspaceRepositoryDeclaration } from "../../domain/topology/workspace-manifest.ts";
import type { DecisionsRequest, DecisionValue } from "../../ports/decision-queries.port.ts";
import type { Vcs } from "../../ports/vcs.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceFault, WorkspaceRepository, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries, WorkspaceRead, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import { ABORTED } from "../snapshot/read-snapshot.ts";
import type { WorkspaceReadOperation } from "../topology/workspace-operation.ts";
import type { WorkspacePlanningRequest } from "../topology/workspace-plan.ts";
import { withAuthorizedRemotes, workspaceInForce } from "../topology/workspace-defaults.ts";

export interface DecisionQueriesDeps {
  workspace: WorkspaceQueries;
  /** The declaration the bound repository persists: it answers a membership already, and states which repositories name a remote. */
  defaults?: WorkspaceDefaults;
  /** Reads the remotes of a clone the declaration gives no `remote`, so that gap offers the clone's own `origin`. */
  vcs: Pick<Vcs, "remotes">;
  digest: Digest;
}

type CommittedDecisionsRequest = Omit<DecisionsRequest, "repo" | "repos"> & {
  repo: WorkspaceRepositoryDeclaration & { live?: never };
  repos?: readonly (WorkspaceRepositoryDeclaration & { live?: never })[];
};

/** Committed-only helper; composed live decisions use the captured operation below. */
export function createDecisionQueries({ workspace, defaults, vcs, digest }: DecisionQueriesDeps) {
  return {
    async decisions(request: CommittedDecisionsRequest): Promise<Result<FactRead<DecisionValue>, WorkspaceFault>> {
      if (request.signal?.aborted) return ABORTED;
      if ([request.repo, ...(request.repos ?? [])].some((repo) => "live" in repo)) return { ok: false, fault: { kind: "git-failed", detail: "invalid workspace selection" } };
      const read = await workspace.outwardNames(request);
      if (!read.ok) return read;
      return buildDecisions(read.value, request, { ...(defaults === undefined ? {} : { defaults }), vcs, digest }, request.signal);
    },
  };
}

export function createCapturedDecisionQueries({ operation, defaults, vcs, digest }: Omit<DecisionQueriesDeps, "workspace"> & { operation: WorkspaceReadOperation }) {
  return {
    async decisions(request: Omit<WorkspacePlanningRequest, "replay">): Promise<Result<FactRead<DecisionValue>, WorkspaceFault>> {
      const result = await operation.withRead(request, (read, context) => buildDecisions(read, request, { ...(defaults === undefined ? {} : { defaults }), vcs, digest }, context.signal));
      if (!result.ok) return result;
      return { ok: true, value: { ...result.value.value, ...(result.value.workspaceReplay === undefined ? {} : { workspaceReplay: result.value.workspaceReplay }), ...(result.value.workspaceLive === undefined ? {} : { workspaceLive: result.value.workspaceLive }) } };
    },
  };
}

async function buildDecisions(read: WorkspaceRead, request: Omit<WorkspacePlanningRequest, "replay">, { defaults, vcs, digest }: Omit<DecisionQueriesDeps, "workspace">, signal: AbortSignal | undefined): Promise<Result<FactRead<DecisionValue>, WorkspaceFault>> {
  if (signal?.aborted) return ABORTED;
  const fact = read.fact;
  if (fact.status === "unknown") return { ok: false, fault: { kind: "git-failed", detail: "the workspace read answered nothing" } };

  const persisted = await workspaceInForce({ repo: request.repo }, defaults, fact.inputs.trust);
  if (!persisted.ok) return persisted;
  const value = fact.value;
  const trigger = request.repo.id ?? directoryNameOf(request.repo.path);
  const inForce = withAuthorizedRemotes(request.repos ?? persisted.value.repos, persisted.value.repos);
  const origins = await originsOf(vcs, value.repositories, inForce, trigger, signal);
  if (!origins.ok) return origins;
  const input: DecisionInput = {
    trigger,
    repositories: value.repositories.map((repository) => decisionRepositoryOf(repository, value)),
    candidates: value.candidates,
    unserved: value.unserved,
    gateways: declaredGateways(value.workspace.gateways),
    confirmed: persisted.value.repos.map((declaration) => declaration.id ?? directoryNameOf(declaration.path)),
    ...(read.refresh === undefined ? {} : { resolutions: read.refresh.resolution }),
    ...(origins.value.length === 0 ? {} : { origins: origins.value }),
  };
  const decisions = decisionsOf(input).decisions;
  const declared = { confirmed: (input.confirmed ?? []).toSorted(compareText), origins: origins.value, resolutions: read.refresh?.resolution ?? [] };
  const base = compositeBase(baseOf(fact), [{ kind: "workspace", fact: provenanceOf(fact) }], declared, (text) => digest.of(text));
  const answer = decisionFact({ ...fact, ...base }, { decisions, repositories: value.repositorySnapshots, source: value.workspace.source, unresolved: unresolvedOf(value) });
  return { ok: true, value: { fact: answer, ...(read.refresh === undefined ? {} : { refresh: read.refresh }), ...(read.repositoryRoots === undefined ? {} : { repositoryRoots: read.repositoryRoots }) } };
}

/**
 * The own remotes of every repository in force the declaration gives no `remote`, one entry per repository: the workspace
 * read already read their remotes for the section's identity, and a remote the declaration would not accept as an
 * address is no option, while a repository that states none leaves no gap to ask.
 */
async function originsOf(
  vcs: Pick<Vcs, "remotes">,
  repositories: readonly WorkspaceRepository[],
  declarations: readonly WorkspaceRepositoryDeclaration[],
  trigger: string,
  signal: AbortSignal | undefined,
): Promise<Result<readonly DecisionOrigin[], WorkspaceFault>> {
  const byRepo = new Map(declarations.map((declaration) => [declaration.id ?? directoryNameOf(declaration.path), declaration]));
  const origins: DecisionOrigin[] = [];
  for (const repository of repositories) {
    if (repository.repo === trigger) continue;
    const declaration = byRepo.get(repository.repo);
    if (declaration === undefined || declaration.remote !== undefined) continue;
    if (signal?.aborted) return ABORTED;
    const remotes = await vcs.remotes(declaration.path, signal);
    if (signal?.aborted) return ABORTED;
    if (!remotes.ok) return { ok: false, fault: remotes.fault };
    if (remotes.value.length === 0) continue;
    const accepted = remotes.value.filter((remote) => isRemoteAddress(remote.url)).map((remote) => ({ url: remote.url, remote: remote.name }));
    origins.push({ repo: repository.repo, remotes: accepted.toSorted((a, b) => compareText(a.remote, b.remote)) });
  }
  return { ok: true, value: origins.toSorted((a, b) => compareText(a.repo, b.repo)) };
}

/** One repository as the decision rules read it: what its section states, what it calls, what it serves and its trust. */
function decisionRepositoryOf(repository: WorkspaceRepository, workspace: WorkspaceValue): DecisionRepository {
  const section = workspace.sections[repository.repo];
  return {
    repo: repository.repo,
    names: namesOf(section),
    callSites: repository.callSites,
    entrypoints: entrypointsOf(repository),
    ...(repository.declaredTrust === undefined ? {} : { trust: repository.declaredTrust }),
  };
}

/** The undecided call sites of every section the read produced, by repository then place. */
function unresolvedOf(workspace: WorkspaceValue): DecisionValue["unresolved"] {
  return Object.entries(workspace.sections)
    .toSorted(([a], [b]) => compareText(a, b))
    .flatMap(([repo, section]) => (section.status === "unknown" ? [] : section.value.unresolved.toSorted(compareUnresolvedCallSites).map((site) => ({ repo, ...site }))));
}

/** The names a section states; a section the read did not produce states none. */
function namesOf(section: Fact<WorkspaceSection> | undefined): readonly OutwardName[] {
  return section === undefined || section.status === "unknown" ? [] : section.value.names;
}

/** Only the entrypoints the extractors answered: a finding the snapshot could not decide serves no route. */
function entrypointsOf(repository: WorkspaceRepository): readonly Entrypoint[] {
  return repository.entrypoints.flatMap((finding) => (finding.status === "complete" ? [finding.value] : []));
}

/** The workspace read's base without its evidence: the set rests on the read, not on a place. */
function baseOf({ schema, snapshot, producer, inputs, scopeSelection }: FactBase): FactBase {
  return { schema, snapshot, producer, inputs, evidence: [], ...(scopeSelection === undefined ? {} : { scopeSelection }) };
}

/** The decision set as a fact of the read: a partial read keeps its cuts, a complete one stays complete. */
function decisionFact(read: CompleteFact<WorkspaceValue> | PartialFact<WorkspaceValue>, value: DecisionValue): Fact<DecisionValue> {
  const base = baseOf(read);
  return read.status === "partial" ? { ...base, status: "partial", value, cuts: read.cuts } : { ...base, status: "complete", value };
}
