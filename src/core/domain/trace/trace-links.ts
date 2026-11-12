import type { CallPlace } from "../topology/call-site.ts";
import type { TraceValue } from "./trace-fact.ts";

/**
 * Workspace matches retain their original basis; execution is established only by an exactly placed trace effect, or by
 * an exactly placed request whose destination the snapshot leaves undecided.
 */
export function traceLinks(value: TraceValue, repo: string, workspace: Required<Pick<TraceValue, "repositorySnapshots" | "links" | "unlinked">>): TraceValue {
  const places = new Set(value.steps.filter((step) => step.deferred !== true).flatMap((step) => [
    ...(step.effects ?? []).flatMap((effect) => {
      if (effect.kind === "data" || effect.column === undefined) return [];
      return [key({ repo, file: step.file, line: effect.line, column: effect.column }, effect.kind === "http" ? "http" : "event")];
    }),
    ...(step.unresolvedEffects ?? []).flatMap((request) => (request.column === undefined ? [] : [key({ repo, file: request.path, line: request.line, column: request.column }, request.transport)])),
  ]));
  const reached = (site: { from: CallPlace; transport: "http" | "event" }): boolean => site.from.column !== undefined && places.has(key(site.from, site.transport));
  return { ...value, repositorySnapshots: workspace.repositorySnapshots, links: workspace.links.filter(reached), unlinked: workspace.unlinked.filter(reached) };
}

function key(place: Pick<CallPlace, "repo" | "file" | "line" | "column">, transport: "http" | "event"): string {
  return JSON.stringify([place.repo, place.file, place.line, place.column, transport]);
}
