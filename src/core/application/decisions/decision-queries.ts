import { decisionsOf, type DecisionInput, type DecisionRepository } from "../../domain/decisions/decision-set.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { CompleteFact, Fact, FactBase, PartialFact } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { OutwardName } from "../../domain/topology/outward-name.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import type { DecisionQueries, DecisionsRequest, DecisionValue } from "../../ports/decision-queries.port.ts";
import type { WorkspaceFault, WorkspaceRepository, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceQueries, WorkspaceValue } from "../../ports/workspace-queries.port.ts";

export interface DecisionQueriesDeps {
  workspace: WorkspaceQueries;
}

export function createDecisionQueries({ workspace }: DecisionQueriesDeps): DecisionQueries {
  return {
    async decisions(request: DecisionsRequest): Promise<Result<Fact<DecisionValue>, WorkspaceFault>> {
      const read = await workspace.outwardNames(request);
      if (!read.ok) return read;
      const fact = read.value;
      if (fact.status === "unknown") return { ok: false, fault: { kind: "git-failed", detail: "the workspace read answered nothing" } };

      const value = fact.value;
      const input: DecisionInput = {
        trigger: request.repo.id ?? directoryNameOf(request.repo.path),
        repositories: value.repositories.map((repository) => decisionRepositoryOf(repository, value)),
        candidates: value.candidates,
        unserved: value.unserved,
        gateways: request.gateways ?? [],
      };
      const decisions = decisionsOf(input).decisions;
      return { ok: true, value: decisionFact(fact, { decisions, repositories: value.repositorySnapshots }) };
    },
  };
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
