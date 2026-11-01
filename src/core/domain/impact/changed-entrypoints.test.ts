import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import type { BasePath, Handler } from "../entrypoints/http-route.ts";
import { changedEntrypoints } from "./changed-entrypoints.ts";

const NO_BASE_PATH: BasePath = { default: {}, profiles: {} };

function route(name: string, symbol: string, line = 5, path = "src/Orders.java", basePath: BasePath = NO_BASE_PATH): Entrypoint {
  const [method, routePath] = name.split(" ") as ["GET", string];
  return { kind: "http-route", name, method, path: routePath, handler: { path, symbol, line }, basePath: { status: "complete", value: basePath, evidence: [] } };
}

function page(name: string, component: Handler | "unknown"): Entrypoint {
  return { kind: "ui-route", name, path: name, component, guards: [] };
}

const summary = (changes: ReturnType<typeof changedEntrypoints>) => changes.map((change) => `${change.change} ${change.name} ${change.handler.symbol}`);

test("an entrypoint only the head has is added and one only the base has is removed", () => {
  const changes = changedEntrypoints([route("GET /old", "Orders.old")], [route("POST /new", "Orders.create")]);
  assert.deepEqual(summary(changes), ["removed GET /old Orders.old", "added POST /new Orders.create"]);
});

test("an entrypoint that is the same in both is no change, even when its handler moved to another line", () => {
  const at = (line: number): Entrypoint => {
    const found = route("GET /a", "Orders.a", line);
    return found.kind === "http-route" ? { ...found, basePath: { status: "complete", value: NO_BASE_PATH, evidence: [{ path: "src/application.yml", line }] } } : found;
  };
  assert.deepEqual(changedEntrypoints([at(5)], [at(40)]), []);
});

test("an entrypoint that kept its name and changed its handler is altered, as the head has it", () => {
  const changes = changedEntrypoints([route("GET /a", "Orders.a")], [route("GET /a", "Orders.fetch")]);
  assert.deepEqual(summary(changes), ["altered GET /a Orders.fetch"]);
});

test("an entrypoint that kept its handler and changed its name is altered", () => {
  const changes = changedEntrypoints([route("GET /a", "Orders.a")], [route("GET /b", "Orders.a")]);
  assert.deepEqual(summary(changes), ["altered GET /b Orders.a"]);
});

test("an entrypoint whose base path changed is altered", () => {
  const moved: BasePath = { default: { contextPath: "/shop" }, profiles: {} };
  const changes = changedEntrypoints([route("GET /a", "Orders.a")], [route("GET /a", "Orders.a", 5, "src/Orders.java", moved)]);
  assert.deepEqual(summary(changes), ["altered GET /a Orders.a"]);
});

test("a name of one kind never pairs with a name of another", () => {
  const changes = changedEntrypoints([page("/a", { path: "src/a.ts", symbol: "A", line: 1 })], [route("GET /a", "A", 1, "src/a.ts")]);
  assert.deepEqual(summary(changes), ["added GET /a A", "removed /a A"]);
});

test("a handler of the same name in another file is another handler", () => {
  const changes = changedEntrypoints([route("GET /a", "Orders.a", 5, "src/One.java")], [route("GET /b", "Orders.a", 5, "src/Two.java")]);
  assert.deepEqual(summary(changes), ["removed GET /a Orders.a", "added GET /b Orders.a"]);
});

test("a route whose component the sources do not name is left out on both sides", () => {
  assert.deepEqual(changedEntrypoints([page("/a", "unknown")], [page("/b", "unknown")]), []);
});

test("changes come sorted by kind, name and handler whatever order the entrypoints came in", () => {
  const head = [route("POST /z", "Z.z"), route("GET /y", "Y.y"), route("GET /y", "A.y")];
  assert.deepEqual(summary(changedEntrypoints([], head)), ["added GET /y A.y", "added GET /y Y.y", "added POST /z Z.z"]);
  assert.deepEqual(summary(changedEntrypoints([], head.toReversed())), summary(changedEntrypoints([], head)));
});
