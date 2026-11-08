import { test } from "node:test";
import assert from "node:assert/strict";
import type { Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { CallSite, EventTarget } from "../../domain/topology/call-site.ts";
import type { WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import { entrypointsOf, joinWorkspace, linkMapOf } from "./workspace-join.ts";

function publishing(repo: string, target: EventTarget): CallSite {
  return { repo, file: "src/main/java/app/Orders.java", line: 7, symbol: "Orders.publish", transport: "event", target: { status: "complete", value: target, evidence: [] } };
}

function listening(protocol: Listener["protocol"], destination: string, symbol: string): Listener {
  return { kind: "listener", name: `${protocol} ${destination}`, protocol, destination, handler: { path: "src/main/java/app/Listeners.java", symbol, line: 3 } };
}

function repository(repo: string, callSites: readonly CallSite[], listeners: readonly Listener[]): WorkspaceRepository {
  return { repo, snapshot: { repo, kind: "sha", sha: "a".repeat(40) }, callSites, entrypoints: listeners.map((value) => ({ status: "complete", value, evidence: [] })) };
}

function joined(repositories: readonly WorkspaceRepository[]): ReturnType<typeof linkMapOf> {
  return linkMapOf(joinWorkspace(repositories, repositories.map(entrypointsOf), []).joined);
}

test("the join links an in-process application event to the listener of its own repository", () => {
  const orders = repository("orders", [publishing("orders", { protocol: "event", destination: "app.OrderPlaced", role: "publish" })], [listening("event", "app.OrderPlaced", "Audit.on")]);

  assert.deepEqual(joined([orders]).links.map(({ from, to }) => `${from.repo} -> ${to.repo} ${to.handler.symbol}`), ["orders -> orders Audit.on"]);
});

test("a published message some listeners consume and another could keeps its links and is one could-match item", () => {
  const shop = repository("shop", [publishing("shop", { protocol: "nats", destination: "orders.created", role: "publish" })], []);
  const orders = repository("orders", [], [listening("nats", "orders.*", "Orders.on"), listening("nats", "orders.{}", "Orders.audit")]);

  const { links, unlinked } = joined([shop, orders]);

  assert.deepEqual([links.map(({ to }) => to.handler.symbol), unlinked.map(({ outcome, name }) => `${outcome} ${name}`)], [["Orders.on"], ["could-match orders.created"]]);
});
