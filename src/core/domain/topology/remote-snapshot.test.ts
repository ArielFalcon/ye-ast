import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRemoteSnapshot, type RemoteListing } from "./remote-snapshot.ts";

const MAIN = "a".repeat(40);
const DEVELOP = "b".repeat(40);
const OTHER = "c".repeat(40);

const LISTING: RemoteListing = {
  branches: [
    { name: "main", sha: MAIN },
    { name: "develop", sha: DEVELOP },
  ],
  defaultBranch: "main",
};

test("an explicit branch the listing states wins and records the listing entry", () => {
  const resolution = resolveRemoteSnapshot("orders", "develop", "develop", LISTING);

  assert.deepEqual(resolution, { repo: "orders", asked: "develop", step: "explicit", consulted: [{ branch: "develop", sha: DEVELOP }], sha: DEVELOP });
});

test("an explicit full sha wins as it is, with no listing entry", () => {
  const resolution = resolveRemoteSnapshot("orders", OTHER, "develop", LISTING);

  assert.deepEqual(resolution, { repo: "orders", asked: OTHER, step: "explicit", consulted: [], sha: OTHER });
});

test("an explicit branch the listing does not state is revision-unavailable, never another branch", () => {
  const resolution = resolveRemoteSnapshot("orders", "release", "develop", LISTING);

  assert.deepEqual(resolution, { repo: "orders", asked: "release", step: "revision-unavailable", consulted: [{ branch: "release" }] });
});

test("the branch named like the trigger's line wins before the default branch", () => {
  const resolution = resolveRemoteSnapshot("orders", undefined, "develop", LISTING);

  assert.deepEqual(resolution, { repo: "orders", step: "trigger-line", consulted: [{ branch: "develop", sha: DEVELOP }], sha: DEVELOP });
});

test("with no branch named like the trigger's line, the remote's default branch is read", () => {
  const resolution = resolveRemoteSnapshot("orders", undefined, "release", LISTING);

  assert.deepEqual(resolution, {
    repo: "orders",
    step: "default-branch",
    consulted: [{ branch: "release" }, { branch: "main", sha: MAIN }],
    sha: MAIN,
  });
});

test("a listing with no default branch and no trigger-line match is revision-unavailable with the refs consulted", () => {
  const listing: RemoteListing = { branches: [{ name: "develop", sha: DEVELOP }] };

  assert.deepEqual(resolveRemoteSnapshot("orders", undefined, "release", listing), {
    repo: "orders",
    step: "revision-unavailable",
    consulted: [{ branch: "release" }],
  });
});

test("no trigger line and no default branch is revision-unavailable with nothing consulted", () => {
  assert.deepEqual(resolveRemoteSnapshot("orders", undefined, undefined, { branches: [] }), { repo: "orders", step: "revision-unavailable", consulted: [] });
});

test("a default branch the listing does not hold is revision-unavailable, never a missing sha", () => {
  const listing: RemoteListing = { branches: [{ name: "develop", sha: DEVELOP }], defaultBranch: "main" };

  assert.deepEqual(resolveRemoteSnapshot("orders", undefined, undefined, listing), {
    repo: "orders",
    step: "revision-unavailable",
    consulted: [{ branch: "main" }],
  });
});
