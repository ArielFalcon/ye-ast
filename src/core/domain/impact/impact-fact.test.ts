import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, type Cut, type FactBase } from "../shared/fact.ts";
import { impactFact, type ImpactValue } from "./impact-fact.ts";

const BASE: FactBase = {
  schema: SCHEMA,
  snapshot: { repo: "r", kind: "sha", sha: "a".repeat(40) },
  producer: { name: "ye-ast", version: "0" },
  inputs: { trust: "untrusted", scope: "", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "", config: "", declaredConfig: {}, engines: {} },
  evidence: [],
};
const VALUE: ImpactValue = { mergeBase: "b".repeat(40), seeds: [], changedEntrypoints: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };

test("a fact with no cut is complete", () => {
  assert.equal(impactFact(BASE, VALUE, []).status, "complete");
});

test("a fact with a cut is partial and lists the cuts by kind then place, each once", () => {
  const cuts: Cut[] = [
    { kind: "not-exported", at: ["b"] },
    { kind: "no-extractor", at: ["z"] },
    { kind: "no-extractor", at: ["a"] },
    { kind: "depth", at: ["x"], limit: 2 },
    { kind: "no-extractor", at: ["a"] },
    { kind: "unresolved-link", at: ["q"] },
    { kind: "hub", at: ["h"], limit: 1 },
    { kind: "caller-budget", at: ["c"], limit: 3 },
  ];
  const fact = impactFact(BASE, VALUE, cuts);
  assert.equal(fact.status, "partial");
  assert.deepEqual(fact.status === "partial" && fact.cuts.map((cut) => `${cut.kind} ${cut.at.join(",")}`), [
    "depth x",
    "hub h",
    "caller-budget c",
    "unresolved-link q",
    "no-extractor a",
    "no-extractor z",
    "not-exported b",
  ]);
});

test("every kind of cut has a place in the order, bounds first, whatever order the cuts arrive in", () => {
  const kinds: Cut["kind"][] = ["section", "deadline", "not-exported", "no-extractor", "unresolved-link", "node-cap", "caller-budget", "hub", "depth"];
  const order = (input: readonly Cut["kind"][]): string[] => {
    const fact = impactFact(BASE, VALUE, input.map((kind): Cut => ({ kind, at: ["p"] })));
    return fact.status === "partial" ? fact.cuts.map((cut) => cut.kind) : [];
  };
  const expected = ["depth", "hub", "caller-budget", "node-cap", "deadline", "unresolved-link", "no-extractor", "not-exported", "section"];
  assert.deepEqual(order(kinds), expected);
  assert.deepEqual(order(kinds.toReversed()), expected);
});
