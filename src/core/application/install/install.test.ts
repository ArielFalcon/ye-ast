import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrustMode } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { FixedLayerAdmin, FixedLayerRefresh, FixedLayerRefreshFault } from "../../ports/fixed-layer-admin.port.ts";
import type { InstallRequest } from "../../ports/install.port.ts";
import type { LocalExclude, LocalExcludeFault } from "../../ports/local-exclude.port.ts";
import type { TrustRecordFault, TrustRecords } from "../../ports/trust-record.port.ts";
import type { Vcs, VcsFault } from "../../ports/vcs.port.ts";
import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";
import { FIXED_LAYER_DIRECTORY, type FixedLayerFault, type FixedLayerStore } from "../../ports/fixed-layer-store.port.ts";
import { WORKSPACE_MANIFEST_FILE } from "../../ports/workspace-defaults.port.ts";
import { IGNORED_LINES, createInstall } from "./install.ts";

const REQUEST: InstallRequest = { repo: "/work/shop", repoId: "shop", trust: "untrusted" };
const WRITTEN: FixedLayerRefresh = { outcome: "written", files: ["README.md", "entrypoints.json"] };

interface Setup {
  calls: string[];
  /** The files of the fixed layer the fake store holds, by name. */
  files: Map<string, string>;
  /** The files the fake store was asked to write, in order. */
  writes: string[];
  install: ReturnType<typeof createInstall>;
}

function setup(
  overrides: {
    head?: Result<string, VcsFault>;
    trust?: Result<void, TrustRecordFault>;
    exclude?: Result<readonly string[], LocalExcludeFault>;
    layer?: Result<FixedLayerRefresh, FixedLayerRefreshFault>;
    store?: Result<void, FixedLayerFault>;
    files?: Record<string, string>;
  } = {},
): Setup {
  const calls: string[] = [];
  const files = new Map(Object.entries(overrides.files ?? {}));
  const writes: string[] = [];
  const vcs = {
    resolveCommit: async (repo: string, revision: string) => {
      calls.push(`resolve ${repo} ${revision}`);
      return overrides.head ?? { ok: true, value: "a".repeat(40) };
    },
  } as unknown as Vcs;
  const trust: TrustRecords = {
    read: async () => ({ ok: true, value: undefined }),
    write: async (root: string, mode: TrustMode) => {
      calls.push(`trust ${root} ${mode}`);
      return overrides.trust ?? { ok: true, value: undefined };
    },
  };
  const exclude: LocalExclude = {
    ensure: async (repo, lines) => {
      calls.push(`exclude ${repo} ${lines.join(",")}`);
      return overrides.exclude ?? { ok: true, value: lines };
    },
  };
  const store: FixedLayerStore = {
    read: async (_root, name) => ({ ok: true, value: files.get(name) }),
    write: async (_root, name, content) => {
      writes.push(name);
      if (overrides.store !== undefined && !overrides.store.ok) return overrides.store;
      files.set(name, content);
      return { ok: true, value: undefined };
    },
  };
  const layer: FixedLayerAdmin = {
    refresh: async (request) => {
      calls.push(`layer ${request.repo} ${request.revision}`);
      return overrides.layer ?? { ok: true, value: WRITTEN };
    },
  };
  return { calls, files, writes, install: createInstall({ vcs, trust, exclude, store, layer }) };
}

function manifestOf(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

test("install checks the root, records the trust, excludes ye-ast's folders and then writes the fixed layer, in that order", async () => {
  const { calls, install } = setup();

  const result = await install.run({ ...REQUEST, trust: "trusted" });

  assert.deepEqual(calls, [`resolve /work/shop HEAD`, `trust /work/shop trusted`, `exclude /work/shop ${IGNORED_LINES.join(",")}`, `layer /work/shop HEAD`]);
  assert.deepEqual(result, { ok: true, value: { trust: "trusted", excluded: IGNORED_LINES, layer: WRITTEN } });
});

test("the excluded lines are exactly the two ye-ast folders", () => {
  assert.deepEqual(IGNORED_LINES, [".ye-ast/", ".ye-ast-graph/"]);
});

test("a path that is not a repository root records nothing and writes nothing", async () => {
  const fault: VcsFault = { kind: "not-repository-root", detail: "inside" };
  const { calls, install } = setup({ head: { ok: false, fault } });

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: false } });
  assert.deepEqual(calls, ["resolve /work/shop HEAD"]);
});

test("a trust record that cannot be written stops the install before the repository is touched and says nothing was recorded", async () => {
  const fault: TrustRecordFault = { kind: "unwritable", detail: "read-only" };
  const { calls, install } = setup({ trust: { ok: false, fault } });

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: false } });
  assert.equal(calls.some((call) => call.startsWith("exclude") || call.startsWith("layer")), false);
});

test("an exclude file that cannot be written stops the install before the fixed layer", async () => {
  const fault: LocalExcludeFault = { kind: "unwritable", detail: "denied" };
  const { calls, install } = setup({ exclude: { ok: false, fault } });

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: true } });
  assert.equal(calls.some((call) => call.startsWith("layer")), false);
});

test("a fixed layer that was not written is reported with its reason, not as a fault", async () => {
  const layer: FixedLayerRefresh = { outcome: "not-written", reason: "index-unavailable" };
  const { install } = setup({ layer: { ok: true, value: layer } });

  const result = await install.run(REQUEST);

  assert.deepEqual(result, { ok: true, value: { trust: "untrusted", excluded: IGNORED_LINES, layer } });
});

test("a fixed layer fault is the install's fault and says the trust was recorded", async () => {
  const fault: FixedLayerRefreshFault = { kind: "unwritable", detail: "disk full" };
  const { install } = setup({ layer: { ok: false, fault } });

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: true } });
});

test("install excludes the fixed layer and the index store the ports name", () => {
  assert.deepEqual([...IGNORED_LINES], [`${FIXED_LAYER_DIRECTORY}/`, `${INDEX_STORE_DIRECTORY}/`]);
});

test("install persists the manifest it was given, sorted and with the bytes a second run reproduces", async () => {
  const { files, install } = setup();
  const text = manifestOf({ gateways: [{ prefix: "users-api", repo: "shop-web" }, { prefix: "orders-api", repo: "shop" }], repos: [{ path: "/work/shop", id: "shop" }, { path: "../shop-web" }] });

  const result = await install.run({ ...REQUEST, workspace: { path: "/tmp/ws.json", text } });

  assert.deepEqual(result.ok && result.value.workspace, { outcome: "written" });
  const stored = files.get(WORKSPACE_MANIFEST_FILE);
  assert.ok(stored !== undefined);
  assert.deepEqual(JSON.parse(stored), {
    repos: [{ path: "../shop-web" }, { path: "/work/shop", id: "shop" }],
    gateways: [{ prefix: "orders-api", repo: "shop" }, { prefix: "users-api", repo: "shop-web" }],
  });
  assert.equal(stored, `${JSON.stringify(JSON.parse(stored), null, 2)}\n`);
});

test("a second install of the same workspace leaves the manifest unchanged, whatever order its file stated", async () => {
  const { files, writes, install } = setup();
  const first = manifestOf({ repos: [{ path: "/work/shop", id: "shop" }, { path: "../shop-web" }] });
  const second = manifestOf({ repos: [{ path: "../shop-web" }, { id: "shop", path: "/work/shop" }] });

  await install.run({ ...REQUEST, workspace: { path: "/tmp/ws.json", text: first } });
  const stored = files.get(WORKSPACE_MANIFEST_FILE);
  const again = await install.run({ ...REQUEST, workspace: { path: "/tmp/other.json", text: second } });

  assert.deepEqual(again.ok && again.value.workspace, { outcome: "unchanged" });
  assert.equal(files.get(WORKSPACE_MANIFEST_FILE), stored);
  assert.deepEqual(writes, [WORKSPACE_MANIFEST_FILE]);
});

test("a manifest that is not one stops the install before the first write and names the entry", async () => {
  const cases: [string, string | undefined][] = [
    [manifestOf({ repos: [] }), "repos"],
    [manifestOf({ repos: [{ path: "a" }], gateways: "orders-api" }), "gateways"],
    [manifestOf({ repos: [{ path: "" }] }), "repos[0].path"],
    [manifestOf({ repos: [{ path: "a", id: "" }] }), "repos[0].id"],
    [manifestOf({ repos: [{ path: "a", revision: "" }] }), "repos[0].revision"],
    [manifestOf({ repos: [{ path: "a" }], gateways: [{ prefix: "p" }] }), "gateways[0].repo"],
    [manifestOf({ repos: [{ path: "a" }], gateways: [{ prefix: "", repo: "r" }] }), "gateways[0].prefix"],
    [manifestOf({ repos: [{ path: "a" }], patterns: [] }), "patterns"],
    ["repos: []", undefined],
  ];
  for (const [text, entry] of cases) {
    const { calls, files, writes, install } = setup();

    const result = await install.run({ ...REQUEST, workspace: { path: "/tmp/ws.json", text } });

    assert.equal(result.ok, false, text);
    assert.equal(result.ok === false && result.fault.kind, "workspace-invalid", text);
    if (entry !== undefined) assert.ok(result.ok === false && result.fault.detail.includes(entry), entry);
    assert.deepEqual(calls, ["resolve /work/shop HEAD"], text);
    assert.deepEqual(writes, [], text);
    assert.equal(files.size, 0, text);
  }
});

test("without a manifest install never writes or removes one", async () => {
  const existing = manifestOf({ repos: [{ path: "../shop-web" }] });
  const { files, writes, install } = setup({ files: { [WORKSPACE_MANIFEST_FILE]: existing } });

  const result = await install.run(REQUEST);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.workspace, undefined);
  assert.equal(files.get(WORKSPACE_MANIFEST_FILE), existing);
  assert.deepEqual(writes, []);
});

test("a manifest that cannot be stored is the install's fault and says the trust was recorded", async () => {
  const fault: FixedLayerFault = { kind: "unwritable", detail: "disk full" };
  const { calls, install } = setup({ store: { ok: false, fault } });

  const result = await install.run({ ...REQUEST, workspace: { path: "/tmp/ws.json", text: manifestOf({ repos: [{ path: "../shop-web" }] }) } });

  assert.deepEqual(result, { ok: false, fault: { ...fault, trustRecorded: true } });
  assert.equal(calls.some((call) => call.startsWith("layer")), false);
});
