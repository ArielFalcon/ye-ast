import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import { SCHEMA, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactCallersRequest, ImpactImportersRequest, ImpactOfChangeRequest } from "../core/ports/impact-queries.port.ts";
import type { OutlineRequest } from "../core/ports/outline-queries.port.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import { DEFAULT_REVISION } from "../core/ports/vcs.port.ts";
import type { FactRead, WorkspaceRequest, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceFault } from "../core/ports/workspace-repos.port.ts";
import type { WorkspaceCallersRequest, WorkspaceImpactValue, WorkspaceOfChangeRequest } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionsRequest, DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import { repositoryCatalog, type RepositoryBinding } from "./repository-targeting.ts";
import { executeQuery, type ExecutedSource, type QueryExecutionDeps, type QueryFault } from "./query-runner.ts";
import type { SemanticQuery } from "./query-schema.ts";
import { createMcpServer } from "./server.ts";
import { openSession, resultFields } from "./test-session.testing.ts";

const SECRET = "hunter2-secret";
const SHA = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);
const SHOP = { path: "/work/shop", repoId: "shop" };
const CONSTRUCTOR = { path: "/work/constructor", repoId: "constructor" };
const digest = { of: (text: string) => createHash("sha256").update(text).digest("hex") };
const redaction: Redaction = {
  redact: (text) => text.replaceAll(SECRET, REDACTED),
  redactValue: (value) => JSON.parse(JSON.stringify(value).replaceAll(SECRET, REDACTED)) as unknown,
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: (error) => String(error instanceof Error ? error.message : error).replaceAll(SECRET, REDACTED),
  containsSecret: (text) => text.includes(SECRET),
};

function base(repo: string, overrides: Partial<FactBase> = {}): FactBase {
  return {
    schema: SCHEMA,
    snapshot: { repo, kind: "sha", sha: SHA },
    producer: { name: "ye-ast", version: "0.0.0" },
    inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: ["java"], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
    evidence: [],
    ...overrides,
  };
}

const IMPACT: ImpactValue = { mergeBase: MERGE_BASE, seeds: [{ file: "src/S.java", symbol: "S.find", line: 3, basis: "lines" }], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };
const { mergeBase: _mergeBase, ...CALLERS } = IMPACT;
const mapFact = (repo: string, extra: Partial<FactBase> = {}): EntrypointMapFact => ({ ...base(repo, extra), status: "complete", value: { entrypoints: { ...base(repo), status: "complete", value: [] } } });
const impactFact = (repo: string, extra: Partial<FactBase> = {}): Fact<ImpactValue> => ({ ...base(repo, extra), status: "complete", value: IMPACT });
function workspaceImpactRead(repo: string): FactRead<WorkspaceImpactValue> {
  const value: WorkspaceImpactValue = { workspace: { repos: [repo], gateways: [], unmatchedGateways: [], unserved: [], source: "request" }, repositorySnapshots: [{ repo, snapshot: base(repo).snapshot }], trigger: { repo, mergeBase: MERGE_BASE }, sections: {}, links: [] };
  const inputs = { ...base(repo).inputs, declaredConfig: { targets: ["src/S.java#S.find"] } };
  return { fact: { ...base(repo, { inputs }), status: "complete", value }, workspaceReplay: { version: 1, declaration: `ws-r1:${"c".repeat(64)}`, snapshots: [{ repo, kind: "sha", sha: SHA }] }, repositoryRoots: [{ repo, path: `/work/${repo}` }], repositorySources: [{ repo, path: "/private/source" }] };
}
function workspaceRead(repo: string): FactRead<WorkspaceValue> {
  const value: WorkspaceValue = { workspace: { repos: [repo], gateways: [], source: "request" }, repositorySnapshots: [{ repo, snapshot: base(repo).snapshot }], sections: {}, candidates: [], unserved: [], links: [], unlinked: [], repositories: [{ repo, snapshot: base(repo).snapshot, entrypoints: [], callSites: [] }] };
  return { fact: { ...base(repo), status: "complete", value }, repositoryRoots: [{ repo, path: `/work/${repo}` }], repositorySources: [{ repo, path: "/private/source" }] };
}
const decisionRead = (repo: string): FactRead<DecisionValue> => ({ fact: { ...base(repo), status: "complete", value: { decisions: [], repositories: [{ repo, snapshot: base(repo).snapshot }], source: "request" } }, repositorySources: [{ repo, path: "/private/source" }] });

type Calls = { [K in "map" | "ofChange" | "callers" | "importers" | "outline" | "outwardNames" | "decisions" | "workspaceCallers" | "workspaceOfChange"]: unknown[] };
type Overrides = Partial<{
  map: (r: MapRequest) => Promise<Result<EntrypointMapFact, never>>;
  ofChange: (r: ImpactOfChangeRequest) => Promise<Result<Fact<ImpactValue>, never>>;
  outwardNames: (r: WorkspaceRequest) => Promise<Result<FactRead<WorkspaceValue>, WorkspaceFault>>;
  workspaceCallers: (r: WorkspaceCallersRequest) => Promise<Result<FactRead<WorkspaceImpactValue>, WorkspaceFault>>;
}>;

function spies(overrides: Overrides = {}): { deps: QueryExecutionDeps; calls: Calls } {
  const calls: Calls = { map: [], ofChange: [], callers: [], importers: [], outline: [], outwardNames: [], decisions: [], workspaceCallers: [], workspaceOfChange: [] };
  const deps: QueryExecutionDeps = {
    entrypoints: { map: async (r) => (calls.map.push(r), overrides.map ? overrides.map(r) : { ok: true, value: mapFact(r.repoId) }) },
    impact: {
      ofChange: async (r) => (calls.ofChange.push(r), overrides.ofChange ? overrides.ofChange(r) : { ok: true, value: impactFact(r.repoId) }),
      callers: async (r: ImpactCallersRequest) => (calls.callers.push(r), { ok: true, value: { ...impactFact(r.repoId), value: CALLERS } }),
      importers: async (r: ImpactImportersRequest) => (calls.importers.push(r), { ok: true, value: { ...base(r.repoId), status: "complete", value: { files: [] } } }),
    },
    outline: { outline: async (r: OutlineRequest) => (calls.outline.push(r), { ok: true, value: { ...base(r.repoId), status: "complete", value: { files: [], unheld: [] } } }) },
    trace: { walk: async () => assert.fail("trace not expected") },
    workspace: { outwardNames: async (r) => (calls.outwardNames.push(r), overrides.outwardNames ? overrides.outwardNames(r) : { ok: true, value: workspaceRead(r.repo.id!) }) },
    workspaceImpact: {
      callers: async (r) => (calls.workspaceCallers.push(r), overrides.workspaceCallers ? overrides.workspaceCallers(r) : { ok: true, value: workspaceImpactRead(r.repo.id!) }),
      ofChange: async (r: WorkspaceOfChangeRequest) => (calls.workspaceOfChange.push(r), { ok: true, value: workspaceImpactRead(r.repo.id!) }),
    },
    decisions: { decisions: async (r: DecisionsRequest) => (calls.decisions.push(r), { ok: true, value: decisionRead(r.repo.id!) }) },
    redaction,
    digest,
  };
  return { deps, calls };
}

const totalCalls = (calls: Calls) => Object.values(calls).reduce((sum, list) => sum + list.length, 0);

async function run(query: SemanticQuery, options: { overrides?: Overrides; bindings?: readonly RepositoryBinding[]; signal?: AbortSignal } = {}) {
  const { deps, calls } = spies(options.overrides);
  const catalog = repositoryCatalog(SHOP, options.bindings ?? [CONSTRUCTOR]);
  const result = await executeQuery(query, { deps, catalog, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  return { result, calls };
}

function ok(result: Result<ExecutedSource, QueryFault>): ExecutedSource {
  if (!result.ok) assert.fail(`unexpected fault ${JSON.stringify(result.fault)}`);
  return result.value;
}

test("entrypoints forward the selected binding, revision, scope and the signal itself", async () => {
  const signal = new AbortController().signal;
  const { result, calls } = await run({ name: "ye_ast_entrypoints", arguments: { repo: "constructor", scope: { include: ["src/**"] } } }, { signal });
  assert.deepEqual(calls.map, [{ repo: "/work/constructor", repoId: "constructor", revision: DEFAULT_REVISION, scope: { include: ["src/**"] }, signal }]);
  assert.equal((calls.map[0] as MapRequest).signal, signal);
  const source = ok(result);
  assert.equal(source.family, "entrypoints");
  assert.deepEqual(source.read.repositoryRoots, [{ repo: "constructor", path: "/work/constructor" }]);
  assert.equal(source.recovery?.status, "available");
});

test("a live local read reports the port's stale notice, redacted, beside the read", async () => {
  const notice: LiveStaleNotice = { stateId: "s2", changed: [`src/${SECRET}.java`] };
  const { result, calls } = await run({ name: "ye_ast_outline", arguments: { live: true, files: ["src/A.java"] } });
  assert.equal((calls.outline[0] as OutlineRequest).live, true);
  assert.equal(typeof (calls.outline[0] as { onStale?: unknown }).onStale, "function");
  assert.equal(ok(result).live, undefined, "no notice when the port reports none");
  const { deps } = spies({ map: async (r) => { if (r.live) r.onStale?.(notice); return { ok: true, value: { ...mapFact(r.repoId), snapshot: { repo: r.repoId, kind: "live", head: SHA, stateId: "s1" } } }; } });
  const live = ok(await executeQuery({ name: "ye_ast_entrypoints", arguments: { live: true } }, { deps, catalog: repositoryCatalog(SHOP) }));
  assert.deepEqual(live.live, { stateId: "s2", changed: [`src/${REDACTED}.java`] });
});

test("local impact forwards base, head, changed, scope and only the bounds that were set", async () => {
  const { result, calls } = await run({ name: "ye_ast_impact", arguments: { base: "main", head: "feature", changed: ["src/**"], scope: { exclude: ["test/**"] }, budget: { depth: 2 } } });
  assert.deepEqual(calls.ofChange, [{ repo: "/work/shop", repoId: "shop", base: "main", head: "feature", changed: ["src/**"], scope: { exclude: ["test/**"] }, budget: { depth: 2 } }]);
  const source = ok(result);
  assert.equal(source.family === "impact" && source.branch, "local");
  assert.equal(totalCalls(calls), 1);
});

test("workspace impact forwards repo, members, gateways, replay, offline and changed to the workspace port", async () => {
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: SHA }] };
  const { deps, calls } = spies();
  const result = await executeQuery({ name: "ye_ast_impact", arguments: { base: "main", live: true, offline: true, changed: ["a/**"], workspace: { repos: [{ path: "/work/web", id: "web", revision: "v1" }, { path: "/work/api", live: true }], gateways: [{ prefix: "edge", repo: "shop" }] }, replay, budget: { expansions: 5 } } }, { deps, catalog: repositoryCatalog(SHOP) });
  assert.deepEqual(calls.workspaceOfChange, [{ repo: { path: "/work/shop", id: "shop", live: true }, repos: [{ path: "/work/web", id: "web", revision: "v1" }, { path: "/work/api", live: true }], gateways: [{ prefix: "edge", repo: "shop" }], replay, base: "main", offline: true, changed: ["a/**"], budget: { expansions: 5 } }]);
  const source = ok(result);
  assert.equal(source.family === "impact" && source.branch, "workspace");
  assert.equal(calls.ofChange.length, 0, "the local port is not asked");
});

test("callers forward both target forms locally and the revision default across a workspace", async () => {
  const targets = [{ file: "src/S.java", symbol: "S.find" }, { file: "src/S.java", start: 3, end: 9 }];
  const local = await run({ name: "ye_ast_callers", arguments: { repo: "constructor", revision: "v2", targets } });
  assert.deepEqual(local.calls.callers, [{ repo: "/work/constructor", repoId: "constructor", revision: "v2", targets }]);
  const crossing = await run({ name: "ye_ast_callers", arguments: { targets, workspace: {} } });
  assert.deepEqual(crossing.calls.workspaceCallers, [{ repo: { path: "/work/shop", id: "shop", revision: DEFAULT_REVISION }, targets }]);
  assert.equal(crossing.calls.callers.length, 0);
  const source = ok(crossing.result);
  assert.equal(source.family === "callers" && source.branch, "workspace");
});

test("importers and outline read the same relative file at the root of the selected repository", async () => {
  const web = { path: "/work/web", repoId: "web" };
  const importers = await run({ name: "ye_ast_importers", arguments: { repo: "web", files: ["src/index.ts"] } }, { bindings: [web] });
  assert.deepEqual(importers.calls.importers, [{ repo: "/work/web", repoId: "web", revision: DEFAULT_REVISION, files: ["src/index.ts"] }]);
  const outline = await run({ name: "ye_ast_outline", arguments: { files: ["src/index.ts"], revision: "v3" } }, { bindings: [web] });
  assert.deepEqual(outline.calls.outline, [{ repo: "/work/shop", repoId: "shop", revision: "v3", files: ["src/index.ts"] }]);
  assert.deepEqual(ok(importers.result).read.repositoryRoots, [{ repo: "web", path: "/work/web" }]);
  assert.deepEqual(ok(outline.result).read.repositoryRoots, [{ repo: "shop", path: "/work/shop" }]);
});

test("workspace and decisions forward members, gateways, offline and scope without a default revision", async () => {
  const args = { revision: "v4", offline: false, scope: { include: ["src/**"] }, repos: [{ path: "/work/web" }], gateways: [{ prefix: "edge", repo: "web" }] };
  const expected = { repo: { path: "/work/shop", id: "shop", revision: "v4" }, repos: [{ path: "/work/web" }], gateways: [{ prefix: "edge", repo: "web" }], offline: false, scope: { include: ["src/**"] } };
  const workspace = await run({ name: "ye_ast_workspace", arguments: args });
  assert.deepEqual(workspace.calls.outwardNames, [expected]);
  const decisions = await run({ name: "ye_ast_decisions", arguments: { live: true } });
  assert.deepEqual(decisions.calls.decisions, [{ repo: { path: "/work/shop", id: "shop", live: true } }]);
  assert.equal(ok(decisions.result).family, "decisions");
});

test("an unknown, undeclared constructor or ambiguous repository is a typed fault without dispatch", async () => {
  for (const repo of ["missing", "constructor", "__proto__"]) {
    const { result, calls } = await run({ name: "ye_ast_entrypoints", arguments: { repo } }, { bindings: [] });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.fault.kind, "unknown-repository", repo);
    assert.equal(totalCalls(calls), 0);
  }
  const { result, calls } = await run({ name: "ye_ast_outline", arguments: { repo: "shop", files: ["a.ts"] } }, { bindings: [{ path: "/elsewhere/shop", repoId: "shop" }] });
  assert.equal(!result.ok && result.fault.kind, "ambiguous-repository");
  assert.equal(totalCalls(calls), 0);
  const declared = await run({ name: "ye_ast_entrypoints", arguments: { repo: "constructor" } });
  assert.equal(ok(declared.result).read.fact.snapshot.repo, "constructor");
});

test("port faults pass through; a workspace replay mismatch becomes a changed result", async () => {
  const mismatch = await run({ name: "ye_ast_callers", arguments: { targets: [{ file: "a", symbol: "b" }], workspace: {} } }, { overrides: { workspaceCallers: async () => ({ ok: false, fault: { kind: "workspace-replay-mismatch", detail: "moved" } }) } });
  assert.deepEqual(mismatch.result, { ok: false, fault: { kind: "result-changed", detail: "moved", stage: "workspace-replay" } });
  const vcs = await run({ name: "ye_ast_workspace", arguments: {} }, { overrides: { outwardNames: async () => ({ ok: false, fault: { kind: "workspace-replay-mismatch", detail: "kept" } }) } });
  assert.deepEqual(vcs.result, { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "kept" } });
});

test("a foreign primary snapshot or a thrown port is an internal fault with a redacted detail", async () => {
  const foreign = await run({ name: "ye_ast_entrypoints", arguments: {} }, { overrides: { map: async () => ({ ok: true, value: mapFact("other") }) } });
  assert.deepEqual(foreign.result, { ok: false, fault: { kind: "internal-fault", detail: "Primary snapshot repository does not match selected repository" } });
  const thrown = await run({ name: "ye_ast_impact", arguments: { base: "main" } }, { overrides: { ofChange: async () => { throw new Error(`boom ${SECRET}`); } } });
  assert.deepEqual(thrown.result, { ok: false, fault: { kind: "internal-fault", detail: `boom ${REDACTED}` } });
});

test("the public read drops private repositories and sources, keeps roots, replay and sorted workspace live notices", async () => {
  const live = { repo: "shop", kind: "live" as const, head: SHA, stateId: "s" };
  const read = workspaceRead("shop");
  const { result } = await run({ name: "ye_ast_workspace", arguments: {} }, { overrides: { outwardNames: async () => ({ ok: true, value: { ...read, workspaceLive: [
    { kind: "staleness-unavailable", repo: "web", snapshot: { ...live, repo: "web" }, cause: { kind: "git-failed", detail: "/abs/path failed" } },
    { kind: "stale", repo: "api", snapshot: { ...live, repo: "api" }, notice: { stateId: "t", changed: [] } },
  ] } }) } });
  const source = ok(result);
  assert.equal(source.family, "workspace");
  assert.ok(source.family === "workspace" && source.read.fact.status !== "unknown" && !("repositories" in source.read.fact.value));
  assert.ok(!("repositorySources" in source.read));
  assert.deepEqual(source.read.repositoryRoots, [{ repo: "shop", path: "/work/shop" }]);
  assert.deepEqual(source.read.workspaceLive?.map((item) => item.repo), ["api", "web"]);
  assert.equal(source.read.workspaceLive?.[1]?.kind === "staleness-unavailable" && source.read.workspaceLive[1].cause.detail, "[path omitted]");
  assert.ok(!JSON.stringify(source).includes("/private/source"));
  const impact = ok((await run({ name: "ye_ast_impact", arguments: { base: "main", workspace: {} } })).result);
  assert.deepEqual(impact.read.workspaceReplay, workspaceImpactRead("shop").workspaceReplay);
  assert.ok(!("repositorySources" in impact.read));
});

test("the identity guard names redacted public positions without carrying the original values", async () => {
  const fact = mapFact("shop", { evidence: [{ path: `src/${SECRET}.java`, line: 1 }, { path: "src/Plain.java", line: 2 }] });
  const { result } = await run({ name: "ye_ast_entrypoints", arguments: { scope: { include: [`${SECRET}/**`] } } }, { overrides: { map: async () => ({ ok: true, value: fact }) } });
  const source = ok(result);
  assert.deepEqual(source.identityGuard, { changedIdentityPointers: ["/evidence/0/path"], changedArguments: true, changedSnapshot: false });
  assert.equal(source.read.fact.evidence[0]?.path, `src/${REDACTED}.java`);
  assert.ok(!JSON.stringify(source.identityGuard).includes(SECRET));
  assert.equal(source.recovery?.status === "unavailable" && source.recovery.reason, "redacted-context", "recovery keeps its own verdict");

  const keyed: FactRead<WorkspaceImpactValue> = workspaceImpactRead("shop");
  const sections = { [`web-${SECRET}`]: { ...base("shop"), status: "unknown" as const, reason: "no-project" as const } };
  const withKey = { ...keyed, fact: { ...keyed.fact, snapshot: { repo: "shop", kind: "sha" as const, sha: `${SECRET}${"a".repeat(26)}` }, value: { ...(keyed.fact as { value: WorkspaceImpactValue }).value, sections } } } as FactRead<WorkspaceImpactValue>;
  const keyedRun = await run({ name: "ye_ast_callers", arguments: { targets: [{ file: "a", symbol: "b" }], workspace: {} } }, { overrides: { workspaceCallers: async () => ({ ok: true, value: withKey }) } });
  const guard = ok(keyedRun.result).identityGuard;
  assert.deepEqual(guard, { changedIdentityPointers: ["/snapshot/sha", "/value/sections"], changedArguments: false, changedSnapshot: true });
  assert.ok(!JSON.stringify(guard).includes(SECRET));
});

test("an unaltered read has an empty guard", async () => {
  const source = ok((await run({ name: "ye_ast_decisions", arguments: {} })).result);
  assert.deepEqual(source.identityGuard, { changedIdentityPointers: [], changedArguments: false, changedSnapshot: false });
});

test("runner recovery equals the recovery the original tools publish", async () => {
  const { deps } = spies();
  const server = createMcpServer({ ...deps, version: "0", repository: SHOP });
  const session = await openSession(server);
  try {
    const cases: [SemanticQuery, Record<string, unknown>][] = [
      [{ name: "ye_ast_entrypoints", arguments: {} }, {}],
      [{ name: "ye_ast_impact", arguments: { base: "main", budget: { depth: 2 } } }, { base: "main", budget: { depth: 2 } }],
      [{ name: "ye_ast_callers", arguments: { targets: [{ file: "src/S.java", symbol: "S.find" }], workspace: {} } }, { targets: [{ file: "src/S.java", symbol: "S.find" }], workspace: {} }],
    ];
    for (const [query, args] of cases) {
      const executed = ok(await executeQuery(query, { deps, catalog: repositoryCatalog(SHOP) }));
      const published = await session.callTool(query.name, args);
      assert.equal(published.isError, undefined, query.name);
      assert.deepEqual(executed.recovery, resultFields(published).recovery, query.name);
      assert.equal(executed.recovery?.status, "available", query.name);
    }
  } finally {
    await session.close();
  }
});
