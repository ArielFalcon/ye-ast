import type { Link, UnlinkedCallSite } from "../topology/link.ts";
import { distinctPlaces, type CallPlace, type PropagatedPlace } from "../topology/call-site.ts";
import type { IssuingPlace, TraceLinked, TraceStep, TraceValue } from "./trace-fact.ts";

/**
 * Workspace matches retain their original basis; execution is established only by an exactly placed trace effect, or by
 * an exactly placed request whose destination the snapshot leaves undecided. A match reached only by effects that run
 * later, if at all, is marked `deferred`: those a function value makes, and those of a step that is deferred or has a
 * deferred ancestor. One an executed effect also reaches is not.
 *
 * A match the workspace sites at an outer caller (a propagated call site, ADR-0044 decision 7) records the bodies the
 * propagation passed through. It is also established by the effects of the innermost of those bodies the trace
 * expanded that has any, and carries their places as `issuedAt`. One body issuing requests of different destinations says nothing
 * about which of them a match is, so its effects establish none of them.
 */
export function traceLinks(value: TraceValue, repo: string, workspace: Required<Pick<TraceValue, "repositorySnapshots" | "links" | "unlinked">>): TraceValue {
  const executed = new Set<string>();
  const deferred = new Set<string>();
  const byId = new Map(value.steps.map((step) => [step.id, step]));
  const runsLater = (step: TraceStep): boolean => {
    for (let at: TraceStep | undefined = step; at !== undefined; at = at.parent === undefined ? undefined : byId.get(at.parent)) if (at.deferred === true) return true;
    return false;
  };
  const below = (step: TraceStep, ancestor: TraceStep): boolean => {
    for (let at = step.parent === undefined ? undefined : byId.get(step.parent); at !== undefined; at = at.parent === undefined ? undefined : byId.get(at.parent)) if (at === ancestor) return true;
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

  type Match = { from: CallPlace; transport: "http" | "event"; propagatedThrough?: readonly PropagatedPlace[] };
  type Issue = { place: IssuingPlace; later: boolean; destination: string };
  const bodyStep = (body: PropagatedPlace): TraceStep[] => {
    const inside = value.steps.filter((step) => step.file === body.file && step.line <= body.line && body.line <= (step.endLine ?? step.line));
    const narrowest = Math.min(...inside.map((step) => (step.endLine ?? step.line) - step.line));
    return inside.filter((step) => (step.endLine ?? step.line) - step.line === narrowest);
  };
  const issuesOf = (site: Match, destination: string): Issue[] => {
    if (site.from.repo !== repo) return [];
    let remaining = (site.propagatedThrough ?? []).filter(({ kind }) => kind === "body").flatMap(bodyStep);
    while (remaining.length > 0) {
      const innermost = remaining.filter((step) => !remaining.some((other) => below(other, step)));
      const issues = innermost.flatMap((step) => (step.effects ?? []).flatMap((effect): Issue[] =>
        effect.kind === "data" || effect.column === undefined || (effect.kind === "http" ? "http" : "event") !== site.transport ? [] :
          [{ place: { file: step.file, line: effect.line, column: effect.column }, later: runsLater(step) || effect.deferred === true, destination }]));
      if (issues.length > 0) return issues;
      remaining = remaining.filter((step) => !innermost.includes(step));
    }
    return [];
  };
  const linkIssues = new Map<Link, Issue[]>(workspace.links.map((link) => [link, issuesOf(link, JSON.stringify([link.to.repo, link.to.name]))]));
  const unlinkedIssues = new Map<UnlinkedCallSite, Issue[]>(workspace.unlinked.map((site) => [site, issuesOf(site, JSON.stringify([site.outcome, site.name]))]));
  const destinations = Map.groupBy([...linkIssues.values(), ...unlinkedIssues.values()].flat(), ({ place }) => key(place, "http"));
  const decided = (issue: Issue): boolean => new Set(destinations.get(key(issue.place, "http"))?.map(({ destination }) => destination)).size === 1;
  const keep = <T extends Match>(issues: ReadonlyMap<T, Issue[]>): TraceLinked<T>[] => [...issues].flatMap(([site, all]) => {
    const issued = all.filter(decided);
    const own = site.from.repo === repo && site.from.column !== undefined ? key(site.from, site.transport) : undefined;
    const now = (own !== undefined && executed.has(own)) || issued.some(({ later }) => !later);
    if (!now && !(own !== undefined && deferred.has(own)) && issued.length === 0) return [];
    const answer: TraceLinked<T> = now ? site : { ...site, deferred: true };
    const places = distinctPlaces(issued.map(({ place }) => place));
    return [places.length === 0 ? answer : { ...answer, issuedAt: places }];
  });
  return { ...value, repositorySnapshots: workspace.repositorySnapshots, links: keep(linkIssues), unlinked: keep(unlinkedIssues) };
}

function key(place: { file: string; line: number; column?: number }, transport: "http" | "event"): string {
  return JSON.stringify([place.file, place.line, place.column, transport]);
}
