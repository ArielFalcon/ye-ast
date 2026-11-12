import assert from "node:assert/strict";
import test from "node:test";
import type { Link } from "../topology/link.ts";
import type { TraceStep, TraceValue } from "./trace-fact.ts";
import { traceLinks } from "./trace-links.ts";

const SNAPSHOTS = [{ repo: "shop", snapshot: { repo: "shop", kind: "sha" as const, sha: "a".repeat(40) } }];
const link = (id: string, line: number, column: number): Link => ({ id, from: { repo: "shop", file: "a.ts", line, column, symbol: "Api.run" }, to: { repo: "orders", kind: "http-route", name: "GET /x", handler: { path: "O.java", symbol: "x", line: 1 } }, transport: "http", basis: "exact", confidence: 1 });
const effect = (line: number, column: number, deferred = false): NonNullable<TraceStep["effects"]>[number] => ({ kind: "http", line, column, target: { method: "GET", path: "/x" }, ...(deferred ? { deferred: true as const } : {}) });
const step = (id: number, effects: TraceStep["effects"], extra: Partial<TraceStep> = {}): TraceStep => ({ id, depth: 0, file: "a.ts", symbol: "run", kind: "method", line: 1, ...(effects === undefined ? {} : { effects }), ...extra });
const value = (steps: TraceStep[]): TraceValue => ({ roots: [], steps, readingPlan: { ranges: [], lines: 0 }, cost: { expanded: 1 } });
const links = (steps: TraceStep[], all: Link[]) => traceLinks(value(steps), "shop", { repositorySnapshots: SNAPSHOTS, links: all, unlinked: [] }).links;

test("a link reached only by a deferred effect is marked, and one an executed effect also reaches is not", () => {
  const all = [link("later", 8, 1), link("both", 9, 1), link("now", 10, 1)];
  const reached = links([step(0, [effect(8, 1, true), effect(9, 1, true), effect(9, 1), effect(10, 1)])], all);
  assert.deepEqual(reached?.map((one) => [one.id, one.deferred ?? false]), [["later", true], ["both", false], ["now", false]]);
});

test("a deferred step contributes nothing, and a link outside every effect place is dropped", () => {
  const all = [link("inside", 8, 1), link("beside", 8, 2)];
  assert.deepEqual(links([step(0, [effect(8, 1)], { deferred: true })], all), []);
  assert.deepEqual(links([step(0, [effect(8, 1, true)])], all)?.map((one) => one.id), ["inside"]);
});

test("an unresolved request owned as deferred marks the unlinked call site it reaches", () => {
  const unlinked = { from: link("x", 8, 1).from, transport: "http" as const, outcome: "unmatched" as const, name: "/x" };
  const request = { path: "a.ts", line: 8, column: 1, symbol: "Api.run", transport: "http" as const, reason: "unresolved" as const, evidence: [], deferred: true as const };
  const answer = traceLinks(value([step(0, undefined, { unresolvedEffects: [request] })]), "shop", { repositorySnapshots: SNAPSHOTS, links: [], unlinked: [unlinked] });
  assert.deepEqual(answer.unlinked, [{ ...unlinked, deferred: true }]);
});
