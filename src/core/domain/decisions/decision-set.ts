import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { HttpRoute } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import { TRUST_MODES, type Evidence, type TrustMode } from "../shared/fact.ts";
import type { CallSite, HttpTarget } from "../topology/call-site.ts";
import { callSiteEvidence, unresolvedPlace } from "../topology/call-site.ts";
import { inferGateways, matchBehindGateway, prefixOf, type GatewayDeclaration, type RepositoryEntrypoints } from "../topology/link-match.ts";
import { sortEvidence, type NameCandidate, type OutwardName } from "../topology/outward-name.ts";
import type { RepositoryResolution } from "../topology/remote-snapshot.ts";
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
  /** The repositories the persisted declaration already holds: an answered membership is not asked again. */
  confirmed?: readonly string[];
  /** What a refresh pinned per repository: the refs it consulted are the revisions a `revision` decision offers. */
  resolutions?: readonly RepositoryResolution[];
  /** The `origin` URL of a clone declared without a `remote`: the one remote a `remote` decision offers. */
  origins?: readonly DecisionOrigin[];
}

/** A clone's own `origin` URL, read from its configuration: an option of a `remote` decision, never a recommendation. */
export interface DecisionOrigin {
  repo: string;
  url: string;
}

const NAME_BASES = ["exact-name", "artifact", "remote"] as const;

export function decisionsOf(input: DecisionInput): DecisionSet {
  const confirmed = new Set([input.trigger, ...(input.confirmed ?? [])]);
  const decisions = [
    ...membershipsByName(input, confirmed),
    ...membershipsByClone(input, confirmed),
    ...repositoryDecisions(input),
    ...libraryDecisions(input),
    ...gatewayDecisions(input),
    ...revisionDecisions(input),
    ...remoteDecisions(input),
    ...trustDecisions(input),
  ];
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

/** One decision per outward name a clone the declaration does not hold yet serves: the clones, with the basis that names each one. */
function membershipsByName(input: DecisionInput, confirmed: ReadonlySet<string>): Decision[] {
  return groupsOf(
    input.candidates.filter((candidate) => !confirmed.has(candidate.repo)),
    (candidate) => candidate.name,
  ).map(([name, candidates]) => {
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

/** A clone the declaration does not hold yet that states no name and that no name named: keeping it is the only answer that adds it. */
function membershipsByClone(input: DecisionInput, confirmed: ReadonlySet<string>): Decision[] {
  return input.repositories
    .filter((repository) => !confirmed.has(repository.repo) && repository.names.length === 0 && !input.candidates.some((candidate) => candidate.repo === repository.repo))
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

/**
 * One decision per unserved name: no fact states where a name no clone serves lives, so only free text answers it. A
 * prefix a declared gateway routes was answered by that gateway, so it is no repository decision.
 */
function repositoryDecisions(input: DecisionInput): Decision[] {
  const routed = new Set(input.gateways.map((gateway) => gateway.prefix));
  return groupsOf(input.unserved, (name) => name.name)
    .filter(([name, names]) => !(routed.has(name) && names.every((occurrence) => occurrence.kind === "path-prefix")))
    .map(([name, names]) => decisionOf({ kind: "repository", subject: name, evidence: names.flatMap((held) => held.evidence), options: [], allowsFreeText: true, required: false }));
}

/**
 * One decision per library a cut names: every clone given is a candidate to confirm, and no fact states which one holds
 * the library a FQN names, so none is recommended.
 */
function libraryDecisions(input: DecisionInput): Decision[] {
  const cuts = input.repositories.flatMap((repository) =>
    repository.callSites.flatMap((site) => {
      const library = libraryOf(site);
      return library === undefined ? [] : [{ library, site }];
    }),
  );
  const options = input.repositories.map(({ repo }): DecisionOption => ({ value: repo, evidence: [], recommended: false }));
  return groupsOf(cuts, (cut) => cut.library).map(([library, naming]) =>
    decisionOf({ kind: "library", subject: library, evidence: naming.map(({ site }) => callSiteEvidence(site)), options, allowsFreeText: true, required: false }),
  );
}

/** The library a cut names, when the target stays undecided through it. */
function libraryOf(site: CallSite): string | undefined {
  const { via } = unresolvedPlace(site);
  return via === undefined || via === "" ? undefined : via;
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

/**
 * One decision per refreshed repository the query could not read at the trigger's line: the branch the query pinned is
 * recommended and every other ref the resolution consulted is an option, with free text for a name no listing stated
 * (RFC-0014). A repository pinned by an explicit revision, or one pinned at the trigger's own line, leaves no gap.
 */
function revisionDecisions(input: DecisionInput): Decision[] {
  return (input.resolutions ?? []).flatMap((resolution) => {
    if (resolution.step !== "default-branch" && resolution.step !== "revision-unavailable") return [];
    if (resolution.step === "default-branch" && resolution.consulted.length < 2) return [];
    const options = resolution.consulted.flatMap((ref): DecisionOption[] =>
      ref.sha === undefined
        ? []
        : [{ value: ref.branch, ...(resolution.step === "default-branch" ? { basis: "default-branch" as const } : {}), evidence: [], recommended: resolution.sha !== undefined && ref.sha === resolution.sha }],
    );
    return [decisionOf({ kind: "revision", subject: resolution.repo, evidence: [], options, allowsFreeText: true, required: false })];
  });
}

/** One decision per repository declared without a `remote`: its clone's `origin` URL is the option, and no source of truth is ever preselected. */
function remoteDecisions(input: DecisionInput): Decision[] {
  return (input.origins ?? []).map(({ repo, url }) =>
    decisionOf({
      kind: "remote",
      subject: repo,
      evidence: [],
      options: [{ value: url, basis: "origin", evidence: [{ path: ".git/config", line: 1, via: "origin" }], recommended: false }],
      allowsFreeText: true,
      required: false,
    }),
  );
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
