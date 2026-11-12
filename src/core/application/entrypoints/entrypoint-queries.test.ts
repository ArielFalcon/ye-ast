import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import { SCHEMA, sameIdentity, type Cut, type Finding } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { EntrypointExtractor, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { SourceReader } from "../../ports/source-reader.port.ts";
import type { CommitExport, ExportBudget, ExportedFile, ExportPlan, ExportStop, SkippedEntry, Vcs, VcsFault } from "../../ports/vcs.port.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { createSnapshotDataCache } from "../snapshot/snapshot-data-cache.ts";
import { declaredScope } from "../../domain/map/entrypoint-map.ts";
import { isPackageManifest } from "../../domain/languages/typescript.ts";
import { createEntrypointQueries, type EntrypointQueriesDeps } from "./entrypoint-queries.ts";
import { fakeLive, type FakeLive } from "../live/fake-live.testing.ts";
import type { LiveStaleNotice } from "../../ports/live-queries.port.ts";

const SHA = "a".repeat(40);
const REQUEST = { repo: "/work/checkout", repoId: "shop", revision: "main" };
const ABORTED = { ok: false, fault: { kind: "aborted", detail: "interrupted by the caller" } };

const BUDGET: ExportBudget = { maxEntries: 5000, maxBytes: 1 << 20 };

type ListedFile = Pick<ExportedFile, "path" | "blob">;

interface Setup {
  deps: EntrypointQueriesDeps;
  created: string[];
  removed: string[];
  readPaths: string[];
  plans: ExportPlan[];
}

interface Overrides {
  resolve?: Result<string, VcsFault>;
  exported?: Result<CommitExport, VcsFault>;
  onExport?: () => void;
  onRead?: () => void;
  files?: ListedFile[];
  skipped?: SkippedEntry[];
  stopped?: ExportStop;
  findings?: readonly Finding<HttpRoute>[];
  extract?: EntrypointExtractor["extract"];
  engines?: Record<string, string>;
  budget?: ExportBudget;
  trust?: TrustRecordReader;
  live?: FakeLive;
}

function setup(overrides: Overrides = {}): Setup {
  const created: string[] = [];
  const removed: string[] = [];
  const readPaths: string[] = [];
  const plans: ExportPlan[] = [];
  const vcs: Vcs = {
    resolveCommit: async () => overrides.resolve ?? { ok: true, value: SHA },
    remotes: async () => ({ ok: true, value: [] }),
    headBranch: async () => ({ ok: true, value: undefined }),
    canonicalRoot: async (repo) => ({ ok: true, value: repo }),
    repositoryName: async () => ({ ok: true, value: "shop" }),
    exportCommit: async (_repo, _sha, _destination, plan) => {
      plans.push(plan);
      overrides.onExport?.();
      const { stopped } = overrides;
      let reached = false;
      const files = (overrides.files ?? []).map((file): ExportedFile => {
        reached ||= file.path === stopped?.at;
        return { ...file, written: plan.write(file.path) && !reached };
      });
      return overrides.exported ?? { ok: true, value: { files, skipped: overrides.skipped ?? [], ...(stopped ? { stopped } : {}) } };
    },
  };
  const scratch: ScratchDirectory = {
    create: async () => {
      const path = `/scratch/${created.length}`;
      created.push(path);
      return path;
    },
    remove: async (path) => void removed.push(path),
  };
  const reader: SourceReader = {
    read: async (_root, paths) => {
      overrides.onRead?.();
      readPaths.push(...paths);
      return paths.map((path): SourceFile => ({ path, content: `class ${path}` }));
    },
  };
  const extractor: EntrypointExtractor = { extract: overrides.extract ?? (async () => ({ findings: overrides.findings ?? [], readingCuts: [] })) };
  const digest: Digest = { of: (text) => `digest(${text})` };
  const deps: EntrypointQueriesDeps = {
    vcs,
    scratch,
    reader,
    extractor,
    digest,
    matcher: { matches: (path, glob) => path.startsWith(glob.replace(/\*\*$/, "")) },
    producer: { name: "ye-ast", version: "9.9.9" },
    engines: overrides.engines ?? { "web-tree-sitter": "0.27.1" },
    budget: overrides.budget ?? BUDGET,
    ...(overrides.trust && { trust: overrides.trust }),
    ...(overrides.live && { live: overrides.live.deps }),
  };
  return { deps, created, removed, readPaths, plans };
}

function route(path: string, line: number): Finding<HttpRoute> {
  return {
    status: "complete",
    value: { kind: "http-route", name: `GET ${path}`, method: "GET", path, handler: { path: "src/Orders.java", symbol: "Orders.list", line },
      basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] },
    },
    evidence: [{ path: "src/Orders.java", line }],
  };
}

const ORDERS: ListedFile = { path: "src/Orders.java", blob: "b1" };
const README: ListedFile = { path: "README.md", blob: "b2" };
const BILLING: ListedFile = { path: "src/Billing.java", blob: "b4" };
const COMPONENT: ListedFile = { path: "src/app/home.component.ts", blob: "b10" };
const MANIFEST: ListedFile = { path: "package.json", blob: "b11" };

/**
 * The rule of the Angular extractor: a source it places in a project through the manifest above it answers a route,
 * and one it cannot place is an unknown item with reason `no-project` (S1).
 */
const angularRoutes: EntrypointExtractor["extract"] = async (files) => ({
  findings: files.some((file) => isPackageManifest(file.path)) ? [route("/home", 7)] : [{ status: "unknown", reason: "no-project", evidence: [{ path: COMPONENT.path, line: 1 }] }],
  readingCuts: [],
});

test("a resolve fault is returned typed and leaves no scratch directory behind", async () => {
  const { deps, created, removed } = setup({ resolve: { ok: false, fault: { kind: "unknown-revision", detail: "main" } } });
  const result = await createEntrypointQueries(deps).map(REQUEST);
  assert.deepEqual(result, { ok: false, fault: { kind: "unknown-revision", detail: "main" } });
  assert.deepEqual(removed, created);
});

test("an export fault is returned typed and the scratch directory is removed", async () => {
  const { deps, created, removed } = setup({ exported: { ok: false, fault: { kind: "git-failed", detail: "boom" } } });
  const result = await createEntrypointQueries(deps).map(REQUEST);
  assert.deepEqual(result, { ok: false, fault: { kind: "git-failed", detail: "boom" } });
  assert.equal(created.length, 1);
  assert.deepEqual(removed, created);
});

test("the scratch directory is removed when the extractor throws", async () => {
  const { deps, created, removed } = setup({
    extract: async () => {
      throw new Error("extractor crashed");
    },
  });
  await assert.rejects(createEntrypointQueries(deps).map(REQUEST), /extractor crashed/);
  assert.equal(created.length, 1);
  assert.deepEqual(removed, created);
});

test("the scratch directory is removed after a successful map", async () => {
  const { deps, created, removed } = setup({ files: [ORDERS] });
  const result = await createEntrypointQueries(deps).map(REQUEST);
  assert.equal(result.ok, true);
  assert.equal(created.length, 1);
  assert.deepEqual(removed, created);
});

test("the export is asked to write only the in-scope sources, build files and Spring config files, within the host's budget, and the map reads what was written", async () => {
  const pom: ListedFile = { path: "services/orders/pom.xml", blob: "b6" };
  const gradle: ListedFile = { path: "build.gradle.kts", blob: "b7" };
  const config: ListedFile = { path: "src/main/resources/application.yml", blob: "b8" };
  const { deps, readPaths, plans } = setup({ files: [README, ORDERS, pom, gradle, config, { path: "src/Notes.txt", blob: "b3" }, { path: "src/Billing.kt", blob: "b5" }] });
  await createEntrypointQueries(deps).map(REQUEST);
  assert.equal(plans.length, 1);
  const [plan] = plans;
  assert.deepEqual(
    ["src/Orders.java", "README.md", "src/Notes.txt", "src/Billing.kt", pom.path, gradle.path, "docs/pom.xml.orig", config.path, "src/test/resources/application.yml"].filter(plan!.write),
    ["src/Orders.java", pom.path, gradle.path, config.path],
  );
  assert.deepEqual(plan!.budget, BUDGET);
  assert.deepEqual(readPaths, ["src/Orders.java", pom.path, gradle.path, config.path]);
});

test("an export stopped by the host's budget makes the section partial with a caller-budget cut and reads only what was written", async () => {
  const { deps, readPaths } = setup({ files: [ORDERS, BILLING], stopped: { at: BILLING.path, limit: 7 } });

  const result = await createEntrypointQueries(deps).map(REQUEST);

  assert.ok(result.ok && result.value.status === "partial");
  assert.deepEqual(result.value.cuts, [{ kind: "section", at: ["entrypoints"], reason: "section-partial", reach: { kind: "anything" } }]);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [{ kind: "caller-budget", at: [BILLING.path], limit: 7, reason: "export-budget", reach: { kind: "anything" } }]);
  assert.deepEqual(readPaths, ["src/Orders.java"]);
});

test("a narrowed map preserves an export budget cut outside the selection and reads only written sources", async () => {
  const selected = { path: "src/app/owners/routes.ts", blob: "b1" };
  const context = { path: "src/app/pets/routes.ts", blob: "b2" };
  const stopped = { path: "src/app/root.ts", blob: "b3" };
  const { deps, readPaths } = setup({ files: [selected, context, stopped], stopped: { at: stopped.path, limit: 7 } });
  const result = await createEntrypointQueries(deps).map({ ...REQUEST, scope: { include: ["src/app/owners/**"] } });

  assert.ok(result.ok && result.value.status === "partial");
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [{ kind: "caller-budget", at: [stopped.path], limit: 7, reason: "export-budget", reach: { kind: "anything" } }]);
  assert.deepEqual(readPaths, [selected.path, context.path]);
});

test("a narrowed map preserves a skipped routing source cut outside the selection", async () => {
  const skipped = "src/app/pets/link.ts";
  const { deps } = setup({ files: [{ path: "src/app/owners/list.ts", blob: "owner" }], skipped: [{ path: skipped, reason: "symlink" }] });
  const result = await createEntrypointQueries(deps).map({ ...REQUEST, scope: { include: ["src/app/owners/**"] } });
  assert.ok(result.ok);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.ok(section.cuts.some((cut) => cut.kind === "not-exported" && cut.at[0] === skipped));
});

test("the export budget is a profile value of the fact: another budget is another config digest", async () => {
  async function configOf(budget: ExportBudget): Promise<string> {
    const result = await createEntrypointQueries(setup({ files: [ORDERS], budget }).deps).map(REQUEST);
    assert.ok(result.ok);
    return result.value.inputs.config;
  }

  const base = await configOf({ maxEntries: 10, maxBytes: 20 });

  assert.equal(await configOf({ maxEntries: 10, maxBytes: 20 }), base);
  assert.notEqual(await configOf({ maxEntries: 11, maxBytes: 20 }), base);
  assert.notEqual(await configOf({ maxEntries: 10, maxBytes: 21 }), base);
});

test("the map states the scope it covers beside the digest of that scope, on the composite and on its section", async () => {
  const { deps } = setup({ files: [ORDERS], findings: [route("/orders", 12)] });

  const result = await createEntrypointQueries(deps).map(REQUEST);

  assert.ok(result.ok && result.value.status === "complete");
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "complete");
  for (const fact of [result.value, section]) {
    assert.deepEqual(fact.inputs.declaredScope, { languages: ["java", "typescript"], frameworks: ["angular", "spring"], include: [], exclude: [] });
    assert.equal(fact.inputs.scope, deps.digest.of(JSON.stringify(fact.inputs.declaredScope)));
  }
});

test("an item carries only what can differ per item, never the base of the collection", async () => {
  const unresolved: Finding<HttpRoute> = {
    status: "unknown",
    reason: "unresolved",
    evidence: [{ path: "src/Orders.java", line: 30 }],
  };
  const served = route("/orders", 12);
  const { deps } = setup({
    files: [ORDERS],
    findings: [served, unresolved],
    engines: { "web-tree-sitter": "0.27.1", "tree-sitter-java": "0.23.5" },
  });

  const result = await createEntrypointQueries(deps).map(REQUEST);

  assert.ok(result.ok && result.value.status === "complete");
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "complete");
  assert.deepEqual(section.value, [served, unresolved]);
  assert.deepEqual(Object.keys(section.value[0]!).toSorted(), ["evidence", "status", "value"]);
  assert.deepEqual(Object.keys(section.value[1]!).toSorted(), ["evidence", "reason", "status"]);
  for (const fact of [result.value, section]) {
    assert.equal(fact.schema, SCHEMA);
    assert.deepEqual(fact.snapshot, { repo: "shop", kind: "sha", sha: SHA });
    assert.deepEqual(fact.producer, { name: "ye-ast", version: "9.9.9" });
    assert.equal(fact.inputs.trust, "untrusted");
    assert.deepEqual(Object.keys(fact.inputs.engines), ["tree-sitter-java", "web-tree-sitter"]);
  }
});

test("a submodule or an in-scope entry that was not exported cuts the section; an out-of-scope one does not", async () => {
  const skipped: SkippedEntry[] = [
    { path: "services/orders", reason: "submodule" },
    { path: "docs/diagram.png", reason: "collision" },
    { path: "src/Linked.java", reason: "symlink" },
  ];
  const { deps } = setup({ files: [ORDERS], skipped });

  const result = await createEntrypointQueries(deps).map(REQUEST);

  assert.ok(result.ok && result.value.status === "partial");
  assert.deepEqual(result.value.cuts, [{ kind: "section", at: ["entrypoints"], reason: "section-partial", reach: { kind: "anything" } }]);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [
    { kind: "not-exported", at: ["services/orders"], reason: "submodule", reach: { kind: "anything" } },
    { kind: "not-exported", at: ["src/Linked.java"], reason: "symlink", reach: { kind: "anything" } },
  ]);

  const unreadBuildFile = setup({ files: [ORDERS], skipped: [{ path: "services/orders/pom.xml", reason: "symlink" }] });
  const cut = await createEntrypointQueries(unreadBuildFile.deps).map(REQUEST);
  assert.ok(cut.ok && cut.value.status === "partial");

  const outOfScopeOnly = setup({ files: [ORDERS], skipped: [{ path: "docs/diagram.png", reason: "collision" }] });
  const complete = await createEntrypointQueries(outOfScopeOnly.deps).map(REQUEST);
  assert.ok(complete.ok && complete.value.status === "complete");
});

test("the content digest follows the in-scope blobs and ignores the rest", async () => {
  async function contentOf(files: ListedFile[]): Promise<string> {
    const result = await createEntrypointQueries(setup({ files }).deps).map(REQUEST);
    assert.ok(result.ok);
    return result.value.inputs.content;
  }

  const base = await contentOf([ORDERS, README]);
  assert.notEqual(await contentOf([{ ...ORDERS, blob: "b1-changed" }, README]), base);
  assert.equal(await contentOf([ORDERS, { ...README, blob: "b2-changed" }]), base);
  assert.equal(await contentOf([BILLING, ORDERS]), await contentOf([ORDERS, BILLING]));
});

async function contentOfExport(overrides: Overrides): Promise<string> {
  const result = await createEntrypointQueries(setup(overrides).deps).map(REQUEST);
  assert.ok(result.ok);
  return result.value.inputs.content;
}

test("the content digest covers the path and blob of every build file, which can declare a source generator", async () => {
  const pom: ListedFile = { path: "pom.xml", blob: "p1" };
  const base = await contentOfExport({ files: [ORDERS, pom] });

  assert.notEqual(await contentOfExport({ files: [ORDERS] }), base);
  assert.notEqual(await contentOfExport({ files: [ORDERS, { ...pom, blob: "p2" }] }), base);
  assert.notEqual(await contentOfExport({ files: [ORDERS, { ...pom, path: "api/pom.xml" }] }), base);
  assert.notEqual(await contentOfExport({ files: [ORDERS, { path: "build.gradle", blob: "p1" }] }), base);
});

test("the content digest covers the path and blob of every Spring config file, which declares the base path", async () => {
  const config: ListedFile = { path: "src/main/resources/application.yml", blob: "c1" };
  const base = await contentOfExport({ files: [ORDERS, config] });

  assert.notEqual(await contentOfExport({ files: [ORDERS] }), base);
  assert.notEqual(await contentOfExport({ files: [ORDERS, { ...config, blob: "c2" }] }), base);
});

test("the content digest covers the path and blob of every unsupported JVM source, which produces a cut, and not of a test source", async () => {
  const kotlin: ListedFile = { path: "src/main/kotlin/Billing.kt", blob: "k1" };
  const base = await contentOfExport({ files: [ORDERS] });

  assert.notEqual(await contentOfExport({ files: [ORDERS, kotlin] }), base);
  assert.notEqual(await contentOfExport({ files: [ORDERS, { ...kotlin, blob: "k2" }] }), await contentOfExport({ files: [ORDERS, kotlin] }));
  assert.notEqual(await contentOfExport({ files: [ORDERS, { ...kotlin, path: "src/main/kotlin/Shipping.kt" }] }), await contentOfExport({ files: [ORDERS, kotlin] }));
  assert.equal(await contentOfExport({ files: [ORDERS, { path: "src/test/kotlin/BillingTest.kt", blob: "k1" }] }), base);
});

test("the content digest covers every skipped entry with its reason", async () => {
  const submodule: SkippedEntry = { path: "services/orders", reason: "submodule" };
  const base = await contentOfExport({ files: [ORDERS] });

  assert.notEqual(await contentOfExport({ files: [ORDERS], skipped: [submodule] }), base);
  assert.notEqual(await contentOfExport({ files: [ORDERS], skipped: [{ ...submodule, reason: "symlink" }] }), await contentOfExport({ files: [ORDERS], skipped: [submodule] }));
  assert.notEqual(await contentOfExport({ files: [ORDERS], skipped: [{ path: "docs/logo.png", reason: "collision" }] }), base);
});

test("the content digest covers where a budget stopped the export", async () => {
  const stoppedAt = (at: string) => contentOfExport({ files: [ORDERS], stopped: { at, limit: 5 } });

  assert.notEqual(await stoppedAt("a.txt"), await contentOfExport({ files: [ORDERS] }));
  assert.notEqual(await stoppedAt("a.txt"), await stoppedAt("b.txt"));
});

test("the content digest does not depend on the order of the export's lists and cannot be forged by a path that mimics another entry", async () => {
  const kotlin: ListedFile = { path: "src/main/kotlin/Billing.kt", blob: "k1" };
  const skipped: SkippedEntry[] = [
    { path: "a", reason: "symlink" },
    { path: "b", reason: "submodule" },
  ];

  assert.equal(
    await contentOfExport({ files: [ORDERS, kotlin, BILLING], skipped }),
    await contentOfExport({ files: [kotlin, BILLING, ORDERS], skipped: skipped.toReversed() }),
  );
  assert.notEqual(
    await contentOfExport({ files: [ORDERS], skipped: [{ path: "q", reason: "symlink" }, { path: "r", reason: "symlink" }] }),
    await contentOfExport({ files: [ORDERS], skipped: [{ path: "q\u0000symlink\nskipped\u0000r", reason: "symlink" }] }),
  );
});

test("facts of commits whose cuts differ never carry the same inputs (RFC-0002 rule 5)", async () => {
  const kotlin: ListedFile = { path: "src/main/kotlin/Billing.kt", blob: "k1" };
  const submodule: SkippedEntry = { path: "services/orders", reason: "submodule" };
  const commits: Overrides[] = [{ files: [ORDERS] }, { files: [ORDERS, kotlin] }, { files: [ORDERS, kotlin], skipped: [submodule] }];

  const facts = [];
  for (const commit of commits) {
    const result = await createEntrypointQueries(setup(commit).deps).map(REQUEST);
    assert.ok(result.ok);
    facts.push(result.value);
  }

  assert.deepEqual(facts.map((fact) => fact.status), ["complete", "partial", "partial"]);
  assert.equal(new Set(facts.map((fact) => fact.inputs.content)).size, 3);
});

test("two runs over the same repository and revision give deep-equal facts", async () => {
  const run = () =>
    createEntrypointQueries(setup({ files: [ORDERS], findings: [route("/orders", 12)] }).deps).map(REQUEST);
  assert.deepEqual(await run(), await run());
});

test("a source file of a JVM language without an extractor cuts the section, outside test files and build logic", async () => {
  const unsupported = ["src/main/Orders.kt", "tools/Run.kts", "src/main/Orders.groovy", "src/main/Orders.scala"];
  const exempt = [
    "src/test/kotlin/Fixtures.kt",
    "build.gradle.kts",
    "settings.gradle.kts",
    "buildSrc/src/main/kotlin/Versions.kt",
    "services/orders/buildSrc/build.gradle.kts",
    "docs/Orders.kt.md",
  ];
  const files = [ORDERS, ...[...unsupported, ...exempt].map((path, index) => ({ path, blob: `k${index}` }))];
  const { deps } = setup({ files, skipped: [{ path: "src/Linked.java", reason: "symlink" }] });

  const result = await createEntrypointQueries(deps).map(REQUEST);

  assert.ok(result.ok && result.value.status === "partial");
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [
    { kind: "not-exported", at: ["src/Linked.java"], reason: "symlink", reach: { kind: "anything" } },
    ...unsupported.toSorted().map((path) => ({ kind: "no-extractor", at: [path], reason: "language", reach: { kind: "anything" } })),
  ]);
});

test("an abort that arrives during the export, the read or the extraction answers aborted and removes the scratch directory", async () => {
  const stages = ["onExport", "onRead", "extract"] as const;
  for (const stage of stages) {
    const interrupt = new AbortController();
    const abort = () => interrupt.abort();
    const { deps, created, removed, readPaths } = setup({
      files: [ORDERS],
      ...(stage === "extract" ? { extract: async () => (abort(), { findings: [], readingCuts: [] }) } : { [stage]: abort }),
    });
    const extracted: string[] = [];
    const inner = deps.extractor.extract;
    deps.extractor = { extract: async (files) => (extracted.push(stage), inner(files)) };

    const result = await createEntrypointQueries(deps).map({ ...REQUEST, signal: interrupt.signal });

    assert.deepEqual(result, ABORTED, stage);
    assert.deepEqual(removed, created, stage);
    assert.equal(created.length, 1, stage);
    assert.deepEqual(extracted, stage === "extract" ? ["extract"] : [], stage);
    assert.deepEqual(readPaths, stage === "onExport" ? [] : ["src/Orders.java"], stage);
  }
});

test("the caller's signal reaches the version control port, which stops the git child", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const { deps } = setup();
  const interrupt = new AbortController();
  deps.vcs = {
    resolveCommit: async (_repo, _revision, signal) => (seen.push(signal), { ok: true, value: SHA }),
    remotes: async () => ({ ok: true, value: [] }),
    headBranch: async () => ({ ok: true, value: undefined }),
    canonicalRoot: async (repo) => ({ ok: true, value: repo }),
    repositoryName: async () => ({ ok: true, value: "shop" }),
    exportCommit: async (_repo, _sha, _destination, _plan, signal) => (seen.push(signal), { ok: true, value: { files: [], skipped: [] } }),
  };

  await createEntrypointQueries(deps).map({ ...REQUEST, signal: interrupt.signal });

  assert.deepEqual(seen, [interrupt.signal, interrupt.signal]);
});

test("an excluded path is not written, hashed or cut, and an included one beside it still is", async () => {
  const script: ListedFile = { path: "web/static/app.js", blob: "b9" };
  const { deps, plans } = setup({ files: [ORDERS, script, { path: "web/static/Static.java", blob: "b8" }], skipped: [{ path: "web/static/Link.java", reason: "symlink" }] });
  const queries = createEntrypointQueries(deps);

  const open = await queries.map(REQUEST);
  const scoped = await queries.map({ ...REQUEST, scope: { exclude: ["web/static/**"] } });

  assert.ok(open.ok && scoped.ok);
  assert.ok(open.value.status === "partial" && scoped.value.status === "complete");
  assert.equal(plans[1]!.write("web/static/Static.java"), false);
  assert.equal(plans[1]!.write(ORDERS.path), true);
  assert.notEqual(scoped.value.inputs.content, open.value.inputs.content);
});

test("an include leaves every path it does not match outside the scope", async () => {
  const { deps, plans } = setup({ files: [ORDERS, BILLING] });

  const result = await createEntrypointQueries(deps).map({ ...REQUEST, scope: { include: ["src/Orders"] } });

  assert.ok(result.ok);
  assert.equal(plans[0]!.write(ORDERS.path), true);
  assert.equal(plans[0]!.write(BILLING.path), false);
});

test("the requested scope is declared sorted in the fact and its digest covers it", async () => {
  const { deps } = setup({ files: [ORDERS, { path: "src/a/file.ts", blob: "a" }, { path: "src/b/file.ts", blob: "b" }] });
  const queries = createEntrypointQueries(deps);

  const open = await queries.map(REQUEST);
  const scoped = await queries.map({ ...REQUEST, scope: { include: ["src/b/**", "src/a/**"], exclude: ["src/a/gen/**"] } });

  assert.ok(open.ok && scoped.ok);
  assert.deepEqual(scoped.value.inputs.declaredScope.include, ["src/a/**", "src/b/**"]);
  assert.deepEqual(scoped.value.inputs.declaredScope.exclude, ["src/a/gen/**"]);
  assert.equal(scoped.value.inputs.scope, deps.digest.of(JSON.stringify(scoped.value.inputs.declaredScope)));
  assert.deepEqual(open.value.inputs.declaredScope, declaredScope());
  assert.notEqual(scoped.value.inputs.scope, open.value.inputs.scope);
});

test("the fact records the mode the trust record declares for the repository, and untrusted when there is none or the record is unusable", async () => {
  const asked: string[] = [];
  const declared: TrustRecordReader = { read: async (root) => (asked.push(root), { ok: true, value: "trusted" }) };
  const undeclared: TrustRecordReader = { read: async () => ({ ok: true, value: undefined }) };
  const unusable: TrustRecordReader = { read: async () => ({ ok: false, fault: { kind: "refused", detail: "open to others" } }) };

  const trusted = await createEntrypointQueries(setup({ trust: declared }).deps).map(REQUEST);
  const without = await createEntrypointQueries(setup({ trust: undeclared }).deps).map(REQUEST);
  const refused = await createEntrypointQueries(setup({ trust: unusable }).deps).map(REQUEST);
  const absent = await createEntrypointQueries(setup().deps).map(REQUEST);

  assert.ok(trusted.ok && without.ok && refused.ok && absent.ok);
  assert.deepEqual(asked, [REQUEST.repo]);
  assert.deepEqual([trusted.value.inputs.trust, without.value.inputs.trust, refused.value.inputs.trust, absent.value.inputs.trust], ["trusted", "untrusted", "untrusted", "untrusted"]);
});

const TRUSTED: TrustRecordReader = { read: async () => ({ ok: true, value: "trusted" }) };
const LIVE_REQUEST = { repo: "/work/checkout", repoId: "shop", live: true } as const;
const DIGEST: Digest = { of: (text) => `digest(${text})` };

test("a live map under untrusted is refused as a typed fault before anything is listed, locked, exported or read", async () => {
  const live = fakeLive({ "src/Orders.java": "b1" }, DIGEST);
  for (const trust of [undefined, { read: async () => ({ ok: true, value: "untrusted" }) } satisfies TrustRecordReader]) {
    const { deps, created, readPaths, plans } = setup({ live, ...(trust && { trust }) });

    const answer = await createEntrypointQueries(deps).map(LIVE_REQUEST);

    assert.equal(!answer.ok && answer.fault.kind, "live-requires-trusted");
    assert.match(!answer.ok ? answer.fault.detail : "", /ye-ast init --trust trusted/);
    assert.deepEqual([live.calls, created, readPaths, plans], [[], [], [], []]);
  }
});

test("a live map without live deps is refused like an untrusted one", async () => {
  const answer = await createEntrypointQueries(setup({ trust: TRUSTED }).deps).map(LIVE_REQUEST);

  assert.equal(!answer.ok && answer.fault.kind, "live-requires-trusted");
});

function entrypointsOf(fact: { value: { entrypoints: { status: string; value?: unknown } } }): unknown[] {
  const section = fact.value.entrypoints;
  return Array.isArray(section.value) ? section.value.map((item: { status: string; value?: unknown }) => item.value) : [];
}

test("a live map reads the mirror's files and no store; its snapshot is HEAD plus the stateId, which is the content digest of the same files at a sha", async () => {
  const live = fakeLive({ "src/Orders.java": "b1", "README.md": "b2" }, DIGEST);
  const { deps, readPaths } = setup({ trust: TRUSTED, live, files: [ORDERS, README], findings: [route("/orders", 3)] });
  const queries = createEntrypointQueries(deps);

  const answer = await queries.map(LIVE_REQUEST);
  const atSha = await queries.map(REQUEST);

  assert.ok(answer.ok && atSha.ok);
  assert.deepEqual(answer.value.snapshot, { repo: "shop", kind: "live", head: SHA, stateId: atSha.value.inputs.content });
  assert.equal(answer.value.inputs.content, atSha.value.inputs.content);
  assert.deepEqual(entrypointsOf(answer.value), entrypointsOf(atSha.value));
  assert.notDeepEqual(entrypointsOf(answer.value), []);
  assert.deepEqual(answer.value.inputs.declaredScope, { ...declaredScope(), ignored: "git" });
  assert.equal("index" in answer.value.inputs, false);
  assert.equal(live.builds, 0);
  assert.deepEqual(readPaths, ["src/Orders.java", "src/Orders.java"]);
  assert.deepEqual(live.held, { locks: 1, released: 1 });
});

test("a live map whose lock is still held at the deadline answers aborted, and a throwing extractor still releases the lock", async () => {
  const held = fakeLive({ "src/Orders.java": "b1" }, DIGEST);
  held.engine.lock = { ok: false, fault: { kind: "aborted", detail: "waiting" } };
  const waited = await createEntrypointQueries(setup({ trust: TRUSTED, live: held }).deps).map(LIVE_REQUEST);
  assert.equal(!waited.ok && waited.fault.kind, "aborted");

  const thrown = fakeLive({ "src/Orders.java": "b1" }, DIGEST);
  const { deps } = setup({ trust: TRUSTED, live: thrown, extract: async () => Promise.reject(new Error("boom")) });
  await assert.rejects(createEntrypointQueries(deps).map(LIVE_REQUEST), /boom/);
  assert.deepEqual(thrown.held, { locks: 1, released: 1 });
});

test("a live map reports the paths that changed while it was answered", async () => {
  const live = fakeLive({ "src/Orders.java": "b1" }, DIGEST);
  const notices: LiveStaleNotice[] = [];
  const { deps } = setup({ trust: TRUSTED, live, files: [ORDERS], extract: async () => (live.tree.set("src/Orders.java", "b2"), { findings: [], readingCuts: [] }) });

  const answer = await createEntrypointQueries(deps).map({ ...LIVE_REQUEST, onStale: (notice) => notices.push(notice) });

  assert.ok(answer.ok);
  assert.deepEqual(notices.map((notice) => notice.changed), [["src/Orders.java"]]);
  assert.equal(notices[0]?.stateId, answer.value.snapshot.kind === "live" ? answer.value.snapshot.stateId : "");
});

test("an include reads the configuration that interprets the sources it selects, at a revision and on the live tree", async () => {
  const atRevision = await createEntrypointQueries(setup({ files: [COMPONENT, MANIFEST], extract: angularRoutes }).deps).map({ ...REQUEST, scope: { include: ["src/**"] } });
  const live = fakeLive({ [COMPONENT.path]: COMPONENT.blob, [MANIFEST.path]: MANIFEST.blob }, DIGEST);
  const onLive = await createEntrypointQueries(setup({ trust: TRUSTED, live, files: [COMPONENT, MANIFEST], extract: angularRoutes }).deps).map({ ...LIVE_REQUEST, scope: { include: ["src/**"] } });

  for (const answer of [atRevision, onLive]) {
    assert.ok(answer.ok);
    const section = answer.value.value.entrypoints;
    assert.ok(section.status === "complete");
    assert.deepEqual(section.value.map((item) => item.status), ["complete"]);
  }
});

test("a narrowed map reads routing context but reports only selected findings and reading cuts", async () => {
  const owner = "src/app/owners/routes.ts";
  const other = "src/app/pets/routes.ts";
  const root = "src/app/app.routes.ts";
  const files = [owner, other, root].map((path, index) => ({ path, blob: `b${index}` }));
  const cut = (path: string): Cut => ({ kind: "unresolved-link", at: [path], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } });
  const extract: EntrypointExtractor["extract"] = async (sources) => ({
    findings: sources.some((file) => file.path === root) ? [
      { ...route("/owners", 1), evidence: [{ path: owner, line: 1 }] },
      { ...route("/pets", 1), evidence: [{ path: other, line: 1 }] },
    ] : [],
    readingCuts: [cut(other)],
  });
  const scope = { include: ["src/app/owners/**"] };
  const live = fakeLive(Object.fromEntries(files.map(({ path, blob }) => [path, blob])), DIGEST);
  const revision = await createEntrypointQueries(setup({ files, extract }).deps).map({ ...REQUEST, scope });
  const current = await createEntrypointQueries(setup({ files, extract, live, trust: TRUSTED }).deps).map({ ...LIVE_REQUEST, scope });
  for (const result of [revision, current]) {
    assert.ok(result.ok);
    const section = result.value.value.entrypoints;
    assert.equal(section.status, "complete");
    assert.deepEqual(entrypointsOf(result.value).map((item) => (item as HttpRoute).path), ["/owners"]);
  }
});

test("a narrowed map never reads excluded TypeScript routing context", async () => {
  const selected = { path: "src/app/owners/routes.ts", blob: "b1" };
  const excluded = { path: "src/app/private/routes.ts", blob: "b2" };
  const { deps, readPaths } = setup({ files: [selected, excluded] });
  const result = await createEntrypointQueries(deps).map({ ...REQUEST, scope: { include: ["src/app/owners/**"], exclude: ["src/app/private/**"] } });
  assert.ok(result.ok);
  assert.deepEqual(readPaths, [selected.path]);
});

test("a map retains only located findings and reading cuts in scope without mutating extraction", async () => {
  const inside = "src/app/owners/routes.ts";
  const outside = "src/app/pets/routes.ts";
  const findings = [
    { ...route("/owners", 1), evidence: [{ path: inside, line: 1 }] },
    { ...route("/pets", 1), evidence: [{ path: outside, line: 1 }] },
    { ...route("/unknown", 1), evidence: [] },
  ];
  const cut = (at: string[]): Cut => ({ kind: "unresolved-link", at, reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } });
  const cuts = [cut([inside]), cut([outside]), cut([])];
  const original = structuredClone({ findings, cuts });
  const { deps } = setup({ files: [{ path: inside, blob: "b1" }], extract: async () => ({ findings, readingCuts: cuts }) });
  const result = await createEntrypointQueries(deps).map({ ...REQUEST, scope: { include: ["src/app/owners/**"] } });
  assert.ok(result.ok);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [cuts[0]]);
  assert.deepEqual(entrypointsOf(result.value).map((item) => (item as HttpRoute).path), ["/owners"]);
  assert.deepEqual({ findings, cuts }, original);
});

test("an exclude leaves the configuration out, so the sources it interprets are unknown", async () => {
  const { deps, plans } = setup({ files: [COMPONENT, MANIFEST], extract: angularRoutes });

  const result = await createEntrypointQueries(deps).map({ ...REQUEST, scope: { exclude: [MANIFEST.path] } });

  assert.ok(result.ok);
  assert.equal(plans[0]!.write(MANIFEST.path), false);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "complete");
  assert.deepEqual(section.value.map((item) => item.status), ["unknown"]);
});

test("a live map over an unchanged capture reads and extracts once, an edit misses, and a hit answers what a miss answers", async () => {
  const live = fakeLive({ "src/Orders.java": "b1" }, DIGEST);
  let extractions = 0;
  const { deps, readPaths } = setup({ live, trust: TRUSTED, files: [ORDERS], extract: async () => (extractions++, { findings: [route("/orders", 3)], readingCuts: [] }) });
  deps.snapshotCache = createSnapshotDataCache(1 << 20);
  const queries = createEntrypointQueries(deps);
  const ask = () => queries.map({ repo: REQUEST.repo, repoId: REQUEST.repoId, live: true });

  const miss = await ask();
  const hit = await ask();
  assert.ok(miss.ok && hit.ok);
  assert.deepEqual([extractions, readPaths.length], [1, 1]);
  assert.equal(canonicalJson(hit.value), canonicalJson(miss.value));

  live.tree.set("src/Orders.java", "b9");
  const edited = await ask();
  assert.ok(edited.ok);
  assert.deepEqual([extractions, readPaths.length], [2, 2]);
  assert.notEqual(edited.value.inputs.content, miss.value.inputs.content);
  assert.ok((await ask()).ok);
  assert.equal(extractions, 2);
  assert.deepEqual(live.held, { locks: 4, released: 4 });
});

test("a live map under another scope does not reuse the data retained for the first", async () => {
  const live = fakeLive({ "src/Orders.java": "b1" }, DIGEST);
  let extractions = 0;
  const { deps } = setup({ live, trust: TRUSTED, files: [ORDERS], extract: async () => (extractions++, { findings: [], readingCuts: [] }) });
  deps.snapshotCache = createSnapshotDataCache(1 << 20);
  const queries = createEntrypointQueries(deps);
  const live1 = { repo: REQUEST.repo, repoId: REQUEST.repoId, live: true } as const;
  assert.ok((await queries.map(live1)).ok);
  assert.ok((await queries.map({ ...live1, scope: { exclude: ["docs/**"] } })).ok);
  assert.equal(extractions, 2);
});

test("a live map cancelled during extraction publishes nothing", async () => {
  const live = fakeLive({ "src/Orders.java": "b1" }, DIGEST);
  const controller = new AbortController();
  let extractions = 0;
  const { deps } = setup({ live, trust: TRUSTED, files: [ORDERS], extract: async () => (extractions++, controller.abort(), { findings: [], readingCuts: [] }) });
  deps.snapshotCache = createSnapshotDataCache(1 << 20);
  const queries = createEntrypointQueries(deps);
  const cancelled = await queries.map({ repo: REQUEST.repo, repoId: REQUEST.repoId, live: true, signal: controller.signal });
  assert.ok(!cancelled.ok && cancelled.fault.kind === "aborted");
  assert.ok((await queries.map({ repo: REQUEST.repo, repoId: REQUEST.repoId, live: true })).ok);
  assert.equal(extractions, 2);
  assert.ok((await queries.map({ repo: REQUEST.repo, repoId: REQUEST.repoId, live: true })).ok);
  assert.equal(extractions, 2);
});

test("a reading cut the extractor reports makes the entrypoints section partial, with that cut and no item", async () => {
  const frontier: Cut = { kind: "unresolved-link", at: ["src/app/app.routes.ts", "src/app/app.routes.ts:4"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } };
  const { deps } = setup({ files: [COMPONENT, MANIFEST], extract: async () => ({ findings: [], readingCuts: [frontier] }) });

  const result = await createEntrypointQueries(deps).map(REQUEST);

  assert.ok(result.ok);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [frontier]);
  assert.deepEqual(section.value, []);
});

test("a reading cut the extractor reports twice at one place is one cut of the section", async () => {
  const frontier: Cut = { kind: "unresolved-link", at: ["src/app/app.routes.ts", "src/app/app.routes.ts:4"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } };
  const { deps } = setup({ files: [COMPONENT, MANIFEST], extract: async () => ({ findings: [], readingCuts: [frontier, { ...frontier }] }) });

  const result = await createEntrypointQueries(deps).map(REQUEST);

  assert.ok(result.ok);
  assert.deepEqual(result.value.value.entrypoints.status === "partial" ? result.value.value.entrypoints.cuts : undefined, [frontier]);
});

test("a cached snapshot keeps its reading cuts: the next map of the same commit is partial with the same cut", async () => {
  const frontier: Cut = { kind: "unresolved-link", at: ["src/app/app.routes.ts", "src/app/app.routes.ts:4"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } };
  let extractions = 0;
  const { deps } = setup({ files: [COMPONENT, MANIFEST], extract: async () => (extractions++, { findings: [], readingCuts: [frontier] }) });
  deps.snapshotCache = createSnapshotDataCache(1 << 20);
  const queries = createEntrypointQueries(deps);

  await queries.map(REQUEST);
  const second = await queries.map(REQUEST);

  assert.equal(extractions, 1);
  const section = second.ok ? second.value.value.entrypoints : undefined;
  assert.ok(section?.status === "partial");
  assert.deepEqual(section.cuts, [frontier]);
});

test("scope includes distinguish a missing selection from a partial match", async () => {
  const { deps } = setup({ files: [{ path: "src/app.ts", blob: "a" }, { path: "tsconfig.json", blob: "b" }] });
  const queries = createEntrypointQueries(deps);
  const missing = await queries.map({ ...REQUEST, scope: { include: ["missing/**"] } });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.fault.kind, "unknown-scope-path");
  const mixed = await queries.map({ ...REQUEST, scope: { include: ["src/**", "missing/**"] } });
  assert.equal(mixed.ok, true);
  if (mixed.ok) {
    assert.deepEqual(mixed.value.scopeSelection, { unmatchedIncludes: ["missing/**"], selectedFiles: 1 });
    const otherNotice = { ...mixed.value, scopeSelection: { unmatchedIncludes: ["other/**"], selectedFiles: 9 } };
    assert.ok(sameIdentity(mixed.value, otherNotice));
  }
});

test("scope validation counts skipped paths, excludes paths, and cannot decide a stopped listing", async () => {
  const skipped = setup({ skipped: [{ path: "src/link.ts", reason: "symlink" }] });
  const held = await createEntrypointQueries(skipped.deps).map({ ...REQUEST, scope: { include: ["src/**"] } });
  assert.equal(held.ok, true);
  const excluded = await createEntrypointQueries(skipped.deps).map({ ...REQUEST, scope: { include: ["src/**"], exclude: ["src/**"] } });
  assert.equal(excluded.ok, false);
  const stopped = setup({ files: [{ path: "src/a.ts", blob: "a" }], stopped: { at: "src/a.ts", limit: 1 } });
  const undecided = await createEntrypointQueries(stopped.deps).map({ ...REQUEST, scope: { include: ["missing/**"] } });
  assert.equal(undecided.ok, true);
});

test("live scope notice follows each capture including a retained hit", async () => {
  const live = fakeLive({ "src/a.ts": "a" }, DIGEST);
  const { deps } = setup({ trust: TRUSTED, live });
  const queries = createEntrypointQueries(deps);
  const request = { ...LIVE_REQUEST, scope: { include: ["src/**", "other/**"] } };
  const first = await queries.map(request);
  const hit = await queries.map(request);
  assert.ok(first.ok && hit.ok);
  assert.deepEqual(first.value.scopeSelection, { unmatchedIncludes: ["other/**"], selectedFiles: 1 });
  assert.deepEqual(hit.value.scopeSelection, first.value.scopeSelection);
  live.tree.set("other/b.ts", "b");
  const changed = await queries.map(request);
  assert.ok(changed.ok);
  assert.equal(changed.value.scopeSelection, undefined);
});
