import assert from "node:assert/strict";
import test from "node:test";
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

const through = (...lines: number[]): NonNullable<Link["propagatedThrough"]> => lines.map((line) => ({ kind: "body" as const, file: "a.ts", line, column: 1 }));
const outerLink = (id: string, line: number, lines: number[], name = "GET /x"): Link => ({ ...link(id, line, 1), to: { ...link(id, line, 1).to, name }, propagatedThrough: through(...lines) });
const body = (id: number, line: number, effects: TraceStep["effects"], extra: Partial<TraceStep> = {}): TraceStep => step(id, effects, { line, endLine: line + 5, ...extra });
const traced = (steps: TraceStep[], all: Link[]) => traceLinks(value(steps), "shop", { repositorySnapshots: SNAPSHOTS, links: all, unlinked: [] }).links;

test("a link sited at an outer caller is returned when the trace expands a body its propagation passed through, and lists the effect that issues it", () => {
  const reached = traced([body(0, 30, [effect(31, 4)])], [outerLink("outer", 8, [30, 20])]);
  assert.deepEqual(reached?.map((one) => [one.id, one.deferred ?? false, one.issuedAt]), [["outer", false, [{ file: "a.ts", line: 31, column: 4 }]]]);
});

test("the innermost expanded body that issues requests decides: an outer body's other requests do not establish the link", () => {
  const steps = [body(0, 30, [effect(31, 4), effect(32, 4)]), body(1, 40, [effect(41, 4)], { parent: 0, depth: 1 })];
  const reached = traced(steps, [outerLink("inner", 8, [30, 40])]);
  assert.deepEqual(reached?.map((one) => one.issuedAt), [[{ file: "a.ts", line: 41, column: 4 }]]);
});

test("a link reached only by deferred effects of such a body is marked deferred, and one an executed effect also reaches is not", () => {
  const all = [outerLink("later", 8, [30]), outerLink("both", 9, [40])];
  const reached = traced([body(0, 30, [effect(31, 4, true)]), body(1, 40, [effect(41, 4, true), effect(42, 4)])], all);
  assert.deepEqual(reached?.map((one) => [one.id, one.deferred ?? false]), [["later", true], ["both", false]]);
});

test("a body the propagation did not pass through, or a direct link, gains nothing from another body's effects", () => {
  assert.deepEqual(traced([body(0, 50, [effect(51, 4)])], [outerLink("a", 8, [30])]), []);
  assert.deepEqual(traced([body(0, 30, [effect(31, 4)])], [link("direct", 8, 1)]), []);
});

test("a body issuing requests of different destinations establishes none of the matches that pass through it", () => {
  const steps = [body(0, 30, [effect(31, 4)])];
  assert.deepEqual(traced(steps, [outerLink("a", 8, [30], "GET /a"), outerLink("b", 9, [30], "GET /b")]), []);
  assert.deepEqual(traced(steps, [outerLink("a", 8, [30], "GET /a"), outerLink("same", 9, [30], "GET /a")])?.map((one) => one.id), ["a", "same"]);
});

test("a link of another repository gains nothing from the traced repository's effects", () => {
  const elsewhere = { ...outerLink("other", 8, [30]), from: { ...link("other", 8, 1).from, repo: "orders" } };
  assert.deepEqual(traced([body(0, 30, [effect(31, 4)])], [elsewhere]), []);
});
