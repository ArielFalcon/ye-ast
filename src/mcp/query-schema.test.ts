import { COMPOSE_INPUT } from "./composition-input.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { SEMANTIC_INPUTS, TOOL_INPUTS } from "./query-schema.ts";
import type { ToolFamily } from "./presentation.ts";

const SHA = "a".repeat(40);
const HYPOTHESIS = { method: "GET", path: "/owners/{id}", target: "response", property: "name", change: "nullable" };
const FAMILIES = Object.keys(SEMANTIC_INPUTS) as ToolFamily[];
const MINIMAL: Record<ToolFamily, Record<string, unknown>> = {
  entrypoints: {},
  callers: { targets: [{ file: "src/S.java", symbol: "S.find" }] },
  impact: { base: "main" },
  importers: { files: ["src/a.ts"] },
  outline: { files: ["src/a.ts"] },
  trace: { targets: [{ file: "src/a.ts", symbol: "run" }] },
  workspace: {},
  decisions: {},
  contract_consequences: { hypotheses: [HYPOTHESIS] },
};
const RECOVERABLE = ["entrypoints", "callers", "impact"] as const;
const accepts = (family: ToolFamily, args: unknown, schemas = SEMANTIC_INPUTS) => schemas[family].safeParse(args).success;

test("every family has one semantic and one tool schema with the same fields apart from the controls", () => {
  assert.deepEqual(FAMILIES.toSorted(), (Object.keys(TOOL_INPUTS) as ToolFamily[]).toSorted());
  for (const family of FAMILIES) {
    const controls = (RECOVERABLE as readonly string[]).includes(family) ? ["mode", "select", "page", "expect"] : ["mode"];
    const tool = Object.keys(TOOL_INPUTS[family].shape).filter((key) => !controls.includes(key));
    assert.deepEqual(tool, Object.keys(SEMANTIC_INPUTS[family].shape), family);
    assert.ok(accepts(family, MINIMAL[family]), family);
  }
});

test("semantic queries reject presentation and recovery controls", () => {
  for (const family of FAMILIES) {
    assert.equal(accepts(family, { ...MINIMAL[family], mode: "full" }), false, `${family} mode`);
    assert.ok(accepts(family, { ...MINIMAL[family], mode: "full" }, TOOL_INPUTS), `${family} tool keeps mode`);
  }
  const select = { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 };
  for (const family of RECOVERABLE) {
    for (const control of [{ select }, { page: { limit: 1 } }, { expect: `mcp-r1:${"0".repeat(64)}` }]) {
      assert.equal(accepts(family, { ...MINIMAL[family], ...control }), false, `${family} ${Object.keys(control)[0]}`);
    }
    assert.ok(accepts(family, { ...MINIMAL[family], select, page: { limit: 1 } }, TOOL_INPUTS), `${family} tool keeps selection`);
    assert.equal(accepts(family, { ...MINIMAL[family], select }, TOOL_INPUTS), false, `${family} tool still pairs select with page`);
    assert.equal(accepts(family, { ...MINIMAL[family], page: { limit: 1 } }, TOOL_INPUTS), false, `${family} tool still pairs page with select`);
  }
});

test("semantic and tool schemas share the original cross-field rules", () => {
  const replay = { version: 1, declaration: `ws-r1:${"c".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha", sha: SHA }] };
  for (const schemas of [SEMANTIC_INPUTS, TOOL_INPUTS]) {
    for (const family of ["entrypoints", "callers", "importers", "outline", "workspace", "decisions"] as const) {
      assert.equal(accepts(family, { ...MINIMAL[family], live: true, revision: "main" }, schemas), false, `${family} live+revision`);
      assert.ok(accepts(family, { ...MINIMAL[family], live: true }, schemas), `${family} live`);
    }
    assert.equal(accepts("impact", { base: "main", live: true, head: "x" }, schemas), false, "impact live+head");
    for (const family of ["callers", "impact"] as const) {
      assert.equal(accepts(family, { ...MINIMAL[family], replay }, schemas), false, `${family} replay without workspace`);
      assert.ok(accepts(family, { ...MINIMAL[family], replay, workspace: {} }, schemas), `${family} replay with workspace`);
      assert.equal(accepts(family, { ...MINIMAL[family], workspace: {}, live: false }, schemas), false, `${family} workspace live:false`);
      assert.equal(accepts(family, { ...MINIMAL[family], live: true, offline: true }, schemas), false, `${family} local live offline`);
      assert.ok(accepts(family, { ...MINIMAL[family], live: true, offline: true, workspace: {} }, schemas), `${family} workspace live offline`);
    }
    assert.equal(accepts("callers", { targets: [{ file: "a", start: 5, end: 4 }] }, schemas), false, "range end before start");
    assert.equal(accepts("callers", { targets: [] }, schemas), false, "no targets");
    assert.equal(accepts("impact", {}, schemas), false, "impact needs base");
    assert.equal(accepts("outline", { files: [] }, schemas), false, "no files");
    assert.equal(accepts("entrypoints", { scope: { include: ["../x"] } }, schemas), false, "invalid glob");
    assert.equal(accepts("workspace", { revision: " " }, schemas), false, "blank workspace revision");
    assert.equal(accepts("decisions", { replay }, schemas), false, "decisions has no replay");
  }
});

test("contractConsequences takes exactly one subject and refuses what only the other subject allows", () => {
  const cases: [Record<string, unknown>, boolean][] = [
    [{ hypotheses: [HYPOTHESIS, { ...HYPOTHESIS, target: "request", change: [{ type: "string" }, "required"] }] }, true],
    [{ base: "main" }, true],
    [{ base: "main", head: "feature" }, true],
    [{ hypotheses: [HYPOTHESIS], revision: "main" }, true],
    [{ hypotheses: [HYPOTHESIS], live: true }, true],
    [{ hypotheses: [HYPOTHESIS], workspace: { repos: [{ path: "/w/a", id: "a" }] }, scope: { include: ["src/**"] } }, true],
    [{}, false],
    [{ hypotheses: [] }, false],
    [{ hypotheses: [HYPOTHESIS], base: "main" }, false],
    [{ hypotheses: [{ ...HYPOTHESIS, extra: 1 }] }, false],
    [{ hypotheses: [{ ...HYPOTHESIS, change: [] }] }, false],
    [{ head: "feature", hypotheses: [HYPOTHESIS] }, false],
    [{ base: "main", revision: "main" }, false],
    [{ base: "main", live: true }, false],
    [{ hypotheses: [HYPOTHESIS], live: true, revision: "main" }, false],
    [{ base: "main", select: { kind: "cut-places" } }, false],
  ];
  for (const schemas of [SEMANTIC_INPUTS, TOOL_INPUTS]) {
    for (const [args, expected] of cases) assert.equal(accepts("contract_consequences", args, schemas), expected, JSON.stringify(args));
  }
});

test("tool schemas default mode to summary; semantic schemas carry no presentation", () => {
  const parsed = TOOL_INPUTS.outline.parse(MINIMAL.outline);
  assert.equal(parsed.mode, "summary");
  assert.deepEqual(SEMANTIC_INPUTS.outline.parse(MINIMAL.outline), MINIMAL.outline);
});

test("each rejected cross-field constraint is reported at the control or field a caller must change", () => {
  const replay = { version: 1, declaration: `ws-r1:${"c".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha", sha: SHA }] };
  const cut = (owner: object) => ({ kind: "cut-places", owner, cutIndex: 0 });
  const handler = (owner: object) => ({ kind: "handler-origins", owner, handler: { path: "a", symbol: "h", line: 1 } });
  const page = { limit: 1 };
  const cases: [ToolFamily, Record<string, unknown>, string, string][] = [
    ["callers", { select: cut({ kind: "fact" }) }, "page", "select-requires-page"],
    ["impact", { page }, "select", "page-requires-select"],
    ["callers", { select: cut({ kind: "section", repo: "r" }), page }, "select.owner.kind", "owner-branch"],
    ["impact", { workspace: {}, select: handler({ kind: "local" }), page }, "select.owner.kind", "owner-branch"],
    ["callers", { select: { kind: "workspace-link-evidence", linkId: "l" }, page }, "select.kind", "kind-branch"],
    ["callers", { select: { kind: "module-origins", owner: { kind: "local" }, module: { file: "a", snapshot: "base" } }, page }, "select.kind", "invalid_union"],
    ["entrypoints", { select: cut({ kind: "section", repo: "r" }), page }, "select.owner", "invalid_union"],
    ["impact", { select: cut({ kind: "fact" }), page: { limit: 0 } }, "page.limit", "too_small"],
    ["callers", { replay }, "replay", "replay-requires-workspace"],
    ["impact", { workspace: {}, live: false }, "live", "workspace-live"],
    ["impact", { workspace: {}, head: " " }, "head", "workspace-blank-ref"],
    ["callers", { live: true, offline: true }, "offline", "offline-requires-workspace"],
    ["entrypoints", { live: true, revision: "main" }, "revision", "live-excludes"],
    ["outline", { files: undefined }, "files", "one-subject"],
    ["contract_consequences", { hypotheses: undefined }, "hypotheses", "one-subject"],
    ["contract_consequences", { base: "main" }, "hypotheses", "one-subject"],
    ["contract_consequences", { hypotheses: undefined, base: "main", head: "x", revision: "main" }, "revision", "revision-requires-hypotheses"],
    ["contract_consequences", { head: "x" }, "head", "head-requires-base"],
    ["contract_consequences", { hypotheses: undefined, base: "main", live: true }, "base", "live-excludes"],
  ];
  for (const [family, args, path, constraint] of cases) {
    const result = TOOL_INPUTS[family].safeParse({ ...MINIMAL[family], ...args });
    const issues = result.error?.issues.map((issue) => [issue.path.join("."), issue.code === "custom" ? (issue.params as { constraint: string }).constraint : issue.code]);
    assert.deepEqual(issues, [[path, constraint]], `${family} ${JSON.stringify(args)}`);
  }
});

test("published select shapes offer exactly the owners some workspace branch of the tool accepts", () => {
  const ownerOf = (kind: string) => ({ kind, ...(kind === "section" ? { repo: "r" } : kind === "read" ? { repo: "r", index: 0 } : {}) });
  const subject: Record<string, object> = { "entrypoint-evidence": { findingIndex: 0 }, "handler-origins": { handler: { path: "a", symbol: "h", line: 1 } }, "module-origins": { module: { file: "a", snapshot: "head" } }, "cut-places": { cutIndex: 0 }, "workspace-link-evidence": { linkId: "l" } };
  const allOwners = ["local", "section", "fact", "entrypoints", "read"];
  type Branch = { properties: { kind: { const: string }; owner?: { anyOf: { properties: { kind: { const: string } } }[] } } };
  for (const family of RECOVERABLE) {
    const published = (z.toJSONSchema(TOOL_INPUTS[family], { target: "draft-7" }) as unknown as { properties: { select: { oneOf: Branch[] } } }).properties.select.oneOf;
    const branches = family === "entrypoints" ? [{}] : [{}, { workspace: {} }];
    const accepted = (select: object) => branches.some((branch) => accepts(family, { ...MINIMAL[family], ...branch, select, page: { limit: 1 } }, TOOL_INPUTS));
    for (const kind of Object.keys(subject)) {
      const offered = published.find((branch) => branch.properties.kind.const === kind);
      const owners = offered?.properties.owner?.anyOf.map((owner) => owner.properties.kind.const);
      for (const owner of kind === "entrypoint-evidence" || kind === "workspace-link-evidence" ? [undefined] : allOwners) {
        const select = { kind, ...(owner === undefined ? {} : { owner: ownerOf(owner) }), ...subject[kind] };
        const isOffered = offered !== undefined && (owner === undefined || owners!.includes(owner));
        assert.equal(isOffered, accepted(select), `${family} ${kind} ${owner ?? ""}`);
      }
    }
  }
});

test("trace and composed trace accept workspace sources and reject local live offline", () => {
  const args = { targets: [{ file: "src/a.ts", symbol: "run" }], workspace: { repos: [{ path: "/work/lib", revision: "v1" }] }, offline: true };
  assert.ok(SEMANTIC_INPUTS.trace.safeParse(args).success);
  assert.ok(TOOL_INPUTS.trace.safeParse(args).success);
  assert.ok(COMPOSE_INPUT.safeParse({ queries: [{ name: "ye_ast_trace", arguments: args }] }).success);
  assert.equal(SEMANTIC_INPUTS.trace.safeParse({ targets: args.targets, live: true, offline: true }).success, false);
});
