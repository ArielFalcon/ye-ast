import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import { SCHEMA, type Finding } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { EntrypointExtractor, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { SourceReader } from "../../ports/source-reader.port.ts";
import type { CommitExport, ExportBudget, ExportedFile, ExportPlan, ExportStop, SkippedEntry, Vcs, VcsFault } from "../../ports/vcs.port.ts";
import { declaredScope } from "../../domain/map/entrypoint-map.ts";
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
  const extractor: EntrypointExtractor = { extract: overrides.extract ?? (async () => overrides.findings ?? []) };
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
  assert.deepEqual(result.value.cuts, [{ kind: "section", at: ["entrypoints"] }]);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [{ kind: "caller-budget", at: [BILLING.path], limit: 7 }]);
  assert.deepEqual(readPaths, ["src/Orders.java"]);
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
  assert.deepEqual(result.value.cuts, [{ kind: "section", at: ["entrypoints"] }]);
  const section = result.value.value.entrypoints;
  assert.ok(section.status === "partial");
  assert.deepEqual(section.cuts, [
    { kind: "not-exported", at: ["services/orders"] },
    { kind: "not-exported", at: ["src/Linked.java"] },
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
    { kind: "not-exported", at: ["src/Linked.java"] },
    ...unsupported.toSorted().map((path) => ({ kind: "no-extractor", at: [path] })),
  ]);
});

test("an abort that arrives during the export, the read or the extraction answers aborted and removes the scratch directory", async () => {
  const stages = ["onExport", "onRead", "extract"] as const;
  for (const stage of stages) {
    const interrupt = new AbortController();
    const abort = () => interrupt.abort();
    const { deps, created, removed, readPaths } = setup({
      files: [ORDERS],
      ...(stage === "extract" ? { extract: async () => (abort(), []) } : { [stage]: abort }),
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
  const { deps } = setup({ files: [ORDERS] });
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
    assert.match(!answer.ok ? answer.fault.detail : "", /ye-ast install --trust trusted/);
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
  const { deps } = setup({ trust: TRUSTED, live, files: [ORDERS], extract: async () => (live.tree.set("src/Orders.java", "b2"), []) });

  const answer = await createEntrypointQueries(deps).map({ ...LIVE_REQUEST, onStale: (notice) => notices.push(notice) });

  assert.ok(answer.ok);
  assert.deepEqual(notices.map((notice) => notice.changed), [["src/Orders.java"]]);
  assert.equal(notices[0]?.stateId, answer.value.snapshot.kind === "live" ? answer.value.snapshot.stateId : "");
});
