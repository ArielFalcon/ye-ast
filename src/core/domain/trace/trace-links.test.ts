import assert from "node:assert/strict";
import test from "node:test";
import type { PlacedCallSite } from "../topology/call-site.ts";
import type { Link } from "../topology/link.ts";
import type { TraceStep, TraceValue } from "./trace-fact.ts";
import { traceLinks } from "./trace-links.ts";

const SNAPSHOTS = [{ repo: "shop", snapshot: { repo: "shop", kind: "sha" as const, sha: "a".repeat(40) } }];
const link = (id: string, line: number, column: number): Link => ({ id, from: { repo: "shop", file: "a.ts", line, column, symbol: "Api.run" }, to: { repo: "orders", kind: "http-route", name: "GET /x", handler: { path: "O.java", symbol: "x", line: 1 } }, transport: "http", basis: "exact", confidence: 1 });
const effect = (line: number, column: number, deferred = false, path = "/x"): NonNullable<TraceStep["effects"]>[number] => ({ kind: "http", line, column, target: { method: "GET", path }, ...(deferred ? { deferred: true as const } : {}) });
const step = (id: number, effects: TraceStep["effects"], extra: Partial<TraceStep> = {}): TraceStep => ({ id, depth: 0, file: "a.ts", symbol: "run", kind: "method", line: 1, ...(effects === undefined ? {} : { effects }), ...extra });
const value = (steps: TraceStep[]): TraceValue => ({ roots: [], steps, readingPlan: { ranges: [], lines: 0 }, cost: { expanded: 1 } });
const links = (steps: TraceStep[], all: Link[]) => traceLinks(value(steps), "shop", { repositorySnapshots: SNAPSHOTS, links: all, unlinked: [] }).links;

test("a link reached only by a deferred effect is marked, and one an executed effect also reaches is not", () => {
  const all = [link("later", 8, 1), link("both", 9, 1), link("now", 10, 1)];
  const reached = links([step(0, [effect(8, 1, true), effect(9, 1, true), effect(9, 1), effect(10, 1)])], all);
  assert.deepEqual(reached?.map((one) => [one.id, one.deferred ?? false]), [["later", true], ["both", false], ["now", false]]);
});

test("a link outside every effect place is dropped", () => {
  const all = [link("inside", 8, 1), link("beside", 8, 2)];
  assert.deepEqual(links([step(0, [effect(8, 1, true)])], all)?.map((one) => one.id), ["inside"]);
});

test("a step that is deferred, or has a deferred ancestor, returns its links marked deferred, unless an executed step also reaches them", () => {
  const all = [link("own", 8, 1), link("below", 9, 1), link("both", 10, 1), link("plain", 11, 1)];
  const reached = links([
    step(0, [effect(11, 1)]),
    step(1, [effect(8, 1)], { parent: 0, deferred: true }),
    step(2, [effect(9, 1), effect(10, 1)], { parent: 1, depth: 1 }),
    step(3, [effect(10, 1)], { parent: 0 }),
  ], all);
  assert.deepEqual(reached?.map((one) => [one.id, one.deferred ?? false]), [["own", true], ["below", true], ["both", false], ["plain", false]]);
});

test("an unresolved request owned as deferred marks the unlinked call site it reaches", () => {
  const unlinked = { from: link("x", 8, 1).from, transport: "http" as const, outcome: "unmatched" as const, name: "/x" };
  const request = { path: "a.ts", line: 8, column: 1, symbol: "Api.run", transport: "http" as const, reason: "unresolved" as const, evidence: [], deferred: true as const };
  const answer = traceLinks(value([step(0, undefined, { unresolvedEffects: [request] })]), "shop", { repositorySnapshots: SNAPSHOTS, links: [], unlinked: [unlinked] });
  assert.deepEqual(answer.unlinked, [{ ...unlinked, deferred: true }]);
});

const GET = (path: string) => ({ status: "complete" as const, value: { method: "GET" as const, path }, evidence: [] });
const outer = (line: number, bodies: readonly number[], path = "/x"): PlacedCallSite => ({
  site: { repo: "shop", file: "a.ts", line, symbol: "Api.run", transport: "http", target: GET(path) },
  column: 0,
  origins: bodies.map((at) => ({ kind: "body" as const, file: "a.ts", line: at, column: 0 })),
});
const outerLink = (id: string, line: number, name = "GET /x"): Link => ({ ...link(id, line, 1), to: { ...link(id, line, 1).to, name } });
const body = (id: number, line: number, effects: TraceStep["effects"], extra: Partial<TraceStep> = {}): TraceStep => step(id, effects, { line, endLine: line + 5, ...extra });
const through = (steps: TraceStep[], all: Link[], placed: PlacedCallSite[]) => traceLinks(value(steps), "shop", { repositorySnapshots: SNAPSHOTS, links: all, unlinked: [] }, placed).links;

test("a link sited at an outer caller is returned when the trace expands a body its propagation passed through and that body states its request", () => {
  const reached = through([body(0, 30, [effect(31, 4)])], [outerLink("outer", 8)], [outer(8, [30, 20])]);
  assert.deepEqual(reached?.map((one) => [one.id, one.deferred ?? false, one.issuedAt]), [["outer", false, [{ file: "a.ts", line: 31, column: 4 }]]]);
});

test("a link reached only by deferred effects of such a body is marked deferred, and one an executed effect also reaches is not", () => {
  const placed = [outer(8, [30]), outer(9, [40])];
  const all = [outerLink("later", 8), outerLink("both", 9)];
  const reached = through([body(0, 30, [effect(31, 4, true)]), body(1, 40, [effect(41, 4, true), effect(42, 4)])], all, placed);
  assert.deepEqual(reached?.map((one) => [one.id, one.deferred ?? false]), [["later", true], ["both", false]]);
});

test("a body that states another request, or one the propagation did not pass through, establishes no link", () => {
  const placed = [outer(8, [30])];
  assert.deepEqual(through([body(0, 30, [effect(31, 4, false, "/y")])], [outerLink("a", 8)], placed), []);
  assert.deepEqual(through([body(0, 50, [effect(51, 4)])], [outerLink("a", 8)], placed), []);
  assert.deepEqual(through([body(0, 30, [effect(31, 4)])], [outerLink("a", 8, "GET /z")], placed), []);
});

test("a site that is its own issuing boundary, or a place outside the trace's repository, gains no link", () => {
  const boundary: PlacedCallSite = { ...outer(8, [30]), issuingBoundary: "site" };
  assert.deepEqual(through([body(0, 30, [effect(31, 4)])], [outerLink("outer", 8)], [boundary]), []);
  const elsewhere = { ...outerLink("other", 8), from: { ...outerLink("other", 8).from, repo: "orders" } };
  assert.deepEqual(through([body(0, 30, [effect(31, 4)])], [elsewhere], [outer(8, [30])]), []);
});

test("a route name takes a request by its method and the end of its path, a parameter segment standing for any", () => {
  const placed = [outer(8, [30], "http://users.host:8080/api/users/{customerId}?x=1")];
  const served = (name: string) => through([body(0, 30, [effect(31, 4, false, "http://users.host:8080/api/users/{customerId}?x=1")])], [outerLink("a", 8, name)], placed)?.length;
  assert.deepEqual(["GET /users/{userId}", "ANY /users/{id}", "POST /users/{id}", "GET /orders/{id}", "GET /{id}"].map(served), [1, 1, 0, 0, 1]);
});
