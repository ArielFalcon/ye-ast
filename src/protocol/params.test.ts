import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidParamsError, readCallers, readDecisions, readOfChange, readWorkspace } from "./params.ts";

const replay = { version: 1, declaration: `ws-r1:${"a".repeat(64)}`, snapshots: [{ kind: "sha", repo: "orders", sha: "b".repeat(40) }] };

test("workspace replay is preserved and malformed or unsupported contexts are rejected", () => {
  const request = { repo: { path: "/work/orders" }, replay };
  assert.deepEqual(readWorkspace(request).replay, replay);
  assert.throws(() => readWorkspace({ ...request, replay: { ...replay, extra: true } }), InvalidParamsError);
  assert.throws(() => readWorkspace({ ...request, replay: { ...replay, snapshots: [...replay.snapshots, ...replay.snapshots] } }), InvalidParamsError);
  assert.throws(() => readDecisions(request), InvalidParamsError);
});


test("a live member cannot carry a revision even when explicitly undefined", () => {
  assert.throws(() => readWorkspace({ repo: { path: "a", live: true, revision: undefined } }), InvalidParamsError);
});

test("declared build outputs reach callers and impact as typed values, and a relative path or an escaping directory is refused", () => {
  const callers = { repo: "/r", repoId: "r", revision: "HEAD", targets: [{ file: "a.ts", symbol: "f" }] };
  const change = { repo: "/r", repoId: "r", base: "main", head: "HEAD" };
  const output = { kind: "node-modules", at: "web", path: "/host/web/node_modules" };

  assert.deepEqual(readCallers({ ...callers, buildOutputs: [output] }).buildOutputs, [output]);
  assert.deepEqual(readOfChange({ ...change, buildOutputs: [{ kind: "node-modules", path: "/host/node_modules" }] }).buildOutputs, [{ kind: "node-modules", at: "", path: "/host/node_modules" }]);
  assert.equal("buildOutputs" in readCallers(callers), false);
  for (const wrong of [{ ...output, path: "node_modules" }, { ...output, at: "../up" }, { ...output, kind: "jar" }]) {
    assert.throws(() => readCallers({ ...callers, buildOutputs: [wrong] }), InvalidParamsError, JSON.stringify(wrong));
  }
});

test("a java-sources declaration reaches callers with the directory it stands for, and a relative path or a missing at is refused", () => {
  const callers = { repo: "/r", repoId: "r", revision: "HEAD", targets: [{ file: "a.ts", symbol: "f" }] };
  const output = { kind: "java-sources", at: "target/generated-sources/openapi", path: "/host/generated" };

  assert.deepEqual(readCallers({ ...callers, buildOutputs: [output] }).buildOutputs, [output]);
  for (const wrong of [{ ...output, path: "generated" }, { ...output, at: "" }]) {
    assert.throws(() => readCallers({ ...callers, buildOutputs: [wrong] }), InvalidParamsError, JSON.stringify(wrong));
  }
});
