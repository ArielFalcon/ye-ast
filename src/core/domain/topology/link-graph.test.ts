import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seed, ReachedEntrypoint } from "../impact/impact-fact.ts";
import type { CallSite } from "./call-site.ts";
import { callSiteKey, changeEgress, handlerKey, reachedBy } from "./link-graph.ts";

const seed: Seed = { file: "src/api.ts", symbol: "checkout", line: 10, endLine: 20, basis: "lines" };
const site: CallSite = { repo: "web", file: seed.file, line: 15, symbol: "OrderApi.checkout", transport: "http", target: { status: "complete", value: { method: "POST", path: "/orders" }, evidence: [] } };
const other = { ...site, line: 25, symbol: "Other.checkout" };
const entrypoint: ReachedEntrypoint = { kind: "http-route", name: "POST /orders", handler: { path: "src/controller.ts", symbol: "Controller.create", line: 3 }, depth: 1, confidence: 1, seeds: [0] };

test("change egress joins qualified sites within the seed declaration, excluding homonyms outside it", () => {
  assert.deepEqual([...changeEgress("web", [seed], [site, other]).keys()], [callSiteKey(site)]);
  assert.deepEqual([...changeEgress("web", [{ ...seed, symbol: "OrderApi.checkout" }], [site, other]).keys()], [callSiteKey(site)]);
});

test("reached handlers join qualified sites within the seed declaration, excluding homonyms outside it", () => {
  assert.deepEqual(reachedBy([seed], [entrypoint], [site, other]).get(handlerKey(entrypoint.handler)), [site]);
});

test("change egress selects verified enclosing declarations without broadening inbound joins", () => {
  const nested = { ...site, symbol: "OrderApi.inner", ancestors: [{ symbol: "OrderApi", line: 2, endLine: 30 }, { symbol: "checkout", line: 10, endLine: 20 }] };
  const sibling = { ...other, ancestors: [{ symbol: "OrderApi", line: 2, endLine: 30 }, { symbol: "other", line: 22, endLine: 28 }] };
  const unrelated = { ...site, file: "src/other.ts" };
  const classSeed = { ...seed, symbol: "OrderApi", line: 2, endLine: 30 };
  assert.deepEqual([...changeEgress("web", [classSeed], [nested, sibling, unrelated]).keys()], [callSiteKey(nested), callSiteKey(sibling)]);
  assert.deepEqual([...changeEgress("web", [seed], [nested, sibling]).keys()], [callSiteKey(nested)]);
  assert.equal(reachedBy([seed], [entrypoint], [nested]).get(handlerKey(entrypoint.handler)), undefined);
});

test("an ancestor extending beyond the seed is not evidence that it belongs to that seed", () => {
  const nested = { ...site, symbol: "OrderApi.inner", ancestors: [{ symbol: "checkout", line: 10, endLine: 21 }] };
  assert.equal(changeEgress("web", [seed], [nested]).size, 0);
});
