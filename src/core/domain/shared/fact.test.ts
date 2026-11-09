import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSections, SCHEMA, withCuts, type Cut, type Fact, type FactBase } from "./fact.ts";

function buildBase(): FactBase {
  return {
    schema: SCHEMA,
    snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) },
    producer: { name: "ye-ast", version: "0.0.0" },
    inputs: {
      trust: "untrusted",
      scope: "scope-digest",
      declaredScope: { languages: ["typescript"], frameworks: [], include: [], exclude: [] },
      content: "content-digest",
      config: "config-digest",
      declaredConfig: {},
      engines: { codegraph: "1.6.2", typescript: "6.0.3" },
    },
    evidence: [],
  };
}

function complete(value: string[]): Fact<string[]> {
  return { ...buildBase(), status: "complete", value };
}

test("a composite whose sections are all complete is complete", () => {
  const composite = composeSections(buildBase(), { routes: complete(["/orders"]), api: complete([]) });
  assert.equal(composite.status, "complete");
});

test("a composite cuts each incomplete section once, sorted by name, and never a complete one", () => {
  const sections = {
    routes: { ...buildBase(), status: "partial", value: ["/orders"], cuts: [{ kind: "depth", at: ["src/app.ts"], reason: "depth", reach: { kind: "anything" } }] },
    links: complete([]),
    api: { ...buildBase(), status: "unknown", reason: "index-unavailable" },
  } satisfies Record<string, Fact<string[]>>;

  const composite = composeSections(buildBase(), sections);

  assert.equal(composite.status, "partial");
  assert.deepEqual(composite.status === "partial" && composite.cuts, [
    { kind: "section", at: ["api"], reason: "section-unknown", reach: { kind: "anything" } },
    { kind: "section", at: ["routes"], reason: "section-partial", reach: { kind: "anything" } },
  ]);
  assert.equal(composite.value, sections);
});

test("a cut that does not state why it exists does not type-check", () => {
  // @ts-expect-error a cut states why it exists (ADR-0042 decision 1)
  const reasonless: Cut = { kind: "depth", at: ["src/app.ts"] };
  assert.ok(reasonless);
});

test("two cuts at one place leave the one with the wider reach, whatever order they were emitted in", () => {
  const narrow: Cut = { kind: "unresolved-link", at: ["src/a.ts", "src/a.ts:3 b"], reason: "hidden-caller", reach: { kind: "callers-of", declarations: ["src/b.ts::b"] } };
  const file: Cut = { ...narrow, reason: "relation-unread", reach: { kind: "anything", runtime: "typescript" } };
  const wide: Cut = { ...narrow, reason: "relation-unread", reach: { kind: "anything" } };

  for (const cuts of [[narrow, file, wide], [wide, file, narrow], [file, narrow, wide]]) {
    const fact = withCuts(buildBase(), [], cuts);
    assert.deepEqual(fact.status === "partial" && fact.cuts, [wide]);
  }
  for (const cuts of [[narrow, file], [file, narrow]]) {
    const fact = withCuts(buildBase(), [], cuts);
    assert.deepEqual(fact.status === "partial" && fact.cuts, [file]);
  }
});

test("two cuts at one place with reaches of equal width leave the one whose reason, then sub-reason, comes first", () => {
  const noSymbols: Cut = { kind: "no-extractor", at: ["src/Money.java"], reason: "no-symbols", reach: { kind: "anything", runtime: "java" } };
  const unmodelled: Cut = { ...noSymbols, reason: "unmodelled" };
  const elsewhere: Cut = { ...noSymbols, at: ["src/Other.java"] };
  const unproven: Cut = { kind: "unresolved-link", at: ["src/a.ts:2 send"], reason: "dispatch", subReason: "unproven", reach: { kind: "call-at", place: "src/a.ts:2 send" } };
  const absent: Cut = { ...unproven, subReason: "capability-absent" };

  for (const cuts of [[noSymbols, elsewhere, unmodelled], [unmodelled, elsewhere, noSymbols]]) {
    const fact = withCuts(buildBase(), [], cuts);
    assert.deepEqual(fact.status === "partial" && fact.cuts, [noSymbols, elsewhere]);
  }
  for (const cuts of [[unproven, absent], [absent, unproven]]) {
    const fact = withCuts(buildBase(), [], cuts);
    assert.deepEqual(fact.status === "partial" && fact.cuts, [unproven]);
  }
});
