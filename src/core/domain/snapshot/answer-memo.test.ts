import assert from "node:assert/strict";
import { test } from "node:test";
import { ANYTHING, SCHEMA, type Fact, type FactBase } from "../shared/fact.ts";
import { isKeptAnswer } from "./answer-memo.ts";

const BASE: FactBase = {
  schema: SCHEMA,
  snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) },
  producer: { name: "ye-ast", version: "0" },
  inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
  evidence: [],
};

test("an answer is kept unless some part of it is unknown for a transient reason or cut by a deadline, however deep", () => {
  const cases: [string, Fact<unknown>, boolean][] = [
    ["complete", { ...BASE, status: "complete", value: { sections: { a: { status: "unknown", reason: "out-of-scope" } } } }, true],
    ["deadline cut", { ...BASE, status: "partial", value: {}, cuts: [{ kind: "deadline", at: ["walk"], reason: "deadline", reach: ANYTHING }] }, false],
    ["index unavailable", { ...BASE, status: "unknown", reason: "index-unavailable" }, false],
    ["nested source unreadable", { ...BASE, status: "complete", value: { sections: { trace: { status: "unknown", reason: "source-unreadable" } } } }, false],
    ["nested revision unavailable", { ...BASE, status: "complete", value: { repos: [{ fact: { status: "unknown", reason: "revision-unavailable" } }] } }, false],
    ["finding cut by a deadline", { ...BASE, status: "complete", value: { findings: [{ status: "unknown", reason: "deadline" }] } }, false],
  ];
  for (const [name, fact, kept] of cases) assert.equal(isKeptAnswer(fact), kept, name);
});
