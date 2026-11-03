import { decisionsOf, type DecisionInput, type DecisionOrigin, type DecisionRepository } from "../../domain/decisions/decision-set.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { CompleteFact, Fact, FactBase, PartialFact } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { OutwardName } from "../../domain/topology/outward-name.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import type { WorkspaceRepositoryDeclaration } from "../../domain/topology/workspace-manifest.ts";
import type { DecisionQueries, DecisionsRequest, DecisionValue } from "../../ports/decision-queries.port.ts";
import type { FixedLayerFault } from "../../ports/fixed-layer-store.port.ts";
import type { Vcs } from "../../ports/vcs.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceFault, WorkspaceRepository, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries, WorkspaceValue } from "../../ports/workspace-queries.port.ts";

export interface DecisionQueriesDeps {
  workspace: WorkspaceQueries;
  /** The declaration the bound repository persists: it answers a membership already, and states which repositories name a remote. */
  defaults?: WorkspaceDefaults;
  /** Reads the remotes of a clone the declaration gives no `remote`, so that gap offers the clone's own `origin`. */
  vcs: Pick<Vcs, "remotes">;
}

export function createDecisionQueries({ workspace, defaults, vcs }: DecisionQueriesDeps): DecisionQueries {
  return {
    async decisions(request: DecisionsRequest): Promise<Result<FactRead<DecisionValue>, WorkspaceFault>> {
      const read = await workspace.outwardNames(request);
      if (!read.ok) return read;
      const fact = read.value.fact;
      if (fact.status === "unknown") return { ok: false, fault: { kind: "git-failed", detail: "the workspace read answered nothing" } };

      const persisted = await declaredOf(defaults, request.repo.path);
      if (!persisted.ok) return persisted;
      const value = fact.value;
      const trigger = request.repo.id ?? directoryNameOf(request.repo.path);
      const inForce = request.repos ?? persisted.value;
      const origins = await originsOf(vcs, value.repositories, inForce, trigger);
      if (!origins.ok) return origins;
      const input: DecisionInput = {
        trigger,
        repositories: value.repositories.map((repository) => decisionRepositoryOf(repository, value)),
        candidates: value.candidates,
        unserved: value.unserved,
        gateways: value.workspace.gateways,
        confirmed: persisted.value.map((declaration) => declaration.id ?? directoryNameOf(declaration.path)),
        ...(read.value.refresh === undefined ? {} : { resolutions: read.value.refresh.resolution }),
        ...(origins.value.length === 0 ? {} : { origins: origins.value }),
      };
      const decisions = decisionsOf(input).decisions;
      const answer = decisionFact(fact, { decisions, repositories: value.repositorySnapshots, source: value.workspace.source });
      return { ok: true, value: read.value.refresh === undefined ? { fact: answer } : { fact: answer, refresh: read.value.refresh } };
    },
  };
}

/** The repositories the bound repository's declaration holds: a clone it names was already answered as a member. */
async function declaredOf(defaults: WorkspaceDefaults | undefined, root: string): Promise<Result<readonly WorkspaceRepositoryDeclaration[], FixedLayerFault>> {
  if (defaults === undefined) return { ok: true, value: [] };
  const persisted = await defaults.of(root);
  if (!persisted.ok) return persisted;
  return { ok: true, value: persisted.value?.repos ?? [] };
}

/**
 * The `origin` URL of every repository in force the declaration gives no `remote`: the workspace read already read its
 * remotes for the section's identity, and a clone that states none offers no option.
 */
async function originsOf(
  vcs: Pick<Vcs, "remotes">,
  repositories: readonly WorkspaceRepository[],
  declarations: readonly WorkspaceRepositoryDeclaration[],
  trigger: string,
): Promise<Result<readonly DecisionOrigin[], WorkspaceFault>> {
  const byRepo = new Map(declarations.map((declaration) => [declaration.id ?? directoryNameOf(declaration.path), declaration]));
  const origins: DecisionOrigin[] = [];
  for (const repository of repositories) {
    if (repository.repo === trigger) continue;
    const declaration = byRepo.get(repository.repo);
    if (declaration === undefined || declaration.remote !== undefined) continue;
    const remotes = await vcs.remotes(repository.path);
    if (!remotes.ok) return { ok: false, fault: remotes.fault };
    const origin = remotes.value.find((remote) => remote.name === "origin");
    if (origin !== undefined) origins.push({ repo: repository.repo, url: origin.url });
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

/** The names a section states; a section the read did not produce states none. */
function namesOf(section: Fact<WorkspaceSection> | undefined): readonly OutwardName[] {
  return section === undefined || section.status === "unknown" ? [] : section.value.names;
}

/** Only the entrypoints the extractors answered: a finding the snapshot could not decide serves no route. */
function entrypointsOf(repository: WorkspaceRepository): readonly Entrypoint[] {
  return repository.entrypoints.flatMap((finding) => (finding.status === "complete" ? [finding.value] : []));
}

/** The workspace read's base without its evidence: the set rests on the read, not on a place. */
function baseOf({ schema, snapshot, producer, inputs }: FactBase): FactBase {
  return { schema, snapshot, producer, inputs, evidence: [] };
}

/** The decision set as a fact of the read: a partial read keeps its cuts, a complete one stays complete. */
function decisionFact(read: CompleteFact<WorkspaceValue> | PartialFact<WorkspaceValue>, value: DecisionValue): Fact<DecisionValue> {
  const base = baseOf(read);
  return read.status === "partial" ? { ...base, status: "partial", value, cuts: read.cuts } : { ...base, status: "complete", value };
}
