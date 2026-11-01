import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSections, SCHEMA, type Fact, type FactBase } from "./fact.ts";

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
    routes: { ...buildBase(), status: "partial", value: ["/orders"], cuts: [{ kind: "depth", at: ["src/app.ts"] }] },
    links: complete([]),
    api: { ...buildBase(), status: "unknown", reason: "index-unavailable" },
  } satisfies Record<string, Fact<string[]>>;

  const composite = composeSections(buildBase(), sections);

  assert.equal(composite.status, "partial");
  assert.deepEqual(composite.status === "partial" && composite.cuts, [
    { kind: "section", at: ["api"] },
    { kind: "section", at: ["routes"] },
  ]);
  assert.equal(composite.value, sections);
});
