import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFactHeader } from "./presentation-context.ts";
import * as render from "./render.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

const base = { schema: "0.12.0", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: ["typescript"], frameworks: [], include: ["src/**"], exclude: [] }, content: "c", config: "k", declaredConfig: {changed:["src/a.ts"]}, engines: {} }, evidence: [] } as const;

test("seven ordinary tool families retain unknown context in both text modes", () => {
  const fact = { ...base, status: "unknown", reason: "index-unavailable" } as Fact<never>;
  const renderers = [render.renderEntrypointMap, render.renderImpact, render.renderImporters, render.renderOutline, render.renderWorkspace, render.renderDecisions, render.renderWorkspaceImpact];
  for (const renderer of renderers) for (const mode of ["summary", "details"] as const) {
    const text = renderer(fact, mode);
    assert.ok(text.includes("status: unknown (index-unavailable)"));
    assert.ok(text.includes("declared scope: languages typescript"));
    assert.ok(text.includes("include src/**"));
    assert.ok(text.includes("callers outside the selection remain eligible within scope"));
    assert.ok(text.includes("snapshot: shop @ " + "a".repeat(40)));
  }
});
test("complete, partial and live headers retain uncertainty and snapshot identity", () => {
  const live = {...base, snapshot:{repo:"shop",kind:"live",head:"h",stateId:"state"},status:"partial",value:null,cuts:[{kind:"depth",at:["a"],limit:1,reason:"depth",reach:{kind:"anything"}}]} as Fact<null>;
  assert.equal(renderFactHeader(live)[0], "status: partial (cuts: 1 depth)");
  assert.equal(renderFactHeader(live).at(-1), "snapshot: shop live @ h (state)");
  assert.equal(renderFactHeader({...base,status:"complete",value:null})[0], "status: complete");
});
test("a fact that read a declared build output says so in its header, and whether the snapshot's lockfile verified it", () => {
  const read = (verified: boolean) => ({ ...base, inputs: { ...base.inputs, buildOutputs: [{ kind: "node-modules", at: "web", verified, digest: "d" }] }, status: "complete", value: null }) as Fact<null>;
  assert.ok(renderFactHeader(read(false)).includes("build output: web/node_modules, unverified (no lockfile at the snapshot)"));
  assert.ok(renderFactHeader(read(true)).includes("build output: web/node_modules, verified by the snapshot's lockfile"));
  assert.equal(renderFactHeader({ ...base, status: "complete", value: null } as Fact<null>).some((line) => line.startsWith("build output")), false);
});

test("a partial scope selection is presented without changing the fact status", () => {
  const fact = { ...base, status: "complete", value: null, scopeSelection: { unmatchedIncludes: ["missing/**"], selectedFiles: 2 } } as Fact<null>;
  const lines = renderFactHeader(fact);
  assert.equal(lines[0], "status: complete");
  assert.ok(lines.includes("scope: include missing/** selected no path (the rest selected 2 files)"));
});
