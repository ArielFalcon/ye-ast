import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkspaceReplayContext } from "./workspace-replay.ts";

const declaration = `ws-r1:${"a".repeat(64)}`;
const head = "b".repeat(40);

test("a replay validates a sorted mixed vector and its exact live fields", () => {
  const live = { repo: "b", kind: "live", head, stateId: "state" };
  const context = { version: 1, declaration, snapshots: [{ repo: "a", kind: "sha", sha: head }, live] };
  assert.equal(isWorkspaceReplayContext(context), true);
  for (const invalid of [
    { ...live, head: "HEAD" }, { ...live, stateId: "" }, { ...live, extra: true },
    { ...live, repo: "" }, { ...live, sha: head },
  ]) assert.equal(isWorkspaceReplayContext({ ...context, snapshots: [context.snapshots[0], invalid] }), false);
  assert.equal(isWorkspaceReplayContext({ ...context, snapshots: [live, context.snapshots[0]] }), false);
});
