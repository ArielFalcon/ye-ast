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
    onTrust?: (root: string) => void;
    onLayer?: (root: string) => void;
    onStoreRead?: (root: string) => void;
    onStoreWrite?: (root: string) => void;
    onCanonical?: (root: string) => void;
    canonicalResult?: (root: string) => Result<string, VcsFault> | undefined;
    onResolve?: (root: string) => void;
    onDefaults?: () => void;
    writeTrust?: (root: string, mode: TrustMode) => Result<void, TrustRecordFault>;
    ensureExclude?: (root: string) => Result<readonly string[], LocalExcludeFault>;
    head?: Result<string, VcsFault>;
    trust?: Result<void, TrustRecordFault>;
    exclude?: Result<readonly string[], LocalExcludeFault>;
    layer?: Result<FixedLayerRefresh, FixedLayerRefreshFault>;
    store?: Result<void, FixedLayerFault>;
    files?: Record<string, string>;
    /** The repositories the declaration names that the filesystem cannot read. */
    unreadable?: readonly string[];
  } = {},
): Setup {
  const calls: string[] = [];
  const files = new Map(Object.entries(overrides.files ?? {}));
  const writes: string[] = [];
  const vcs = {
    canonicalRoot: async (repo: string) => { calls.push(`canonical ${repo}`); overrides.onCanonical?.(repo); return overrides.canonicalResult?.(repo) ?? { ok: true, value: repo === "/alias/a" ? "/work/a" : repo }; },
    resolveCommit: async (repo: string, revision: string) => {
      calls.push(`resolve ${repo} ${revision}`);
      overrides.onResolve?.(repo);
      if (overrides.unreadable?.includes(repo) === true) return { ok: false, value: undefined, fault: { kind: "not-repository-root", detail: `${repo} is inside its repository` } };
      return overrides.head ?? { ok: true, value: "a".repeat(40) };
    },
  } as unknown as Vcs;
  const trust: TrustRecords = {
    read: async () => ({ ok: true, value: undefined }),
    write: async (root: string, mode: TrustMode) => {
      calls.push(`trust ${root} ${mode}`);
      overrides.onTrust?.(root);
      return overrides.writeTrust?.(root, mode) ?? overrides.trust ?? { ok: true, value: undefined };
    },
  };
  const exclude: LocalExclude = {
    ensure: async (repo, lines) => {
      calls.push(`exclude ${repo} ${lines.join(",")}`);
      return overrides.ensureExclude?.(repo) ?? overrides.exclude ?? { ok: true, value: lines };
    },
  };
  const store: FixedLayerStore = {
    read: async (root, name) => { overrides.onStoreRead?.(root); return { ok: true, value: files.get(name) }; },
    write: async (root, name, content) => {
      writes.push(name);
      overrides.onStoreWrite?.(root);
      if (overrides.store !== undefined && !overrides.store.ok) return overrides.store;
      files.set(name, content);
      return { ok: true, value: undefined };
    },
  };
  const layer: FixedLayerAdmin = {
    refresh: async (request) => {
      calls.push(`layer ${request.repo} ${request.revision}`);
      overrides.onLayer?.(request.repo);
      return overrides.layer ?? { ok: true, value: WRITTEN };
    },
  };
  return { calls, files, writes, install: createInstall({ vcs, trust, exclude, store, layer, defaults: { resolve: (_root, manifest) => { overrides.onDefaults?.(); return manifest; } } }) };
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

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: false, stage: "preflight" } });
  assert.deepEqual(calls, ["resolve /work/shop HEAD"]);
});

test("a trust record that cannot be written stops the install before the repository is touched and says nothing was recorded", async () => {
  const fault: TrustRecordFault = { kind: "unwritable", detail: "read-only" };
  const { calls, install } = setup({ trust: { ok: false, fault } });

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: false, stage: "trust" } });
  assert.equal(calls.some((call) => call.startsWith("exclude") || call.startsWith("layer")), false);
});

test("an exclude file that cannot be written stops the install before the fixed layer", async () => {
  const fault: LocalExcludeFault = { kind: "unwritable", detail: "denied" };
  const { calls, install } = setup({ exclude: { ok: false, fault } });

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: true, stage: "exclude" } });
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

  assert.deepEqual(await install.run(REQUEST), { ok: false, fault: { ...fault, trustRecorded: true, stage: "layer" } });
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
    [manifestOf({ repos: [{ path: "a", remote: "" }] }), "repos[0].remote"],
    [manifestOf({ repos: [{ path: "a", remote: "not a url" }] }), "repos[0].remote"],
    [manifestOf({ repos: [{ path: "a", remote: "https://" }] }), "repos[0].remote"],
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

test("a declaration whose repository the filesystem cannot read stops the install before the first write and names the entry", async () => {
  const { calls, files, writes, install } = setup({ unreadable: ["/work/orders"] });
  const text = manifestOf({ repos: [{ path: "/work/shop" }, { path: "/work/orders" }] });

  const result = await install.run({ ...REQUEST, workspace: { path: "/tmp/ws.json", text } });

  assert.deepEqual(result, { ok: false, fault: { kind: "not-repository-root", detail: "repos[0].path: /work/orders is inside its repository", trustRecorded: false, stage: "preflight" } });
  assert.deepEqual(calls, ["resolve /work/shop HEAD", "resolve /work/orders HEAD"]);
  assert.deepEqual(writes, []);
  assert.equal(files.size, 0);
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

  assert.deepEqual(result, { ok: false, fault: { ...fault, trustRecorded: true, stage: "workspace" } });
  assert.equal(calls.some((call) => call.startsWith("layer")), false);
});

test("batch coalesces aliases and installs selected roots in canonical order", async () => {
  const { calls, install } = setup();
  const report = await install.runBatch({ launch: { path: "/work/z", id: "z" }, repositories: [{ path: "/work/z", id: "z" }, { path: "/work/a", id: "a" }, { path: "/alias/a", id: "a" }], trust: "trusted" });
  assert.deepEqual(report.targets.map((target) => [target.id, target.status, target.requestedPaths]), [["a", "completed", ["/work/a", "/alias/a"]], ["z", "completed", ["/work/z"]]]);
  assert.deepEqual(calls.filter((call) => call.startsWith("trust ")), ["trust /work/a trusted", "trust /work/z trusted"]);
});


test("batch rejects both identity collisions before any writes", async () => {
  for (const repositories of [
    [{ path: "/work/a", id: "a" }, { path: "/work/z", id: "a" }],
    [{ path: "/work/a", id: "a" }, { path: "/alias/a", id: "z" }],
  ]) {
    const { calls, install } = setup();
    const report = await install.runBatch({ launch: repositories[0]!, repositories, trust: "untrusted" });
    assert.equal(report.targets.some((t) => t.fault?.kind === (repositories[1]!.path === "/work/z" ? "duplicate-repository-id" : "conflicting-repository-alias")), true);
    assert.equal(calls.some((c) => c.startsWith("trust ")), false);
  }
});

test("batch validates launch workspace before any writes and never enrolls its members", async () => {
  const { calls, install } = setup({ unreadable: ["/work/member"] });
  const report = await install.runBatch({ launch: { path: "/work/a", id: "a" }, repositories: [{ path: "/work/a", id: "a" }, { path: "/work/z", id: "z" }], trust: "trusted", workspace: { path: "ws", text: manifestOf({ repos: [{ path: "/work/member" }] }) } });
  assert.equal(report.targets.find((t) => t.id === "a")?.status, "failed");
  assert.equal(report.targets.find((t) => t.id === "z")?.status, "not-attempted");
  assert.equal(calls.some((c) => c.startsWith("trust ")), false);
});

test("batch stops after cancellation between targets", async () => {
  const controller = new AbortController();
  const { calls, install } = setup({ onLayer: () => controller.abort() });
  const report = await install.runBatch({ launch: { path: "/work/a", id: "a" }, repositories: [{ path: "/work/a", id: "a" }, { path: "/work/z", id: "z" }], trust: "trusted", signal: controller.signal });
  assert.equal(report.termination, "aborted");
  assert.deepEqual(report.targets.map((t) => t.status), ["completed", "not-attempted"]);
  assert.deepEqual(calls.filter((c) => c.startsWith("trust ")), ["trust /work/a trusted"]);
});

test("batch preserves unexpected uncertainty and stops after prior outcomes", async () => {
  const { install } = setup({ onTrust: (root) => { if (root === "/work/z") throw new Error("unexpected"); } });
  const report = await install.runBatch({ launch: { path: "/work/a", id: "a" }, repositories: [{ path: "/work/a", id: "a" }, { path: "/work/z", id: "z" }, { path: "/work/zz", id: "zz" }], trust: "trusted" });
  assert.equal(report.termination, "unexpected");
  assert.deepEqual(report.targets.map((t) => [t.status, t.trust]), [["completed", "recorded"], ["failed", "unknown"], ["not-attempted", "not-recorded"]]);
});


test("batch continues after ordinary trust and exclude failures with truthful recording", async () => {
  for (const [overrides, expected] of [
    [{ trust: { ok: false, fault: { kind: "unwritable", detail: "denied" } } }, "not-recorded"],
    [{ exclude: { ok: false, fault: { kind: "unwritable", detail: "denied" } } }, "recorded"],
  ] as const) {
    const { calls, install } = setup(overrides);
    const report = await install.runBatch({ launch: { path: "/work/a", id: "a" }, repositories: [{ path: "/work/a", id: "a" }, { path: "/work/z", id: "z" }], trust: "untrusted" });
    assert.deepEqual(report.targets.map((t) => [t.status, t.trust]), [["failed", expected], ["failed", expected]]);
    assert.equal(calls.filter((c) => c.startsWith("trust ")).length, 2);
  }
});

test("batch keeps a not-written layer outcome and applies the manifest only to launch", async () => {
  const layer: FixedLayerRefresh = { outcome: "not-written", reason: "index-unavailable" };
  const { install, writes } = setup({ layer: { ok: true, value: layer } });
  const report = await install.runBatch({ launch: { path: "/work/z", id: "z" }, repositories: [{ path: "/work/a", id: "a" }, { path: "/work/z", id: "z" }], trust: "untrusted", workspace: { path: "ws", text: manifestOf({ repos: [{ path: "/work/member" }] }) } });
  assert.deepEqual(report.targets.map((t) => t.outcome?.layer), [layer, layer]);
  assert.equal(report.targets[0]?.outcome?.workspace, undefined);
  assert.deepEqual(report.targets[1]?.outcome?.workspace, { outcome: "written" });
  assert.deepEqual(writes, [WORKSPACE_MANIFEST_FILE]);
});

const THREE = [{ path: "/work/a", id: "a" }, { path: "/work/b", id: "b" }, { path: "/work/c", id: "c" }];

test("preflight exceptions identify the active target and preserve every selection", async () => {
  for (const step of ["canonical", "head", "launch", "defaults", "member"] as const) {
    let launchCalls = 0;
    const { calls, writes, install } = setup({
      onCanonical: (root) => { if ((step === "launch" && root === "/work/a" && ++launchCalls === 1) || (step === "canonical" && root === "/work/b")) throw new Error("unexpected"); },
      onResolve: (root) => { if ((step === "head" && root === "/work/b") || (step === "member" && root === "/work/member")) throw new Error("unexpected"); },
      onDefaults: () => { if (step === "defaults") throw new Error("unexpected"); },
    });
    const report = await install.runBatch({ launch: THREE[0]!, repositories: THREE, trust: "trusted", workspace: { path: "ws", text: manifestOf({ repos: [{ path: "/work/member" }] }) } });
    assert.equal(report.termination, "unexpected", step);
    assert.deepEqual(report.targets.map((t) => t.id), ["a", "b", "c"], step);
    assert.deepEqual(report.targets.map((t) => [t.status, t.trust, t.stage]), (step === "canonical" || step === "head") ? [["not-attempted", "not-recorded", undefined], ["failed", "not-recorded", "preflight"], ["not-attempted", "not-recorded", undefined]] : [["failed", "not-recorded", "preflight"], ["not-attempted", "not-recorded", undefined], ["not-attempted", "not-recorded", undefined]], step);
    assert.equal(calls.some((c) => /^(trust|exclude|layer) /.test(c)), false, step);
    assert.deepEqual(writes, [], step);
  }
});

test("preflight stops calls on pre-abort and after successful awaited cancellation", async () => {
  for (const step of ["pre", "canonical", "head", "member"] as const) {
    const controller = new AbortController();
    if (step === "pre") controller.abort();
    const { calls, install } = setup({
      onCanonical: (root) => { if (step === "canonical" && root === "/work/b") controller.abort(); },
      onResolve: (root) => { if ((step === "head" && root === "/work/b") || (step === "member" && root === "/work/member")) controller.abort(); },
    });
    const report = await install.runBatch({ launch: THREE[0]!, repositories: THREE, trust: "trusted", signal: controller.signal, workspace: { path: "ws", text: manifestOf({ repos: [{ path: "/work/member" }, { path: "/work/other" }] }) } });
    assert.equal(report.termination, "aborted", step);
    assert.deepEqual(report.targets.map((t) => t.id), ["a", "b", "c"], step);
    assert.ok(report.targets.every((t) => t.status === "not-attempted" && t.trust === "not-recorded"), step);
    assert.equal(calls.some((c) => /^(trust|exclude|layer) /.test(c)), false, step);
    if (step === "pre") assert.deepEqual(calls, []);
    if (step === "canonical") assert.equal(calls.includes("canonical /work/c"), false);
    if (step === "head") assert.equal(calls.includes("resolve /work/c HEAD"), false);
    if (step === "member") assert.equal(calls.includes("resolve /work/other HEAD"), false);
  }
});

test("launch mismatch and overlapping identity conflicts prevent all writes", async () => {
  for (const [launch, repositories] of [
    [{ path: "/work/missing", id: "missing" }, THREE],
    [{ path: "/work/a", id: "wrong" }, THREE],
    [THREE[0]!, [{ path: "/work/a", id: "a" }, { path: "/alias/a", id: "b" }, { path: "/work/b", id: "b" }]],
  ] as const) {
    const { calls, install } = setup();
    const report = await install.runBatch({ launch, repositories, trust: "trusted" });
    assert.ok(report.targets.some((t) => t.status === "failed"));
    if (repositories.length === 3 && repositories[1]?.path === "/alias/a") {
      assert.ok(report.targets.some((t) => t.fault?.kind === "conflicting-repository-alias"));
      assert.ok(report.targets.some((t) => t.fault?.kind === "duplicate-repository-id"));
    }
    assert.equal(calls.some((c) => /^(trust|exclude|layer) /.test(c)), false);
  }
});

test("batch replaces only explicitly selected trust records in both directions", async () => {
  const records = new Map<string, TrustMode>([["/work/a", "untrusted"], ["/work/b", "trusted"], ["/work/member", "trusted"], ["/work/other", "untrusted"]]);
  const writes: [string, TrustMode][] = [];
  const { install } = setup({ writeTrust: (root, mode) => { writes.push([root, mode]); records.set(root, mode); return { ok: true, value: undefined }; } });
  const request = { launch: THREE[0]!, repositories: THREE.slice(0, 2), workspace: { path: "ws", text: manifestOf({ repos: [{ path: "/work/member" }] }) } };
  for (const mode of ["trusted", "untrusted", "untrusted"] as const) {
    const report = await install.runBatch({ ...request, trust: mode });
    assert.ok(report.targets.every((t) => t.status === "completed" && t.trust === "recorded"));
    assert.deepEqual([...records], [["/work/a", mode], ["/work/b", mode], ["/work/member", "trusted"], ["/work/other", "untrusted"]]);
  }
  assert.deepEqual(writes, [["/work/a", "trusted"], ["/work/b", "trusted"], ["/work/a", "untrusted"], ["/work/b", "untrusted"], ["/work/a", "untrusted"], ["/work/b", "untrusted"]]);
});

test("batch retains distinct per-root failures and completes later selections", async () => {
  const records = new Map<string, TrustMode>();
  const { calls, install } = setup({
    writeTrust: (root, mode) => {
      if (root === "/work/a") return { ok: false, fault: { kind: "unwritable", detail: "trust" } };
      records.set(root, mode);
      return { ok: true, value: undefined };
    },
    ensureExclude: (root) => root === "/work/b" ? { ok: false, fault: { kind: "unwritable", detail: "exclude" } } : { ok: true, value: IGNORED_LINES },
  });
  const report = await install.runBatch({ launch: THREE[0]!, repositories: THREE, trust: "trusted" });
  assert.deepEqual(report.targets.map((t) => [t.id, t.status, t.trust, t.stage, t.fault && "trustRecorded" in t.fault ? t.fault.trustRecorded : undefined]), [
    ["a", "failed", "not-recorded", "trust", false], ["b", "failed", "recorded", "exclude", true], ["c", "completed", "recorded", undefined, undefined],
  ]);
  assert.deepEqual([...records], [["/work/b", "trusted"], ["/work/c", "trusted"]]);
  assert.deepEqual(calls.filter((c) => c.startsWith("trust ")), ["trust /work/a trusted", "trust /work/b trusted", "trust /work/c trusted"]);
  assert.deepEqual(report.targets[2]?.outcome, { trust: "trusted", excluded: IGNORED_LINES, layer: WRITTEN });
});


test("launch canonical fault is attributed without losing selected targets", async () => {
  const { calls, install } = setup({ canonicalResult: (root) => root === "/work/a" ? { ok: false, fault: { kind: "not-repository-root", detail: "invalid" } } : undefined });
  const report = await install.runBatch({ launch: THREE[0]!, repositories: THREE, trust: "trusted" });
  assert.deepEqual(report.targets.map((t) => [t.id, t.status, t.trust, t.stage]), [["a", "failed", "not-recorded", "preflight"], ["b", "not-attempted", "not-recorded", undefined], ["c", "not-attempted", "not-recorded", undefined]]);
  assert.equal(report.targets[0]?.fault?.kind, "not-repository-root");
  assert.equal(calls.some((c) => /^(trust|exclude|layer) /.test(c)), false);
});

test("cancellation during the final successful execution is reported", async () => {
  const controller = new AbortController();
  const { install } = setup({ onLayer: () => controller.abort() });
  const report = await install.runBatch({ launch: THREE[0]!, repositories: [THREE[0]!], trust: "trusted", signal: controller.signal });
  assert.equal(report.targets[0]?.status, "completed");
  assert.equal(report.termination, "aborted");
});

test("batch cancellation during execution HEAD revalidation starts no writes", async () => {
  const controller = new AbortController();
  let launchReads = 0;
  const { calls, writes, install } = setup({
    onResolve: (root) => { if (root === "/work/a" && ++launchReads === 2) controller.abort(); },
  });
  const report = await install.runBatch({ launch: THREE[0]!, repositories: THREE, trust: "trusted", signal: controller.signal });

  assert.equal(report.termination, "aborted");
  assert.deepEqual(report.targets.map(({ status, trust, stage }) => [status, trust, stage]), [
    ["failed", "not-recorded", "preflight"],
    ["not-attempted", "not-recorded", undefined],
    ["not-attempted", "not-recorded", undefined],
  ]);
  assert.equal(report.targets[0]?.fault?.kind, "aborted");
  assert.deepEqual(calls, ["canonical /work/a", "canonical /work/a", "canonical /work/b", "canonical /work/c", "resolve /work/a HEAD", "resolve /work/b HEAD", "resolve /work/c HEAD", "resolve /work/a HEAD"]);
  assert.deepEqual(writes, []);
});

test("batch cancellation after a completed port call prevents later side effects", async () => {
  for (const step of ["trust", "exclude", "workspace-read", "workspace-write"] as const) {
    const controller = new AbortController();
    const { calls, writes, files, install } = setup({
      onTrust: () => { if (step === "trust") controller.abort(); },
      ensureExclude: () => {
        if (step === "exclude") controller.abort();
        return { ok: true, value: IGNORED_LINES };
      },
      onStoreRead: () => { if (step === "workspace-read") controller.abort(); },
      onStoreWrite: () => { if (step === "workspace-write") controller.abort(); },
    });
    const report = await install.runBatch({ launch: THREE[0]!, repositories: THREE, trust: "trusted", signal: controller.signal, workspace: { path: "ws", text: manifestOf({ repos: [{ path: "/work/member" }] }) } });

    assert.equal(report.termination, "aborted", step);
    assert.deepEqual(report.targets.map(({ status, trust }) => [status, trust]), [["failed", "recorded"], ["not-attempted", "not-recorded"], ["not-attempted", "not-recorded"]], step);
    assert.equal(report.targets[0]?.fault?.kind, "aborted", step);
    assert.equal(report.targets[0]?.stage, step.startsWith("workspace") ? "workspace" : step, step);
    assert.deepEqual(calls.filter((call) => call.startsWith("trust ")), ["trust /work/a trusted"], step);
    assert.equal(calls.some((call) => call.startsWith("exclude ")), step !== "trust", step);
    assert.equal(calls.some((call) => call.startsWith("layer ")), false, step);
    assert.deepEqual(writes, step === "workspace-write" ? [WORKSPACE_MANIFEST_FILE] : [], step);
    assert.equal(files.has(WORKSPACE_MANIFEST_FILE), step === "workspace-write", step);
  }
});
