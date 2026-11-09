import { test } from "node:test";
import assert from "node:assert/strict";
import { ANYTHING, SCHEMA, type Cut, type CutReach, type FactBase } from "./fact.ts";
import { EVERYTHING, inQuestion, withCuts, type Asserted } from "./question.ts";

const LOCAL: Asserted = { kind: "local", files: ["src/a.ts"] };
const DEPENDENTS: Asserted = { kind: "dependents", files: ["src/a.ts"] };
const JAVA_DEPENDENTS: Asserted = { kind: "dependents", files: ["src/A.java"] };
const at = (kind: Cut["kind"], reason: Cut["reason"], reach: CutReach, ...places: string[]): Cut => ({ kind, at: places, reason, reach });
const ts = (file: string): CutReach => ({ kind: "anything", runtime: file.endsWith(".java") ? "java" : "typescript" });

test("a bound, a section and a reach of anything without a runtime are in question for every assertion (ADR-0042 fixtures 9, 10)", () => {
  const always = [
    at("depth", "depth", ts("src/z.java"), "src/z.java::f"),
    at("hub", "hub", ts("src/z.java"), "src/z.java::f"),
    at("caller-budget", "export-budget", ts("src/z.java"), "src/z.java"),
    at("node-cap", "node-cap", ts("src/z.java"), "src/z.java"),
    at("deadline", "deadline", ts("src/z.java"), "src/z.java"),
    at("section", "section-partial", ts("src/z.java"), "web"),
    at("not-exported", "symlink", ANYTHING, "src/z.java"),
  ];
  for (const asserted of [LOCAL, DEPENDENTS, JAVA_DEPENDENTS, EVERYTHING]) for (const cut of always) assert.equal(inQuestion(cut, asserted), true, `${cut.kind} under ${asserted.kind}`);
});

test("what the asked files hold is cut only at a place in one of them", () => {
  assert.equal(inQuestion(at("no-extractor", "not-indexed", ts("src/b.ts"), "src/b.ts"), LOCAL), false);
  assert.equal(inQuestion(at("no-extractor", "not-indexed", ts("src/a.ts"), "src/a.ts"), LOCAL), true);
  assert.equal(inQuestion(at("unresolved-link", "use-unproven", ts("src/a.ts"), "src/a.ts::A.run", "src/a.ts:3 x"), LOCAL), true);
  assert.equal(inQuestion(at("unresolved-link", "hidden-caller", { kind: "callers-of", declarations: ["src/b.ts::B"] }, "src/b.ts::B", "src/a.ts:4 b"), LOCAL), true);
  assert.equal(inQuestion(at("unresolved-link", "specifier", { kind: "module", importer: "src/b.ts", specifiers: [{ specifier: "x" }] }, "src/b.ts", "src/b.ts:1 x"), LOCAL), false);
});

test("what depends on the asked files is cut by a file only when it shares their runtime", () => {
  assert.equal(inQuestion(at("no-extractor", "not-indexed", ts("src/b.ts"), "src/b.ts"), DEPENDENTS), true);
  assert.equal(inQuestion(at("no-extractor", "not-indexed", ts("src/b.ts"), "src/b.ts"), JAVA_DEPENDENTS), false);
  assert.equal(inQuestion(at("unresolved-link", "dynamic-load", ts("src/b.ts"), "src/b.ts", "src/b.ts:4 load"), DEPENDENTS), true);
  assert.equal(inQuestion(at("unresolved-link", "name-only", { kind: "callers-of", declarations: ["Order"] }, "src/b.ts", "src/b.ts:4 Order"), JAVA_DEPENDENTS), false);
  assert.equal(inQuestion(at("unresolved-link", "name-only", { kind: "callers-of", declarations: ["Order"] }, "src/b.ts", "src/b.ts:4 Order"), DEPENDENTS), true);
});

test("a specifier is out of what depends on the asked files only when its importer shares no runtime with them or the resolver named no file for any of its specifiers (ADR-0042 fixtures 1, 2)", () => {
  const module = (...specifiers: { specifier: string; namesNoFile?: true }[]): Cut => at("unresolved-link", "specifier", { kind: "module", importer: "src/b.ts", specifiers }, "src/b.ts", "src/b.ts:1 x");
  assert.equal(inQuestion(module({ specifier: "@/x" }), JAVA_DEPENDENTS), false);
  assert.equal(inQuestion(module({ specifier: "@/x" }), DEPENDENTS), true);
  assert.equal(inQuestion(module({ specifier: "@/x", namesNoFile: true }), DEPENDENTS), false);
  assert.equal(inQuestion(module({ specifier: "@/x", namesNoFile: true }, { specifier: "@/y" }), DEPENDENTS), true);
});

test("a walk keeps every cut at a place sharing a walked file's runtime and drops a specifier that names no file (ADR-0042 fixtures 8, 12)", () => {
  const walk: Asserted = { kind: "walk", files: ["src/flow.ts", "src/a.ts"] };
  const javaWalk: Asserted = { kind: "walk", files: ["src/Flow.java"] };
  const dispatch = at("unresolved-link", "dispatch", { kind: "call-at", place: "src/flow.ts:2 save" }, "src/flow.ts:2 save", "src/a.ts::A.save");
  const frontier = at("unresolved-link", "hidden-caller", { kind: "callers-of", declarations: ["src/a.ts::A.save"] }, "src/a.ts::A.save", "src/c.ts:4 save");
  const unread = at("no-extractor", "module-unread", ts("src/z.ts"), "module:head:src/z.ts");
  const specifier = (namesNoFile?: true): Cut => at("unresolved-link", "specifier", { kind: "module", importer: "src/map.ts", specifiers: [{ specifier: "geojson", ...(namesNoFile ? { namesNoFile } : {}) }] }, "module:head:src/map.ts", "src/map.ts:1 geojson");
  assert.deepEqual([dispatch, frontier, unread, specifier()].map((cut) => inQuestion(cut, walk)), [true, true, true, true]);
  assert.equal(inQuestion(specifier(true), walk), false);
  assert.deepEqual([unread, specifier()].map((cut) => inQuestion(cut, javaWalk)), [false, false]);
  assert.equal(inQuestion(at("no-extractor", "module-unread", ts("src/Z.java"), "module:head:src/Z.java"), javaWalk), true);
});

test("a call site is out of an operation only when its transport differs or the topology matcher excludes it; every other cut stays (ADR-0042 fixture 7)", () => {
  const excluded: string[] = [];
  const operation: Asserted = { kind: "operation", transport: "http", excludes: (site) => (excluded.push(site.template ?? ""), site.template === "invoices/latest") };
  const site = (transport: string, template?: string): Cut => at("unresolved-link", "join-unsettled", { kind: "call-site", transport, method: "GET", ...(template === undefined ? {} : { template }) }, "src/b.ts", "src/b.ts:4");
  assert.equal(inQuestion(site("http", "invoices/latest"), operation), false);
  assert.equal(inQuestion(site("http", "orders-api/orders"), operation), true);
  assert.equal(inQuestion(site("message", "orders"), operation), false);
  assert.equal(inQuestion(at("no-extractor", "language", ts("src/b.ts"), "src/b.ts"), operation), true);
  assert.equal(inQuestion(at("unresolved-link", "specifier", { kind: "module", importer: "src/b.ts", specifiers: [{ specifier: "x", namesNoFile: true }] }, "src/b.ts"), operation), true);
  assert.deepEqual(excluded, ["invoices/latest", "orders-api/orders"]);
});

test("a call site reach stays in question for the files' own content and for what depends on them", () => {
  const site = at("unresolved-link", "join-unsettled", { kind: "call-site", transport: "http" }, "src/b.ts", "src/b.ts:4");
  assert.deepEqual([inQuestion(site, LOCAL), inQuestion(site, DEPENDENTS)], [true, true]);
});

test("an answer keeps only the cuts in its question, and is complete when none is left", () => {
  const base = { schema: SCHEMA, snapshot: { repo: "r", kind: "sha", sha: "a".repeat(40) }, producer: { name: "p", version: "1" }, inputs: {}, evidence: [] } as unknown as FactBase;
  const outside = at("no-extractor", "not-indexed", ts("src/b.ts"), "src/b.ts");
  const inside = at("no-extractor", "not-indexed", ts("src/a.ts"), "src/a.ts");
  assert.equal(withCuts(base, null, [outside], LOCAL).status, "complete");
  const kept = withCuts(base, null, [outside, inside], LOCAL);
  assert.deepEqual(kept.status === "partial" && kept.cuts, [inside]);
  assert.equal(withCuts(base, null, [outside], EVERYTHING).status, "partial");
});
