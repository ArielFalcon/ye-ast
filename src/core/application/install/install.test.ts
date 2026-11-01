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
import { FIXED_LAYER_DIRECTORY } from "../../ports/fixed-layer-store.port.ts";
import { IGNORED_LINES, createInstall } from "./install.ts";

const REQUEST: InstallRequest = { repo: "/work/shop", repoId: "shop", trust: "untrusted" };
const WRITTEN: FixedLayerRefresh = { outcome: "written", files: ["README.md", "entrypoints.json"] };

interface Setup {
  calls: string[];
  install: ReturnType<typeof createInstall>;
}

function setup(
  overrides: { head?: Result<string, VcsFault>; trust?: Result<void, TrustRecordFault>; exclude?: Result<readonly string[], LocalExcludeFault>; layer?: Result<FixedLayerRefresh, FixedLayerRefreshFault> } = {},
): Setup {
  const calls: string[] = [];
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
  const layer: FixedLayerAdmin = {
    refresh: async (request) => {
      calls.push(`layer ${request.repo} ${request.revision}`);
      return overrides.layer ?? { ok: true, value: WRITTEN };
    },
  };
  return { calls, install: createInstall({ vcs, trust, exclude, layer }) };
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
