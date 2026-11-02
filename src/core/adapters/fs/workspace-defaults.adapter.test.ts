import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FIXED_LAYER_DIRECTORY, type FixedLayerFault } from "../../ports/fixed-layer-store.port.ts";
import { WORKSPACE_MANIFEST_FILE, type WorkspaceManifest } from "../../ports/workspace-defaults.port.ts";
import { createFixedLayerStore } from "./fixed-layer-store.adapter.ts";
import { createWorkspaceDefaults } from "./workspace-defaults.adapter.ts";

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-workspace-defaults-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  counter += 1;
  return join(scratch, `root-${counter}`);
}

async function withManifest(content: string): Promise<string> {
  const root = await freshRoot();
  await createFixedLayerStore().write(root, WORKSPACE_MANIFEST_FILE, content);
  return root;
}

function valueOf(result: { ok: true; value: WorkspaceManifest | undefined } | { ok: false; fault: FixedLayerFault }): WorkspaceManifest | undefined {
  assert.equal(result.ok, true);
  return result.ok ? result.value : undefined;
}

test("a relative repository path is resolved against the repository root and an absolute one is kept", async () => {
  const root = await withManifest(JSON.stringify({ repos: [{ path: "../shop-web" }, { path: "/work/shop" }], gateways: [{ prefix: "orders-api", repo: "shop" }] }));

  const manifest = valueOf(await createWorkspaceDefaults(createFixedLayerStore()).of(root));

  assert.deepEqual(manifest?.repos.map(({ path }) => path), [resolve(root, "../shop-web"), "/work/shop"]);
  assert.deepEqual(manifest?.gateways, [{ prefix: "orders-api", repo: "shop" }]);
});

test("a repository that persists no manifest answers undefined", async () => {
  assert.deepEqual(await createWorkspaceDefaults(createFixedLayerStore()).of(await freshRoot()), { ok: true, value: undefined });
});

test("a stored file that is not a manifest is a fault that names the file, never an empty workspace", async () => {
  for (const content of ["repos: []", JSON.stringify({ repos: [] }), JSON.stringify({ repos: [{ path: "a" }], patterns: [] })]) {
    const root = await withManifest(content);

    const result = await createWorkspaceDefaults(createFixedLayerStore()).of(root);

    assert.equal(result.ok, false, content);
    assert.equal(result.ok === false && result.fault.kind, "unreadable", content);
    assert.ok(result.ok === false && result.fault.detail.includes(`${FIXED_LAYER_DIRECTORY}/${WORKSPACE_MANIFEST_FILE}`), content);
  }
});
