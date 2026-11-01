import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { Finding } from "../shared/fact.ts";
import { reachedEntrypoints, type ReachedNode } from "./reached-entrypoints.ts";

function node(name: string, startLine: number, endLine: number, overrides: Partial<ReachedNode> = {}): ReachedNode {
  return { file: "src/Orders.java", name, startLine, endLine, depth: 1, confidence: 0.9, seeds: [0], ...overrides };
}

function route(symbol: string, line: number, name = "GET /orders"): Finding<Entrypoint> {
  return {
    status: "complete",
    evidence: [],
    value: { kind: "http-route", name, method: "GET", path: "/orders", handler: { path: "src/Orders.java", symbol, line }, basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] } },
  };
}

test("an entrypoint is reached when its handler is a reached node, joined by file, line and simple name", () => {
  const reached = [node("list", 10, 14), node("show", 16, 20)];
  const entries = reachedEntrypoints([route("Orders.list", 11)], reached);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.name, entry.handler.symbol, entry.depth, entry.confidence, entry.seeds]), [["http-route", "GET /orders", "Orders.list", 1, 0.9, [0]]]);
});

test("a handler whose name differs from the node that holds its line is not reached", () => {
  assert.deepEqual(reachedEntrypoints([route("Orders.show", 11)], [node("list", 10, 14)]), []);
});

test("an entrypoint served by several reached nodes is reported once, with the shallowest depth, strongest confidence and all seeds", () => {
  const reached = [node("list", 12, 13, { depth: 1, confidence: 0.4, seeds: [0, 1] }), node("list", 10, 14, { depth: 3, confidence: 0.9, seeds: [2] })];
  const entries = reachedEntrypoints([route("Orders.list", 12)], reached);
  assert.deepEqual(entries.map((entry) => [entry.depth, entry.confidence, entry.seeds]), [[1, 0.9, [0, 1, 2]]]);
});

test("a route whose component the sources do not name has no handler to reach", () => {
  const unnamed: Finding<Entrypoint> = { status: "complete", evidence: [], value: { kind: "ui-route", name: "/a", path: "/a", component: "unknown", guards: [] } };
  assert.deepEqual(reachedEntrypoints([unnamed], [node("list", 10, 14)]), []);
});

test("a class-level handler is reached through the class node", () => {
  const listener: Finding<Entrypoint> = {
    status: "complete",
    evidence: [],
    value: { kind: "listener", name: "kafka orders", protocol: "kafka", destination: "orders", handler: { path: "src/Orders.java", symbol: "Orders", line: 4 } },
  };
  assert.equal(reachedEntrypoints([listener], [node("Orders", 3, 30)]).length, 1);
});

test("an entrypoint the extractor could not read whole is reported by the innermost reached declaration at its location, without a name", () => {
  const unknown: Finding<Entrypoint> = { status: "unknown", reason: "unresolved", evidence: [{ path: "src/Orders.java", line: 12 }] };
  const reached = [node("Orders", 3, 30, { depth: 0 }), node("list", 10, 14)];
  assert.deepEqual(reachedEntrypoints([unknown], reached), [
    { kind: "unknown", handler: { path: "src/Orders.java", symbol: "list", line: 10 }, depth: 1, confidence: 0.9, seeds: [0] },
  ]);
});

test("kinds come before names", () => {
  const listener: Finding<Entrypoint> = { status: "complete", evidence: [], value: { kind: "listener", name: "0", protocol: "kafka", destination: "a", handler: { path: "src/Orders.java", symbol: "Orders.a", line: 2 } } };
  const entries = reachedEntrypoints([listener, route("Orders.b", 6, "GET /b")], [node("a", 1, 3), node("b", 5, 7)]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["http-route", "listener"]);
});

test("entrypoints come sorted by kind, name and handler", () => {
  const reached = [node("a", 1, 3), node("b", 5, 7)];
  const entries = reachedEntrypoints([route("Orders.b", 6, "GET /b"), route("Orders.a", 2, "GET /a")], reached);
  assert.deepEqual(entries.map((entry) => entry.name), ["GET /a", "GET /b"]);
});
