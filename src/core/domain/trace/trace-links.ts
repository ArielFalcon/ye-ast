import type { CallPlace } from "../topology/call-site.ts";
import type { TraceStep, TraceValue } from "./trace-fact.ts";

/**
 * Workspace matches retain their original basis; execution is established only by an exactly placed trace effect, or by
 * an exactly placed request whose destination the snapshot leaves undecided. A match reached only by effects that run
 * later, if at all, is marked `deferred`: those a function value makes, and those of a step that is deferred or has a
 * deferred ancestor. One an executed effect also reaches is not.
 */
export function traceLinks(value: TraceValue, repo: string, workspace: Required<Pick<TraceValue, "repositorySnapshots" | "links" | "unlinked">>): TraceValue {
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
      (later || effect.deferred === true ? deferred : executed).add(key({ repo, file: step.file, line: effect.line, column: effect.column }, effect.kind === "http" ? "http" : "event"));
    }
    for (const request of step.unresolvedEffects ?? []) {
      if (request.column === undefined) continue;
      (later || request.deferred === true ? deferred : executed).add(key({ repo, file: request.path, line: request.line, column: request.column }, request.transport));
    }
  }
  const keyOf = (site: { from: CallPlace; transport: "http" | "event" }): string | undefined => (site.from.column === undefined ? undefined : key(site.from, site.transport));
  const reached = (site: { from: CallPlace; transport: "http" | "event" }): boolean => {
    const at = keyOf(site);
    return at !== undefined && (executed.has(at) || deferred.has(at));
  };
  const marked = <T extends { from: CallPlace; transport: "http" | "event" }>(site: T): T & { deferred?: true } => {
    const at = keyOf(site);
    return at !== undefined && deferred.has(at) && !executed.has(at) ? { ...site, deferred: true } : site;
  };
  return { ...value, repositorySnapshots: workspace.repositorySnapshots, links: workspace.links.filter(reached).map(marked), unlinked: workspace.unlinked.filter(reached).map(marked) };
}

function key(place: Pick<CallPlace, "repo" | "file" | "line" | "column">, transport: "http" | "event"): string {
  return JSON.stringify([place.repo, place.file, place.line, place.column, transport]);
}
