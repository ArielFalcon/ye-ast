import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { HttpRoute } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import { TRUST_MODES, type TrustMode } from "../shared/fact.ts";
import type { RepositoryEvidence } from "../shared/repository-evidence.ts";
import type { CallSite } from "../topology/call-site.ts";
import { callSiteEvidence, statedRequestsOf, unresolvedCallSite } from "../topology/call-site.ts";
import { prefixOf, servedBehindGateway, type GatewayDeclaration } from "../topology/link-match.ts";
import { sortEvidence, type NameCandidate, type OutwardKind, type OutwardName, type RepositoryOutwardName } from "../topology/outward-name.ts";
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
  unserved: readonly RepositoryOutwardName[];
  gateways: readonly GatewayDeclaration[];
  /** Every prefix the join routed to a repository, declared or inferred: the prefixes a membership question may still tie to a clone. */
  gatewaysInForce?: readonly GatewayDeclaration[];
  /** The repositories the persisted declaration already holds: an answered membership is not asked again. */
  confirmed?: readonly string[];
  /** What a refresh pinned per repository: the refs it consulted are the revisions a `revision` decision offers. */
  resolutions?: readonly RepositoryResolution[];
  /** The `origin` URL of a clone declared without a `remote`: the one remote a `remote` decision offers. */
  origins?: readonly DecisionOrigin[];
}

/** A clone's own remotes, read from its configuration: the options of one `remote` decision, never a recommendation. */
export interface DecisionOrigin {
  repo: string;
  /** Every remote the clone states that the declaration accepts, sorted by remote name. */
  remotes: readonly { url: string; remote: string }[];
}

const NAME_BASES = ["exact-name", "artifact", "remote"] as const;

export function decisionsOf(input: DecisionInput): DecisionSet {
  const confirmed = new Set([input.trigger, ...(input.confirmed ?? [])]);
  const decisions = [
    ...membershipsByName(input, confirmed),
    ...membershipsByClone(input, confirmed),
    ...unservedDecisions(input),
    ...libraryDecisions(input),
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
  evidence: readonly RepositoryEvidence[];
  /** The outward kinds the subject is written with, for a kind whose subject is an outward name. */
  outwardKinds?: readonly OutwardKind[];
  options: readonly DecisionOption[];
  allowsFreeText: boolean;
  required: boolean;
}

function decisionOf({ kind, scope, subject, evidence, outwardKinds, options, allowsFreeText, required }: Gap): Decision {
  return { id: decisionId(kind, subject, scope), kind, subject, evidence: sortEvidence(evidence), ...(outwardKinds === undefined ? {} : { outwardKinds }), options: options.toSorted(compareOption), allowsFreeText, required };
}

function compareOption(a: DecisionOption, b: DecisionOption): number {
  return compareText(a.value, b.value) || compareText(a.basis ?? "", b.basis ?? "");
}

/**
 * A candidate the join itself decided: a link or a delivered event stands as the join's fact, not as a comparison a user
 * confirms. Only a prefix a gateway in force routes to the candidate's clone turns it into a question: the decision ties
 * the prefix the caller wrote to the clone that serves it.
 */
function joinDecided(candidate: NameCandidate, inForce: readonly GatewayDeclaration[]): boolean {
  return (candidate.basis === "link" || candidate.basis === "event-destination") && !inForce.some((gateway) => gateway.prefix === candidate.name && gateway.repo === candidate.repo);
}

/**
 * One decision per outward name a clone the declaration does not hold yet serves: the clones, with the basis that names each one.
 * A name every candidate of which the join decided is no question; one an identity comparison also names keeps every option.
 */
function membershipsByName(input: DecisionInput, confirmed: ReadonlySet<string>): Decision[] {
  return groupsOf(
    input.candidates.filter((candidate) => !confirmed.has(candidate.repo)),
    (candidate) => candidate.name,
  ).filter(([, candidates]) => !candidates.every((candidate) => joinDecided(candidate, input.gatewaysInForce ?? []))).map(([name, candidates]) => {
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
 * What the join left unserved, read as it decided it: a name no repository serves is a gap, and one a link or a repository
 * id serves never reaches here. A prefix a declared gateway routes was answered by that gateway. Every other unserved name
 * is one `repository` decision, the only answer that adds a repository the workspace lacks; an unserved prefix that some
 * other repository's routes take once it is stripped is also one `gateway` decision, which can only name a member.
 */
function unservedDecisions(input: DecisionInput): Decision[] {
  const routed = new Set(input.gateways.map((gateway) => gateway.prefix));
  const asked = input.unserved.filter((name) => !(name.kind === "path-prefix" && routed.has(name.name)));
  return [...gatewayDecisions(input, asked), ...repositoryDecisions(asked)];
}

function gatewayDecisions(input: DecisionInput, asked: readonly RepositoryOutwardName[]): Decision[] {
  return groupsOf(
    asked.filter((name) => name.kind === "path-prefix"),
    (name) => name.name,
  ).flatMap(([prefix, written]) => {
    const options = gatewayOptions(input, prefix, written);
    return options.length === 0 ? [] : [decisionOf({ kind: "gateway", subject: prefix, evidence: written.flatMap((held) => held.evidence), options, allowsFreeText: false, required: false })];
  });
}

/**
 * One decision per unserved name: no fact states where a name no clone serves lives, so only free text answers it.
 */
function repositoryDecisions(unserved: readonly RepositoryOutwardName[]): Decision[] {
  return groupsOf(unserved, (name) => name.name).map(([name, names]) =>
    decisionOf({
      kind: "repository",
      subject: name,
      evidence: names.flatMap((held) => held.evidence),
      outwardKinds: [...new Set(names.map((occurrence) => occurrence.kind))].sort(compareText),
      options: [],
      allowsFreeText: true,
      required: false,
    }),
  );
}

/**
 * The repositories whose routes take a call under an unserved prefix once it is stripped, each with the route as evidence.
 * Two or more are what leaves the gap and none is recommended; the caller's own repository is never an option, as
 * `inferGateways` excludes it.
 */
function gatewayOptions(input: DecisionInput, prefix: string, written: readonly RepositoryOutwardName[]): DecisionOption[] {
  const callers = new Set(written.flatMap((name) => name.evidence.map((place) => place.repo)));
  const calls = input.repositories
    .filter((repository) => callers.has(repository.repo))
    .flatMap((repository) => repository.callSites.flatMap((site) => statedRequestsOf(site).filter((target) => prefixOf(target) === prefix).map((target) => ({ site, target }))));
  return input.repositories.flatMap((repository): DecisionOption[] => {
    const own = routesOf(repository);
    const matched = calls.flatMap(({ site, target }) => (site.repo === repository.repo ? [] : servedBehindGateway(target, own).map((route) => ({ path: route.handler.path, line: route.handler.line, repo: repository.repo }))));
    return matched.length === 0 ? [] : [{ value: repository.repo, evidence: sortEvidence(matched), recommended: false }];
  });
}

/**
 * One decision per library a cut names. A clone is a candidate to confirm only when a caller of the library states a
 * dependency that clone serves, with the places of both ends as evidence; no fact states which one holds the library a FQN
 * names, so none is recommended, and without such a clone free text alone answers it.
 */
function libraryDecisions(input: DecisionInput): Decision[] {
  const cuts = input.repositories.flatMap((repository) =>
    repository.callSites.flatMap((site) => {
      const library = libraryOf(site);
      return library === undefined ? [] : [{ library, site }];
    }),
  );
  return groupsOf(cuts, (cut) => cut.library).map(([library, naming]) =>
    decisionOf({ kind: "library", subject: library, evidence: naming.map(({ site }) => ({ ...callSiteEvidence(site), repo: site.repo })), options: dependencyClones(input, new Set(naming.map(({ site }) => site.repo))), allowsFreeText: true, required: false }),
  );
}

/** The clones a dependency of one of these repositories names, one option per clone and basis, with the evidence of every dependency that names it. */
function dependencyClones(input: DecisionInput, callers: ReadonlySet<string>): DecisionOption[] {
  const dependencies = new Map(input.repositories.filter(({ repo }) => callers.has(repo)).map((repository) => [repository.repo, new Set(repository.names.filter((name) => name.kind === "dependency").map((name) => name.name))]));
  const named = input.candidates.filter((candidate) => [...callers].some((caller) => dependencies.get(caller)?.has(candidate.name) === true && candidate.evidence.some((place) => place.repo === caller)));
  return groupsOf(named, (candidate) => `${candidate.repo}\0${candidate.basis}`).map(([, group]) => ({ value: group[0]!.repo, basis: group[0]!.basis, evidence: sortEvidence(group.flatMap((candidate) => candidate.evidence)), recommended: false }));
}

/** The library a cut names, when the target stays undecided through it. */
function libraryOf(site: CallSite): string | undefined {
  const { via } = unresolvedCallSite(site);
  return via === undefined || via === "" ? undefined : via;
}

/**
 * One decision per refreshed repository the query could not read at the trigger's line: the branch the query pinned is
 * recommended and every other ref the resolution consulted is an option, with free text for a name no listing stated
 * (RFC-0014). A repository pinned by an explicit revision, or one pinned at the trigger's own line, leaves no gap.
 */
function revisionDecisions(input: DecisionInput): Decision[] {
  return (input.resolutions ?? []).flatMap((resolution) => {
    if (resolution.step !== "default-branch" && resolution.step !== "revision-unavailable") return [];
    const diverged = resolution.consulted.some((ref) => ref.sha === undefined);
    if (resolution.step === "default-branch" && !diverged) return [];
    const options = resolution.consulted
      .filter((ref) => ref.sha !== undefined)
      .map(
        (ref): DecisionOption => ({
          value: ref.branch,
          ...(resolution.step === "default-branch" ? { basis: "default-branch" as const } : {}),
          evidence: [],
          recommended: ref.sha === resolution.sha,
        }),
      );
    return [decisionOf({ kind: "revision", subject: resolution.repo, evidence: [], options, allowsFreeText: true, required: false })];
  });
}

/**
 * One decision per repository declared without a `remote` that states at least one: every remote the declaration would
 * accept as an address is an option, with the place in its configuration that states it, and no source of truth is ever
 * preselected.
 */
function remoteDecisions(input: DecisionInput): Decision[] {
  return (input.origins ?? []).map(({ repo, remotes }) =>
    decisionOf({
      kind: "remote",
      subject: repo,
      evidence: [],
      options: remotes.map(({ url, remote }): DecisionOption => ({ value: url, basis: "origin", evidence: [{ path: ".git/config", line: 1, via: remote, repo }], recommended: false })),
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
