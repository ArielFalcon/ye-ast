import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { HttpRoute } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import type { CallSite, HttpTarget } from "./call-site.ts";
import { linkIdentity, type Link, type LinkBasis } from "./link.ts";

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

/** A prefix two repositories could serve: a cut, never a pick. */
interface AmbiguousPrefix {
  prefix: string;
  repos: readonly string[];
}

export interface JoinResult {
  link?: Link;
  /** The call reached a service the workspace declares and matched none of its routes: the service's drift. */
  unmatched?: string;
  /** Two repositories matched the call at one rung of the ladder. */
  ambiguous?: AmbiguousPrefix;
}

interface Match {
  route: HttpRoute;
  basis: LinkBasis;
  confidence: number;
  profiles?: readonly string[];
}

const ANY_METHOD = "ANY";
const PARAMETER = "{}";
const PARAMETER_SEGMENT = /^(:[A-Za-z_][A-Za-z0-9_]*|\{[^/}]*\})$/;
const SUFFIX_CONFIDENCE = 0.5;
const PARITY_CONFIDENCE = 0.6;

/** A path as the segments the ladder compares: no query, no trailing slash, every parameter one placeholder. */
export function pathSegments(path: string): string[] {
  return (path.split("?")[0] ?? path)
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (PARAMETER_SEGMENT.test(segment) ? PARAMETER : segment));
}

/** Equal segments, a route parameter standing for the call's segment. */
function samePath(routePath: readonly string[], callPath: readonly string[]): boolean {
  return routePath.length === callPath.length && routePath.every((segment, index) => segment === PARAMETER || segment === callPath[index]);
}

function accepts(route: HttpRoute, method: HttpTarget["method"]): boolean {
  return route.method === ANY_METHOD || route.method === method;
}

/** A call placeholder standing for a route parameter is a parity, not a literal match. */
function equalPathConfidence(callPath: readonly string[]): number {
  return callPath.includes(PARAMETER) ? PARITY_CONFIDENCE : 1;
}

/** Whether the shorter path is the tail of the longer and every extra leading segment of the longer is a literal. */
function isSuffixMatch(routePath: readonly string[], callPath: readonly string[]): boolean {
  const [shorter, longer] = routePath.length <= callPath.length ? [routePath, callPath] : [callPath, routePath];
  if (shorter.length === 0 || !shorter.some((segment) => segment !== PARAMETER)) return false;
  const cut = longer.length - shorter.length;
  if (longer.slice(0, cut).includes(PARAMETER)) return false;
  return shorter.every((segment, index) => segment === PARAMETER || segment === longer[cut + index]);
}

/** The base-path keys a route's configuration declares, with the profile that declares each; no profile is picked. */
function basePathKeys(route: HttpRoute): { keys: readonly string[]; profile?: string }[] {
  if (route.basePath.status !== "complete") return [];
  const declared = route.basePath.value;
  const keysOf = (values: object): string[] => Object.values(values).filter((value): value is string => typeof value === "string" && value !== "");
  const held = [{ keys: keysOf(declared.default) }, ...Object.entries(declared.profiles).map(([profile, keys]) => ({ keys: keysOf(keys), profile }))];
  return held.filter((entry) => entry.keys.length > 0);
}

/** Of the routes that match, the one that names the most segments itself: a literal beats a parameter at the same place. */
function mostSpecific(routes: readonly HttpRoute[]): HttpRoute | undefined {
  const parameters = (route: HttpRoute): number => pathSegments(route.path).filter((segment) => segment === PARAMETER).length;
  return routes.toSorted((a, b) => parameters(a) - parameters(b))[0];
}

function exactMatch(target: HttpTarget, routes: readonly HttpRoute[]): Match | undefined {
  const callPath = pathSegments(target.path);
  const route = mostSpecific(routes.filter((candidate) => accepts(candidate, target.method) && samePath(pathSegments(candidate.path), callPath)));
  return route === undefined ? undefined : { route, basis: "exact", confidence: equalPathConfidence(callPath) };
}

function basePathMatch(target: HttpTarget, routes: readonly HttpRoute[]): Match | undefined {
  const callPath = pathSegments(target.path);
  const holding = routes
    .filter((route) => accepts(route, target.method))
    .map((route) => ({ route, via: basePathKeys(route).filter(({ keys }) => keys.some((key) => samePath([...pathSegments(key), ...pathSegments(route.path)], callPath))) }))
    .filter(({ via }) => via.length > 0);
  const route = mostSpecific(holding.map((entry) => entry.route));
  const via = holding.find((entry) => entry.route === route)?.via;
  if (route === undefined || via === undefined) return undefined;
  const profiles = via.flatMap(({ profile }) => (profile === undefined ? [] : [profile])).toSorted(compareText);
  const underDefault = via.some(({ profile }) => profile === undefined);
  return { route, basis: "base-path", confidence: equalPathConfidence(callPath), ...(underDefault ? {} : { profiles }) };
}

function suffixMatch(target: HttpTarget, routes: readonly HttpRoute[]): Match | undefined {
  const callPath = pathSegments(target.path);
  const route = mostSpecific(routes.filter((candidate) => accepts(candidate, target.method) && isSuffixMatch(pathSegments(candidate.path), callPath)));
  return route === undefined ? undefined : { route, basis: "suffix", confidence: SUFFIX_CONFIDENCE };
}

function httpRoutes(repository: RepositoryEntrypoints): HttpRoute[] {
  return repository.entrypoints.flatMap((entrypoint) => (entrypoint.kind === "http-route" ? [entrypoint] : []));
}

/** The first path segment of a call, which is the prefix a gateway routes. */
function prefixOf(target: HttpTarget): string | undefined {
  const [first] = pathSegments(target.path);
  return first === undefined || first === PARAMETER ? undefined : first;
}

function withoutPrefix(target: HttpTarget): HttpTarget {
  return { ...target, path: `/${pathSegments(target.path).slice(1).join("/")}` };
}

/** What the call matches once its gateway prefix is removed: equal paths and configured base paths, never a suffix. */
function matchBehindGateway(target: HttpTarget, routes: readonly HttpRoute[]): Match | undefined {
  const stripped = withoutPrefix(target);
  return exactMatch(stripped, routes) ?? basePathMatch(stripped, routes);
}

function linkTo(site: CallSite, repo: string, match: Match): Link {
  const link: Omit<Link, "id"> = {
    from: { repo: site.repo, file: site.file, line: site.line, symbol: site.symbol },
    to: { repo, kind: match.route.kind, name: match.route.name, handler: match.route.handler },
    transport: "http",
    basis: match.basis,
    confidence: match.confidence,
    ...(match.profiles === undefined ? {} : { profiles: match.profiles }),
  };
  return { ...link, id: linkIdentity(link) };
}

/** The one repository a rung of the ladder lands in; two repositories make it ambiguous, never a pick. */
function atRung(rung: (target: HttpTarget, routes: readonly HttpRoute[]) => Match | undefined, target: HttpTarget, repositories: readonly RepositoryEntrypoints[]): { repo: string; match: Match } | { ambiguous: readonly string[] } | undefined {
  const landed = repositories.flatMap((repository) => {
    const match = rung(target, httpRoutes(repository));
    return match === undefined ? [] : [{ repo: repository.repo, match }];
  });
  const [first, ...rest] = landed;
  if (first === undefined) return undefined;
  return rest.length === 0 ? first : { ambiguous: landed.map((candidate) => candidate.repo).sort(compareText) };
}

/**
 * The link a call site makes against the routes of the repositories given, by the ladder of RFC-0011: an equal path; a
 * gateway prefix, declared or inferred, removed from the call; the base path a route's configuration adds; a path that
 * ends with the route's. A prefix a gateway routes never falls to a lower rung: a call under it that matches nothing is
 * the service's drift.
 */
export function matchCallSite(site: CallSite, target: HttpTarget, repositories: readonly RepositoryEntrypoints[], gateways: readonly Gateway[]): JoinResult {
  const prefix = prefixOf(target);
  const settled = (landed: ReturnType<typeof atRung>, basis?: Gateway["basis"]): JoinResult | undefined => {
    if (landed === undefined) return undefined;
    if ("ambiguous" in landed) return { ambiguous: { prefix: prefix ?? target.path, repos: landed.ambiguous } };
    return { link: linkTo(site, landed.repo, basis === undefined ? landed.match : { ...landed.match, basis, confidence: landed.match.confidence }) };
  };
  const exact = settled(atRung(exactMatch, target, repositories));
  if (exact !== undefined) return exact;

  const gateway = gateways.find((candidate) => candidate.prefix === prefix);
  if (gateway !== undefined) {
    const served = repositories.filter((repository) => repository.repo === gateway.repo);
    return settled(atRung(matchBehindGateway, target, served), gateway.basis) ?? { unmatched: target.path };
  }
  const found = settled(atRung(basePathMatch, target, repositories)) ?? settled(atRung(suffixMatch, target, repositories));
  if (found !== undefined) return found;
  return prefix !== undefined && repositories.some((repository) => repository.repo === prefix) ? { unmatched: target.path } : {};
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
    const serving = repositories.filter((repository) => calling.some(({ target, from }) => from !== repository.repo && matchBehindGateway(target, httpRoutes(repository)) !== undefined));
    const [only, ...others] = serving;
    if (only !== undefined && others.length === 0) inferred.push({ prefix, repo: only.repo, basis: "route-overlap" });
  }
  return [...declared.map((gateway): Gateway => ({ ...gateway, basis: "gateway-prefix" })), ...inferred].sort((a, b) => compareText(a.prefix, b.prefix));
}
