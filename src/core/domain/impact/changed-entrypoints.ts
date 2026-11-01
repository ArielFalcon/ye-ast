import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";

export interface ChangedEntrypoint {
  change: "added" | "removed" | "altered";
  kind: Entrypoint["kind"];
  name: string;
  handler: Handler;
}

/** The method or class that serves an entrypoint; none for a route whose component the sources do not name. */
export function handlerOf(entrypoint: Entrypoint): Handler | undefined {
  return entrypoint.kind === "ui-route" ? (entrypoint.component === "unknown" ? undefined : entrypoint.component) : entrypoint.handler;
}

interface Served {
  entrypoint: Entrypoint;
  handler: Handler;
}

/**
 * What the change did to the entrypoints: those the head has and the base lacked are added, those the base had and the
 * head lacks are removed, and one that kept its kind but changed its name, its handler or its base path is altered. An
 * entrypoint is told apart by kind, name, handler and base path; the line of the handler moving changes nothing.
 */
export function changedEntrypoints(base: readonly Entrypoint[], head: readonly Entrypoint[]): ChangedEntrypoint[] {
  const served = (entrypoints: readonly Entrypoint[]): Served[] =>
    [...new Map(entrypoints.flatMap((entrypoint) => (handlerOf(entrypoint) === undefined ? [] : [{ entrypoint, handler: handlerOf(entrypoint)! }])).map((item) => [identity(item), item])).values()];
  const before = served(base);
  const after = served(head);
  const kept = new Set(before.map(identity));
  const stayed = new Set(after.map(identity).filter((key) => kept.has(key)));
  const removedOrAltered = before.filter((item) => !stayed.has(identity(item)));
  const addedOrAltered = after.filter((item) => !stayed.has(identity(item)));

  const changes: ChangedEntrypoint[] = [];
  const unpaired = new Set(removedOrAltered);
  for (const item of addedOrAltered) {
    const candidates = [...unpaired].filter((old) => old.entrypoint.kind === item.entrypoint.kind);
    const counterpart = candidates.find((old) => old.entrypoint.name === item.entrypoint.name) ?? candidates.find((old) => sameHandler(old.handler, item.handler));
    if (counterpart === undefined) {
      changes.push(changed("added", item));
    } else {
      unpaired.delete(counterpart);
      changes.push(changed("altered", item));
    }
  }
  for (const item of unpaired) changes.push(changed("removed", item));
  return changes.sort(compareChanges);
}

function changed(change: ChangedEntrypoint["change"], { entrypoint, handler }: Served): ChangedEntrypoint {
  return { change, kind: entrypoint.kind, name: entrypoint.name, handler };
}

function sameHandler(a: Handler, b: Handler): boolean {
  return a.path === b.path && a.symbol === b.symbol;
}

function identity({ entrypoint, handler }: Served): string {
  return JSON.stringify([entrypoint.kind, entrypoint.name, handler.path, handler.symbol, entrypoint.kind === "http-route" ? (entrypoint.basePath.status === "complete" ? entrypoint.basePath.value : entrypoint.basePath.reason) : null]);
}

function compareChanges(a: ChangedEntrypoint, b: ChangedEntrypoint): number {
  return compareText(a.kind, b.kind) || compareText(a.name, b.name) || compareText(a.handler.path, b.handler.path) || compareText(a.handler.symbol, b.handler.symbol) || a.handler.line - b.handler.line || compareText(a.change, b.change);
}
