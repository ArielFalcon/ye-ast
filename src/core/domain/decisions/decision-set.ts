import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { HttpRoute } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import { TRUST_MODES, type Evidence, type TrustMode } from "../shared/fact.ts";
import type { CallSite, HttpTarget } from "../topology/call-site.ts";
import { callSiteEvidence } from "../topology/call-site.ts";
import { inferGateways, matchBehindGateway, prefixOf, type GatewayDeclaration, type RepositoryEntrypoints } from "../topology/link-match.ts";
import { sortEvidence, type NameCandidate, type OutwardName } from "../topology/outward-name.ts";
import { decisionId, type Decision, type DecisionKind, type DecisionOption, type DecisionSet } from "./decision.ts";

/** A repository as the decision rules read it: what it states, what it calls, what it serves and its trust record. */
export interface DecisionRepository {
  repo: string;
  names: readonly OutwardName[];
  callSites: readonly CallSite[];
  entrypoints: readonly Entrypoint[];
  /** The trust the host declared for this repository; absent when it declared none. */
  trust?: TrustMode;
}

/** The facts the decision rules read: the workspace, the candidates of its names and the gateways the caller declared. */
export interface DecisionInput {
  /** The repository the request is bound to. */
  trigger: string;
  repositories: readonly DecisionRepository[];
  candidates: readonly NameCandidate[];
  unserved: readonly OutwardName[];
  gateways: readonly GatewayDeclaration[];
}

const NAME_BASES = ["exact-name", "artifact", "remote"] as const;

export function decisionsOf(input: DecisionInput): DecisionSet {
  const decisions = [...membershipsByName(input), ...membershipsByClone(input), ...repositoryDecisions(input), ...gatewayDecisions(input), ...trustDecisions(input)];
  return { decisions: decisions.toSorted((a, b) => compareText(a.id, b.id)) };
}

interface Gap {
  kind: DecisionKind;
  /** The subject space, when a kind has two: `membership` asks about a name and about a clone. */
  scope?: string;
  subject: string;
  evidence: readonly Evidence[];
  options: readonly DecisionOption[];
  allowsFreeText: boolean;
  required: boolean;
}

function decisionOf({ kind, scope, subject, evidence, options, allowsFreeText, required }: Gap): Decision {
  return { id: decisionId(kind, subject, scope), kind, subject, evidence: sortEvidence(evidence), options: options.toSorted(compareOption), allowsFreeText, required };
}

function compareOption(a: DecisionOption, b: DecisionOption): number {
  return compareText(a.value, b.value) || compareText(a.basis ?? "", b.basis ?? "");
}

/** One decision per outward name some clone serves: the clones, with the basis that names each one. */
function membershipsByName(input: DecisionInput): Decision[] {
  return groupsOf(input.candidates, (candidate) => candidate.name).map(([name, candidates]) => {
    const recommended = strongestRepo(candidates);
    return decisionOf({
      kind: "membership",
      scope: "name",
      subject: name,
      evidence: candidates.flatMap((candidate) => candidate.evidence),
      options: candidates.map((candidate) => ({ value: candidate.repo, basis: candidate.basis, evidence: candidate.evidence, recommended: candidate.repo === recommended })),
      allowsFreeText: true,
      required: false,
    });
  });
}

/** The repository the unique strongest basis names; two candidates at one basis recommend none. */
function strongestRepo(candidates: readonly NameCandidate[]): string | undefined {
  const ranked = candidates.flatMap((candidate) => {
    const strength = NAME_BASES.findIndex((basis) => basis === candidate.basis);
    return strength === -1 ? [] : [{ repo: candidate.repo, strength }];
  });
  const best = Math.min(...ranked.map(({ strength }) => strength));
  const atBest = ranked.filter(({ strength }) => strength === best);
  return atBest.length === 1 ? atBest[0]?.repo : undefined;
}

/** A clone the request passed that states no name and that no name named: keeping it is the only answer that adds it. */
function membershipsByClone(input: DecisionInput): Decision[] {
  return input.repositories
    .filter((repository) => repository.repo !== input.trigger && repository.names.length === 0 && !input.candidates.some((candidate) => candidate.repo === repository.repo))
    .map((repository) =>
      decisionOf({
        kind: "membership",
        scope: "clone",
        subject: repository.repo,
        evidence: [],
        options: [{ value: repository.repo, evidence: [], recommended: false }],
        allowsFreeText: false,
        required: false,
      }),
    );
}

/** One decision per unserved name: no fact states where a name no clone serves lives, so only free text answers it. */
function repositoryDecisions(input: DecisionInput): Decision[] {
  return groupsOf(input.unserved, (name) => name.name).map(([name, names]) =>
    decisionOf({ kind: "repository", subject: name, evidence: names.flatMap((held) => held.evidence), options: [], allowsFreeText: true, required: false }),
  );
}

/**
 * One decision per prefix no repository id names and no gateway routes: the repositories whose routes match a call under
 * the prefix once it is stripped. Zero or two or more matches, by construction, so no option is recommended.
 */
function gatewayDecisions(input: DecisionInput): Decision[] {
  const routes = input.repositories.map((repository) => ({ repo: repository.repo, routes: routesOf(repository) }));
  const entrypoints: RepositoryEntrypoints[] = input.repositories.map(({ repo, entrypoints }) => ({ repo, entrypoints }));
  const served = new Set(inferGateways(input.repositories.flatMap((repository) => repository.callSites), entrypoints, input.gateways).map((gateway) => gateway.prefix));
  const named = new Set(input.repositories.map((repository) => repository.repo));
  const calls = input.repositories.flatMap((repository) =>
    repository.callSites.flatMap((site) => {
      const target = httpTargetOf(site);
      if (target === undefined) return [];
      const prefix = prefixOf(target);
      if (prefix === undefined || named.has(prefix) || served.has(prefix)) return [];
      return [{ prefix, site, target }];
    }),
  );
  return groupsOf(calls, (call) => call.prefix).map(([prefix, under]) => {
    const options = routes.flatMap(({ repo, routes: own }): DecisionOption[] => {
      const matched = under.flatMap(({ site, target }) => {
        if (site.repo === repo) return [];
        const match = matchBehindGateway(target, own);
        return match === undefined ? [] : [{ path: match.route.handler.path, line: match.route.handler.line }];
      });
      return matched.length === 0 ? [] : [{ value: repo, evidence: sortEvidence(matched), recommended: false }];
    });
    return decisionOf({ kind: "gateway", subject: prefix, evidence: under.map(({ site }) => callSiteEvidence(site)), options, allowsFreeText: false, required: false });
  });
}

/** One required decision per repository the host declared no trust for: both modes, neither recommended. */
function trustDecisions(input: DecisionInput): Decision[] {
  return input.repositories
    .filter((repository) => repository.trust === undefined)
    .map((repository) =>
      decisionOf({
        kind: "trust",
        subject: repository.repo,
        evidence: [],
        options: TRUST_MODES.map((mode) => ({ value: mode, evidence: [], recommended: false })),
        allowsFreeText: false,
        required: true,
      }),
    );
}

function groupsOf<T>(items: readonly T[], keyOf: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups];
}

function routesOf(repository: DecisionRepository): HttpRoute[] {
  return repository.entrypoints.filter((entrypoint): entrypoint is HttpRoute => entrypoint.kind === "http-route");
}

function httpTargetOf(site: CallSite): HttpTarget | undefined {
  return site.transport === "http" && site.target.status === "complete" && "path" in site.target.value ? site.target.value : undefined;
}
