import { test } from "node:test";
import assert from "node:assert/strict";
import { SEMANTIC_INPUTS, TOOL_INPUTS } from "./query-schema.ts";
import type { ToolFamily } from "./presentation.ts";

const SHA = "a".repeat(40);
const FAMILIES = Object.keys(SEMANTIC_INPUTS) as ToolFamily[];
const MINIMAL: Record<ToolFamily, Record<string, unknown>> = {
  entrypoints: {},
  callers: { targets: [{ file: "src/S.java", symbol: "S.find" }] },
  impact: { base: "main" },
  importers: { files: ["src/a.ts"] },
  outline: { files: ["src/a.ts"] },
  workspace: {},
  decisions: {},
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

test("tool schemas default mode to summary; semantic schemas carry no presentation", () => {
  const parsed = TOOL_INPUTS.outline.parse(MINIMAL.outline);
  assert.equal(parsed.mode, "summary");
  assert.deepEqual(SEMANTIC_INPUTS.outline.parse(MINIMAL.outline), MINIMAL.outline);
});
