import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidParamsError, readDecisions, readWorkspace } from "./params.ts";

const replay = { version: 1, declaration: `ws-r1:${"a".repeat(64)}`, snapshots: [{ kind: "sha", repo: "orders", sha: "b".repeat(40) }] };

test("workspace replay is preserved and malformed or unsupported contexts are rejected", () => {
  const request = { repo: { path: "/work/orders" }, replay };
  assert.deepEqual(readWorkspace(request).replay, replay);
  assert.throws(() => readWorkspace({ ...request, replay: { ...replay, extra: true } }), InvalidParamsError);
  assert.throws(() => readWorkspace({ ...request, replay: { ...replay, snapshots: [...replay.snapshots, ...replay.snapshots] } }), InvalidParamsError);
  assert.throws(() => readDecisions(request), InvalidParamsError);
});
