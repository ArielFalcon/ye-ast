import type { Entrypoint, Listener } from "../entrypoints/entrypoint.ts";
import type { HttpMethod, HttpRoute } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import type { CallSiteReach } from "../shared/fact.ts";
import { callPlaceOf, type CallSite, type EventTarget, type HttpTarget } from "./call-site.ts";
import { consumption, delivers } from "./event-destination.ts";
import { linkIdentity, type Link, type LinkBasis } from "./link.ts";
import { callTemplate, CANNOT_MATCH, literalText, looseness, namesHost, prefixText, routeSegments, statedLength, unify, type CallTemplate, type TemplateSegment, type Unification } from "./path-template.ts";

/** A repository's entrypoints, as the join reads them. */
export interface RepositoryEntrypoints {
  repo: string;
  entrypoints: readonly Entrypoint[];
}

/** A gateway prefix a caller declares, and the repository it routes to. */
export interface GatewayDeclaration {
  prefix: string;
  repo: string;
}

/** A gateway prefix in force: declared by the caller, or inferred from the overlap of calls and routes. */
export interface Gateway extends GatewayDeclaration {
  basis: "gateway-prefix" | "route-overlap";
}

/** What two repositories, or two consumers of one destination, matched: a cut, never a pick. */
export interface AmbiguousMatch {
  /** The prefix or destination that matched. */
  key: string;
  repos: readonly string[];
  /** The names of the routes that took the call equally, sorted; absent for a destination. */
  routes?: readonly string[];
}

export interface JoinResult {
  /** One link for an HTTP call; one per consuming listener for a published message, which every subscriber receives. */
  links?: Link[];
  /** The path of an HTTP call that matched no route and names no host: drift of a service the workspace holds, or of one it does not declare. */
  unmatched?: string;
  /** Two repositories, or two routes of one, matched the call at one rung of the ladder. */
  ambiguous?: AmbiguousMatch;
  /** The path of an HTTP call some route could take, or the destination of a message some listener could consume, depending on a value filled at run time: neither a link nor drift. */
  undecided?: string;
  /** No route takes an HTTP call that names a host, or no listener consumes a message: the call leaves the workspace. */
  external?: true;
  /** Only the call's own repository serves it: no link across repositories. */
  internal?: true;
}

export interface Match {
  route: HttpRoute;
  basis: LinkBasis;
  confidence: number;
  profiles?: readonly string[];
}

const ANY_METHOD = "ANY";
const SUFFIX_CONFIDENCE = 0.5;
const PARITY_CONFIDENCE = 0.6;

type Matched = Extract<Unification, { outcome: "matches" }>;

/** A route a rung took, with how the call unified with it and, for a base path, the profiles under which it holds. */
interface Taken {
  route: HttpRoute;
  unified: Matched;
  profiles?: readonly string[];
}

/** What one rung finds in one repository: the route it lands on, or the routes that take the call equally. */
type Landing = { match: Match } | { tie: readonly HttpRoute[] };

function accepts(route: HttpRoute, method: HttpTarget["method"]): boolean {
  return route.method === ANY_METHOD || route.method === method;
}

function matched(unified: Unification): Matched | undefined {
  return unified.outcome === "matches" ? unified : undefined;
}

/** The base-path keys a route's configuration declares, with the profile that declares each; no profile is picked. */
function basePathKeys(route: HttpRoute): { keys: readonly string[]; profile?: string }[] {
  if (route.basePath.status !== "complete") return [];
  const declared = route.basePath.value;
  const keysOf = (values: object): string[] => Object.values(values).filter((value): value is string => typeof value === "string" && value !== "");
  const held = [{ keys: keysOf(declared.default) }, ...Object.entries(declared.profiles).map(([profile, keys]) => ({ keys: keysOf(keys), profile }))];
  return held.filter((entry) => entry.keys.length > 0);
}

/**
 * Of the routes a rung took, the one that is most specific: fewer segments that take any text, then more text stated,
 * then a stated verb over none. Routes equal on every count take the call equally, so they are a tie, never a pick.
 */
function mostSpecific(taken: readonly Taken[], basis: LinkBasis): Landing | undefined {
  const rank = ({ route }: Taken): readonly number[] => {
    const segments = routeSegments(route.path);
    return [looseness(segments), -statedLength(segments), route.method === ANY_METHOD ? 1 : 0];
  };
  const order = (a: Taken, b: Taken): number => rank(a).reduce((difference, value, index) => difference || value - rank(b)[index]!, 0);
  const [first, ...rest] = taken.toSorted(order);
  if (first === undefined) return undefined;
  const tied = rest.filter((candidate) => order(candidate, first) === 0 && candidate.route !== first.route);
  return tied.length === 0 ? { match: matchOf(first, basis) } : { tie: [first.route, ...tied.map(({ route }) => route)] };
}

function matchOf({ route, unified, profiles }: Taken, basis: LinkBasis): Match {
  const confidence = basis === "suffix" ? SUFFIX_CONFIDENCE : unified.parity ? PARITY_CONFIDENCE : 1;
  return { route, basis, confidence, ...(profiles === undefined ? {} : { profiles }) };
}

/** What a rung finds in one repository: a landing, `could` when only routes the call could match depending on its run-time values take it, or nothing. */
type Rung = (call: CallTemplate, method: HttpTarget["method"], routes: readonly HttpRoute[]) => Landing | "could" | undefined;

/** The routes a rung's rule takes, and whether the call could match one more depending on its run-time values. */
interface Found {
  taken: readonly Taken[];
  could: boolean;
}

/** The landing of what a rung found, or `could` when it took no route and the call could match one. */
function landingOf({ taken, could }: Found, basis: LinkBasis): Landing | "could" | undefined {
  return mostSpecific(taken, basis) ?? (could ? "could" : undefined);
}

function foundOf(unified: readonly { route: HttpRoute; unified: Unification }[]): Found {
  return {
    taken: unified.flatMap(({ route, unified: found }) => (found.outcome === "matches" ? [{ route, unified: found }] : [])),
    could: unified.some(({ unified: found }) => found.outcome === "could-match"),
  };
}

function equalPaths(call: CallTemplate, method: HttpTarget["method"], routes: readonly HttpRoute[]): Found {
  return foundOf(routes.filter((route) => accepts(route, method)).map((route) => ({ route, unified: unify(call.segments, routeSegments(route.path)) })));
}

function underBasePaths(call: CallTemplate, method: HttpTarget["method"], routes: readonly HttpRoute[]): Found {
  let could = false;
  const taken = routes.flatMap((route): Taken[] => {
    if (!accepts(route, method)) return [];
    const via = basePathKeys(route).flatMap(({ keys, profile }) => {
      const tried = keys.map((key) => unify(call.segments, [...routeSegments(key), ...routeSegments(route.path)]));
      could ||= tried.some((found) => found.outcome === "could-match");
      const unified = tried.map(matched).find((found) => found !== undefined);
      return unified === undefined ? [] : [{ unified, profile }];
    });
    const [first] = via;
    if (first === undefined) return [];
    const underDefault = via.some(({ profile }) => profile === undefined);
    const profiles = via.flatMap(({ profile }) => (profile === undefined ? [] : [profile])).toSorted(compareText);
    return [{ route, unified: first.unified, ...(underDefault ? {} : { profiles }) }];
  });
  return { taken, could };
}

const exactRung: Rung = (call, method, routes) => landingOf(equalPaths(call, method, routes), "exact");

const basePathRung: Rung = (call, method, routes) => landingOf(underBasePaths(call, method, routes), "base-path");

/**
 * One path ends with the other: the extra leading segments of the longer state only text, and one segment both paths
 * state as text agrees. A call that states its origin states its whole path, so a longer route cannot end with it.
 */
function suffixUnify(call: CallTemplate, route: readonly TemplateSegment[]): Unification {
  const routeLonger = route.length > call.segments.length;
  if (routeLonger && call.origin !== undefined) return CANNOT_MATCH;
  const [shorter, longer] = routeLonger ? [call.segments, route] : [route, call.segments];
  const cut = longer.length - shorter.length;
  if (cut === 0 || shorter.length === 0 || !longer.slice(0, cut).every((segment) => literalText(segment) !== undefined)) return CANNOT_MATCH;
  const unified = routeLonger ? unify(call.segments, route.slice(cut)) : unify(call.segments.slice(cut), route);
  return unified.outcome === "matches" && unified.literals === 0 ? CANNOT_MATCH : unified;
}

const suffixRung: Rung = (call, method, routes) => landingOf(foundOf(routes.filter((route) => accepts(route, method)).map((route) => ({ route, unified: suffixUnify(call, routeSegments(route.path)) }))), "suffix");

/** What the call takes once its gateway prefix is removed: equal paths, then configured base paths, never a suffix, and only with a segment both state as text. */
const behindGatewayRung: Rung = (call, method, routes) => {
  const stripped = { ...call, segments: call.segments.slice(1) };
  const [exact, basePath] = [equalPaths(stripped, method, routes), underBasePaths(stripped, method, routes)];
  const evidenced = (found: Found): Found => ({ ...found, taken: found.taken.filter(({ unified }) => unified.literals > 0) });
  const landing = [landingOf(evidenced(exact), "exact"), landingOf(evidenced(basePath), "base-path")].find((found) => found !== undefined && found !== "could");
  return landing ?? (exact.could || basePath.could ? "could" : undefined);
};

function httpRoutes(repository: RepositoryEntrypoints): HttpRoute[] {
  return repository.entrypoints.flatMap((entrypoint) => (entrypoint.kind === "http-route" ? [entrypoint] : []));
}

/** The first path segment of a call, which is the prefix a gateway routes. */
export function prefixOf(target: HttpTarget): string | undefined {
  return prefixText(target.path);
}

/** The host a call names: the origin its URL states, or the service its client declares. */
export function hostOf(target: HttpTarget): string | undefined {
  return callTemplate({ path: target.path }).origin ?? target.base;
}

/** The routes a call takes once its gateway prefix is removed, by equal paths and configured base paths: one, or several equally. */
export function servedBehindGateway(target: HttpTarget, routes: readonly HttpRoute[]): readonly HttpRoute[] {
  const landing = behindGatewayRung(callTemplate({ path: target.path }), target.method, routes);
  return landing === undefined || landing === "could" ? [] : "tie" in landing ? landing.tie : [landing.match.route];
}

function linkTo(site: CallSite, repo: string, match: Match): Link {
  const link: Omit<Link, "id"> = {
    from: callPlaceOf(site),
    to: { repo, kind: match.route.kind, name: match.route.name, handler: match.route.handler },
    transport: "http",
    basis: match.basis,
    confidence: match.confidence,
    ...(match.profiles === undefined ? {} : { profiles: match.profiles }),
  };
  return { ...link, id: linkIdentity(link) };
}

type Landed = { repo: string; match: Match } | { ambiguous: readonly string[]; routes: readonly string[] };

/**
 * The one repository a rung of the ladder lands in, on one route; two repositories, or two routes taken equally, are
 * ambiguous, never a pick. `could` when no repository lands and one could, depending on the call's run-time values.
 */
function atRung(rung: Rung, call: CallTemplate, method: HttpTarget["method"], repositories: readonly RepositoryEntrypoints[]): Landed | "could" | undefined {
  const found = repositories.map((repository) => ({ repo: repository.repo, landing: rung(call, method, httpRoutes(repository)) }));
  const landed = found.flatMap(({ repo, landing }) => (landing === undefined || landing === "could" ? [] : [{ repo, landing }]));
  const [first, ...rest] = landed;
  if (first === undefined) return found.some(({ landing }) => landing === "could") ? "could" : undefined;
  if (rest.length === 0 && "match" in first.landing) return { repo: first.repo, match: first.landing.match };
  const routes = landed.flatMap(({ landing }) => ("match" in landing ? [landing.match.route.name] : landing.tie.map((route) => route.name)));
  return { ambiguous: landed.map((candidate) => candidate.repo).sort(compareText), routes: [...new Set(routes)].sort(compareText) };
}

/** The one route of one repository a declared operation lands on, or the repositories that serve it equally. */
export type DeclaredOperationMatch = { repo: string; route: HttpRoute } | { ambiguous: readonly string[] };

/**
 * The route that serves an operation a contract declares, by the rungs of the ladder that name a path exactly: an equal
 * path, then the base path a route's configuration adds. Two repositories serving it equally are ambiguous, never a pick.
 */
export function matchDeclaredOperation(target: HttpTarget, repositories: readonly RepositoryEntrypoints[]): DeclaredOperationMatch | undefined {
  const call = callTemplate(target);
  const exact = atRung(exactRung, call, target.method, repositories);
  const landed = exact === undefined || exact === "could" ? atRung(basePathRung, call, target.method, repositories) : exact;
  if (landed === undefined || landed === "could") return undefined;
  return "ambiguous" in landed ? { ambiguous: landed.ambiguous } : { repo: landed.repo, route: landed.match.route };
}

/**
 * The link a call site makes against the routes of the repositories given, by the ladder of RFC-0011: an equal path; a
 * gateway prefix, declared or inferred, removed from the call; the base path a route's configuration adds; a path that
 * ends with the route's. A prefix a gateway routes never falls to a lower rung: a call under it that matches nothing is
 * the service's drift.
 */
export function matchCallSite(site: CallSite, target: HttpTarget, repositories: readonly RepositoryEntrypoints[], gateways: readonly Gateway[]): JoinResult {
  return ladder(target, repositories, gateways, (repo, match) => ({ links: [linkTo(site, repo, match)] }));
}

/**
 * Whether the ladder could link a call with this target to one of the routes: a link, a tie or a `could` on any rung.
 * A call it finds no route for, or one that names another host, cannot reach them (ADR-0042 decision 4).
 */
export function mayLink(target: HttpTarget, repositories: readonly RepositoryEntrypoints[], gateways: readonly Gateway[]): boolean {
  const joined = ladder(target, repositories, gateways, () => ({ links: [] }));
  return joined.unmatched === undefined && joined.external !== true;
}

/**
 * The call sites the ladder cannot link to one operation, over that operation's routes and the gateways: a site whose
 * reach states no method or no template is never excluded.
 */
export function excludedFrom(operation: string, repositories: readonly RepositoryEntrypoints[], gateways: readonly Gateway[]): (site: CallSiteReach) => boolean {
  const routes = repositories.map((repository) => ({ ...repository, entrypoints: repository.entrypoints.filter((entrypoint) => entrypoint.kind === "http-route" && entrypoint.name === operation) }));
  return (site) => site.method !== undefined && site.template !== undefined && !mayLink({ method: site.method as HttpMethod, path: site.template }, routes, gateways);
}

function ladder(target: HttpTarget, repositories: readonly RepositoryEntrypoints[], gateways: readonly Gateway[], linked: (repo: string, match: Match) => JoinResult): JoinResult {
  const call = callTemplate(target);
  const prefix = prefixOf(target);
  let could = false;
  const settled = (landed: Landed | "could" | undefined, basis?: Gateway["basis"]): JoinResult | undefined => {
    if (landed === "could") could = true;
    if (landed === undefined || landed === "could") return undefined;
    if (could) return { undecided: target.path };
    if ("ambiguous" in landed) return { ambiguous: { key: prefix ?? target.path, repos: landed.ambiguous, routes: landed.routes } };
    return linked(landed.repo, basis === undefined ? landed.match : { ...landed.match, basis });
  };
  const missed = (): JoinResult => (could ? { undecided: target.path } : { unmatched: target.path });
  const exact = settled(atRung(exactRung, call, target.method, repositories));
  if (exact !== undefined) return exact;

  const gateway = gateways.find((candidate) => candidate.prefix === prefix);
  if (gateway !== undefined) {
    const served = repositories.filter((repository) => repository.repo === gateway.repo);
    return settled(atRung(behindGatewayRung, call, target.method, served), gateway.basis) ?? missed();
  }
  const found = settled(atRung(basePathRung, call, target.method, repositories)) ?? settled(atRung(suffixRung, call, target.method, repositories));
  if (found !== undefined) return found;
  const named = prefix !== undefined && repositories.some((repository) => repository.repo === prefix);
  return could || named || !namesHost(call) ? missed() : { external: true };
}

/**
 * The gateways in force: those the caller declared, and a prefix inferred to route to a repository when at least one call
 * under it, made from another repository, matches a route of that repository once the prefix is removed and no call under
 * it matches a route of another. A prefix two repositories serve is inferred for neither, and a declared prefix is kept
 * as declared. Only the first path segment is a prefix.
 */
export function inferGateways(calls: readonly CallSite[], repositories: readonly RepositoryEntrypoints[], declared: readonly GatewayDeclaration[]): Gateway[] {
  const byPrefix = new Map<string, { target: HttpTarget; from: string }[]>();
  for (const call of calls) {
    if (call.target.status !== "complete" || !("path" in call.target.value)) continue;
    const prefix = prefixOf(call.target.value);
    if (prefix !== undefined) byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), { target: call.target.value, from: call.repo }]);
  }
  const inferred: Gateway[] = [];
  for (const [prefix, calling] of byPrefix) {
    if (declared.some((gateway) => gateway.prefix === prefix)) continue;
    const serving = repositories.filter((repository) => calling.some(({ target, from }) => from !== repository.repo && servedBehindGateway(target, httpRoutes(repository)).length > 0));
    const [only, ...others] = serving;
    if (only !== undefined && others.length === 0) inferred.push({ prefix, repo: only.repo, basis: "route-overlap" });
  }
  return [...declared.map((gateway): Gateway => ({ ...gateway, basis: "gateway-prefix" })), ...inferred].sort((a, b) => compareText(a.prefix, b.prefix));
}

/** A destination that matches is exact, so its link is at full confidence (decision 9). */
const EVENT_CONFIDENCE = 1;

function listenersOf(repository: RepositoryEntrypoints): Listener[] {
  return repository.entrypoints.flatMap((entrypoint) => (entrypoint.kind === "listener" ? [entrypoint] : []));
}

function eventLinkTo(site: CallSite, repo: string, listener: Listener): Link {
  const link: Omit<Link, "id"> = {
    from: callPlaceOf(site),
    to: { repo, kind: listener.kind, name: listener.name, handler: listener.handler },
    transport: "event",
    basis: "event-destination",
    confidence: EVENT_CONFIDENCE,
  };
  return { ...link, id: linkIdentity(link) };
}

/**
 * The links a published message makes against the listeners of the repositories given: those its protocol delivers to
 * (another repository's, or for an in-process event its own), with the protocol the message declares and a destination
 * that takes it. Every consuming listener is one link, since pub/sub delivers a message to each subscriber; a listener
 * that could consume it, depending on a value filled at run time, makes the message `undecided` beside those links.
 */
export function matchEventCallSite(site: CallSite, target: EventTarget, repositories: readonly RepositoryEntrypoints[]): JoinResult {
  const candidates = repositories
    .filter((repository) => delivers(target.protocol, site.repo, repository.repo))
    .flatMap((repository) => listenersOf(repository).map((listener) => ({ repo: repository.repo, listener, outcome: consumption(target, listener) })));
  const reached = candidates.filter(({ outcome }) => outcome === "matches");
  const could = candidates.some(({ outcome }) => outcome === "could-match");
  if (reached.length === 0 && !could) return { external: true };
  return { ...(reached.length === 0 ? {} : { links: reached.map(({ repo, listener }) => eventLinkTo(site, repo, listener)) }), ...(could ? { undecided: target.destination } : {}) };
}
