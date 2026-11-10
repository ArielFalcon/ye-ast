import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vcs } from "../../ports/vcs.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import { planWorkspace } from "./workspace-plan.ts";

const sha = "a".repeat(40);
const remote = "https://example.invalid/lib";
function setup() {
  let refreshes = 0;
  let trustReads = 0;
  let declarationBytes = "";
  const vcs = {
    remotes: async () => ({ ok: true, value: [] }),
    headBranch: async () => ({ ok: true, value: "main" }),
    resolveCommit: async () => ({ ok: true, value: sha }),
  } as unknown as Vcs;
  const defaults: WorkspaceDefaults = { of: async () => ({ ok: true, value: { repos: [{ path: "/lib", id: "lib", remote }] } }), resolve: (_root, manifest) => manifest };
  const deps = {
    vcs, defaults,
    trust: { read: async () => { trustReads++; return { ok: true as const, value: "trusted" as const }; } },
    digest: { of: (value: string) => { declarationBytes = value; let hash = 0n; for (const char of value) hash = (hash * 131n + BigInt(char.codePointAt(0)!)) % (1n << 256n); return hash.toString(16).padStart(64, "0"); } },
    refresh: { refresh: async () => { refreshes++; return [{ url: remote, freshness: { status: "unverified" as const, reason: "failed" as const }, mirror: "/mirror", listing: { branches: [] } }]; } },
  };
  return { deps, counts: () => ({ refreshes, trustReads }), bytes: () => declarationBytes };
}
const request = { repo: { path: "/app", id: "app" }, repos: [{ path: "/lib", id: "lib", live: true }] };
const plan = (deps: ReturnType<typeof setup>["deps"], value: unknown) => planWorkspace(deps, value as WorkspaceRequest);

test("live choice stays local and its authorized remote is not refreshed", async () => {
  const s = setup();
  const result = await plan(s.deps, request);
  assert.ok(result.ok);
  assert.deepEqual(result.value.plans[1], { kind: "live", repoId: "lib", declared: "/lib" });
  assert.equal(result.value.membership.source, "request");
  assert.deepEqual(result.value.asked[1], request.repos[0]);
  assert.match(s.bytes(), /"live":true/);
  assert.match(s.bytes(), /example.invalid/);
  assert.equal(s.counts().refreshes, 0);
});

test("invalid private choices fail before trust and refresh", async () => {
  for (const member of [{ path: "" }, { path: "/lib", id: " " }, { path: "/lib", remote: "" }, { path: "/lib", revision: "" }, { path: "/lib", live: false }, { path: "/lib", live: true, revision: "main" }]) {
    const s = setup();
    const result = await plan(s.deps, { repo: request.repo, repos: [member] });
    assert.equal(result.ok, false);
    assert.deepEqual(s.counts(), { refreshes: 0, trustReads: 0 });
  }
});

test("live replay retains fresh-capture expectation and rejects kind mismatch before refresh", async () => {
  const s = setup();
  const first = await plan(s.deps, request);
  assert.ok(first.ok);
  const replay = { version: 1, declaration: first.value.declaration, snapshots: [{ repo: "app", kind: "sha", sha }, { repo: "lib", kind: "live", head: sha, stateId: "state" }] };
  const again = await plan(s.deps, { ...request, replay });
  assert.ok(again.ok);
  assert.deepEqual(again.value.plans[1], { kind: "live", repoId: "lib", declared: "/lib", expected: { repo: "lib", kind: "live", head: sha, stateId: "state" } });
  assert.deepEqual(again.value.plans[0], { kind: "read", at: { source: "/app", declared: "/app", repoId: "app", revision: sha } });
  assert.equal(again.value.membership.source, "request");
  const mismatch = await plan(s.deps, { ...request, replay: { ...replay, snapshots: [replay.snapshots[0], { repo: "lib", kind: "sha", sha }] } });
  assert.equal(mismatch.ok, false);
  assert.equal(s.counts().refreshes, 0);
});

test("committed declaration fingerprint bytes retain their existing format", async () => {
  const s = setup();
  const result = await plan(s.deps, { repo: { path: "/app", id: "app" }, repos: [{ path: "/lib", id: "lib", revision: "main" }], offline: true });
  assert.ok(result.ok);
  assert.equal(s.bytes(), '{"gateways":[],"members":[{"remote":"https://example.invalid/lib","repo":"lib","revision":"main"}],"source":"request","trigger":"app"}');
});


test("trigger live choice changes the declaration and preserves persisted membership", async () => {
  const s = setup();
  const committed = await plan(s.deps, { repo: { path: "/app", id: "app" }, offline: true });
  const live = await plan(s.deps, { repo: { path: "/app", id: "app", live: true }, offline: true });
  assert.ok(committed.ok && live.ok);
  assert.notEqual(live.value.declaration, committed.value.declaration);
  assert.equal(live.value.membership.source, "persisted");
  assert.deepEqual(live.value.plans[0], { kind: "live", repoId: "app", declared: "/app" });
  assert.equal(live.value.plans[1]?.kind, "read");
});

test("replay kind mismatch stops before an otherwise authorized refresh", async () => {
  const s = setup();
  const selection = { repo: { path: "/app", id: "app", live: true }, repos: [{ path: "/lib", id: "lib" }] };
  const first = await plan(s.deps, { ...selection, offline: true });
  assert.ok(first.ok);
  const result = await plan(s.deps, { ...selection, replay: { version: 1, declaration: first.value.declaration, snapshots: [{ repo: "app", kind: "sha", sha }, { repo: "lib", kind: "sha", sha }] } });
  assert.equal(result.ok, false);
  assert.equal(s.counts().refreshes, 0);
});

test("duplicate-repository names the colliding repos entries", async () => {
  const a = { path: "/a", id: "a" };
  const b = { path: "/b", id: "b" };
  for (const [repo, repos, entries, fromLaunch] of [
    [request.repo, [a, a], [0, 1], false],
    [a, [b, a, { path: "/a2", id: "other" }], [1], true],
  ] as const) {
    const result = await plan(setup().deps, { repo, repos });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.fault, { kind: "duplicate-repository", detail: `${fromLaunch ? "the launch repository and repos[1]" : "repos[0] and repos[1]"} name repository ` + "`a`", repo: "a", entries, fromLaunch });
  }
  const s = setup();
  s.deps.defaults.of = async () => ({ ok: true, value: { repos: [a, a] } });
  const persisted = await plan(s.deps, { repo: request.repo });
  assert.equal(persisted.ok, false);
  if (!persisted.ok) assert.deepEqual(persisted.fault, { kind: "duplicate-repository", detail: "repository `a` is listed twice among the persisted members", repo: "a", entries: [], fromLaunch: false });
});
