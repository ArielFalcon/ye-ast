import { parseHttpRouteName } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import type { Link, UnlinkedCallSite } from "../topology/link.ts";
import { httpTargetOf, type CallPlace, type HttpTarget, type PlacedCallSite, type PlacedOrigin } from "../topology/call-site.ts";
import type { IssuingPlace, TraceLinked, TraceStep, TraceValue } from "./trace-fact.ts";

/**
 * Workspace matches retain their original basis; execution is established only by an exactly placed trace effect, or by
 * an exactly placed request whose destination the snapshot leaves undecided. A match reached only by effects that run
 * later, if at all, is marked `deferred`: those a function value makes, and those of a step that is deferred or has a
 * deferred ancestor. One an executed effect also reaches is not.
 *
 * A match the workspace sites at an outer caller (a propagated call site, ADR-0044 decision 7) is also established by
 * the effects that issue its request: those of a step that expanded a body the propagation passed through and that state
 * the request the site states. The match then carries those effect places as `issuedAt`.
 */
export function traceLinks(value: TraceValue, repo: string, workspace: Required<Pick<TraceValue, "repositorySnapshots" | "links" | "unlinked">>, placed: readonly PlacedCallSite[] = []): TraceValue {
  const executed = new Set<string>();
  const deferred = new Set<string>();
  const byId = new Map(value.steps.map((step) => [step.id, step]));
  const runsLater = (step: TraceStep): boolean => {
    for (let at: TraceStep | undefined = step; at !== undefined; at = at.parent === undefined ? undefined : byId.get(at.parent)) if (at.deferred === true) return true;
    return false;
  };
  for (const step of value.steps) {
    const later = runsLater(step);
    for (const effect of step.effects ?? []) {
      if (effect.kind === "data" || effect.column === undefined) continue;
      (later || effect.deferred === true ? deferred : executed).add(key({ file: step.file, line: effect.line, column: effect.column }, effect.kind === "http" ? "http" : "event"));
    }
    for (const request of step.unresolvedEffects ?? []) {
      if (request.column === undefined) continue;
      (later || request.deferred === true ? deferred : executed).add(key({ file: request.path, line: request.line, column: request.column }, request.transport));
    }
  }

  type Match = { from: CallPlace; transport: "http" | "event" };
  type Issue = { place: IssuingPlace; later: boolean; destination: string };
  const stepsOf = (body: PlacedOrigin): TraceStep[] => {
    const inside = value.steps.filter((step) => step.file === body.file && step.line <= body.line && body.line <= (step.endLine ?? step.line));
    const narrowest = Math.min(...inside.map((step) => (step.endLine ?? step.line) - step.line));
    return inside.filter((step) => (step.endLine ?? step.line) - step.line === narrowest);
  };
  const issuesOf = <T extends Match>(site: T, destination: string, pairs: (request: HttpTarget) => boolean): Issue[] => {
    const { column } = site.from;
    if (site.from.repo !== repo || site.transport !== "http" || column === undefined) return [];
    return placed.flatMap(({ site: at, column: placedColumn, origins, issuingBoundary }) => {
      const request = httpTargetOf(at);
      if (request === undefined || origins === undefined || issuingBoundary === "site" || placedColumn === undefined || placedColumn + 1 !== column || at.file !== site.from.file || at.line !== site.from.line || at.symbol !== site.from.symbol || !pairs(request)) return [];
      return origins.filter(({ kind }) => kind === "body").flatMap(stepsOf).flatMap((step) => (step.effects ?? []).flatMap((effect): Issue[] =>
        effect.kind !== "http" || effect.column === undefined || effect.target.method !== request.method || !sameRequestPath(effect.target.path, request.path) ? [] :
          [{ place: { file: step.file, line: effect.line, column: effect.column }, later: runsLater(step) || effect.deferred === true, destination }]));
    });
  };
  const linkIssues = new Map<Link, Issue[]>(workspace.links.map((link) => [link, issuesOf(link, JSON.stringify([link.to.repo, link.to.name]), (request) => routeServes(link.to.name, request))]));
  const unlinkedIssues = new Map<UnlinkedCallSite, Issue[]>(workspace.unlinked.map((site) => [site, issuesOf(site, JSON.stringify([site.outcome, site.name]), (request) => site.name === request.path)]));
  // An effect that supports matches of different destinations says nothing about which of them the trace runs.
  const destinations = Map.groupBy([...linkIssues.values(), ...unlinkedIssues.values()].flat(), ({ place }) => key(place, "http"));
  const decided = (issue: Issue): boolean => new Set(destinations.get(key(issue.place, "http"))?.map(({ destination }) => destination)).size === 1;
  const keep = <T extends Match>(issues: ReadonlyMap<T, Issue[]>): TraceLinked<T>[] => [...issues].flatMap(([site, all]) => {
    const issued = all.filter(decided);
    const own = site.from.repo === repo && site.from.column !== undefined ? key(site.from, site.transport) : undefined;
    const now = (own !== undefined && executed.has(own)) || issued.some(({ later }) => !later);
    if (!now && !(own !== undefined && deferred.has(own)) && issued.length === 0) return [];
    const answer: TraceLinked<T> = now ? site : { ...site, deferred: true };
    const places = [...new Map(issued.map(({ place }) => [key(place, "http"), place])).values()].sort((a, b) => compareText(a.file, b.file) || a.line - b.line || a.column - b.column);
    return [places.length === 0 ? answer : { ...answer, issuedAt: places }];
  });
  return { ...value, repositorySnapshots: workspace.repositorySnapshots, links: keep(linkIssues), unlinked: keep(unlinkedIssues) };
}

/** Whether a route name (`METHOD /path`) takes a request: its method, and its path as the end of the request's path, a `{}` segment standing for any. */
function routeServes(name: string, request: HttpTarget): boolean {
  const route = parseHttpRouteName(name);
  if (route === undefined || (route.method !== "ANY" && route.method !== request.method)) return false;
  const served = segmentsOf(route.path);
  const called = segmentsOf(request.path);
  return served.length > 0 && called.length >= served.length && served.every((segment, index) => {
    const other = called[called.length - served.length + index]!;
    return segment === other || segment === "{}" || other === "{}";
  });
}

/** Whether two request paths can be one request: the same segments, a `{}` segment standing for any. */
function sameRequestPath(a: string, b: string): boolean {
  const [left, right] = [segmentsOf(a), segmentsOf(b)];
  return left.length === right.length && left.every((segment, index) => segment === right[index] || segment === "{}" || right[index] === "{}");
}

function segmentsOf(path: string): string[] {
  const [withoutQuery = ""] = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split(/[?#]/);
  return withoutQuery.split("/").filter((segment) => segment !== "").map((segment) => (/^\{.*\}$/.test(segment) ? "{}" : segment));
}

function key(place: { file: string; line: number; column?: number }, transport: "http" | "event"): string {
  return JSON.stringify([place.file, place.line, place.column, transport]);
}
