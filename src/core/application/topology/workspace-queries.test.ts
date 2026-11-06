import { createDecisionQueries } from "../decisions/decision-queries.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntrypointExtractor } from "../../ports/entrypoint-extractor.port.ts";
import type { CommitExport, ExportedFile, ExportPlan, RemoteRef, Vcs, VcsFault } from "../../ports/vcs.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { SourceReader } from "../../ports/source-reader.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import { sameIdentity, type Evidence, type Fact, type SnapshotRef } from "../../domain/shared/fact.ts";
import type { WorkspaceRead, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import type { RefreshedRemote, RemoteRefreshRequest } from "../../ports/remote-refresh.port.ts";
import type { RemoteFreshness, RemoteListing } from "../../domain/topology/remote-snapshot.ts";
import type { WorkspaceRepositoryRequest } from "../../ports/workspace-repos.port.ts";
import type { OutwardName } from "../../domain/topology/outward-name.ts";
import type { CallSite, CallSiteReader } from "../../domain/topology/call-site.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { WorkspaceDefaults, WorkspaceManifest } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceQueriesDeps } from "./workspace-queries.ts";
import { createWorkspaceQueries } from "./workspace-queries.ts";
import { createWorkspaceImpactQueries } from "./workspace-impact.ts";
import type { ImpactQueries } from "../../ports/impact-queries.port.ts";

const SHA = "a".repeat(40);

function readOf(result: Result<WorkspaceRead, unknown>): WorkspaceRead {
  assert.ok(result.ok);
  return result.value;
}

function valueOf(result: Result<WorkspaceRead, unknown>): WorkspaceValue {
  const read = readOf(result);
  assert.notEqual(read.fact.status, "unknown");
  return (read.fact as { value: WorkspaceValue }).value;
}

type Repositories = Record<
  string,
  {
    files: Record<string, string>;
    remotes?: RemoteRef[];
    names?: readonly OutwardName[];
    artifacts?: readonly string[];
    /** The revision every name but a full sha resolves to; `SHA` when absent. */
    sha?: string;
    /** The full shas the repository holds; a full sha outside it is `unknown-revision`. */
    holds?: readonly string[];
    /** The branch `HEAD` points at; a detached head when absent. */
    branch?: string;
    stopped?: CommitExport["stopped"];
    skipped?: CommitExport["skipped"];
    entrypoints?: readonly Finding<Entrypoint>[];
    /** What the extraction answers when it is given library sources, in place of `entrypoints`. */
    inherited?: readonly Finding<Entrypoint>[];
  }
>;

const matcher: PathMatcher = { matches: () => true };

/** What a refresh answers per URL, and the requests it received. */
interface RefreshSetup {
  answers: readonly RefreshedRemote[];
  asked?: RemoteRefreshRequest[];
}

function setup(
  repositories: Repositories,
  callSites: CallSiteReader = { of: async () => [] },
  trust?: TrustRecordReader,
  defaults?: WorkspaceDefaults,
  refresh?: RefreshSetup,
  scoped = false,
  resolveHead?: () => string,
  testDigest?: Digest,
  reads?: { resolved: { repo: string; revision: string }[]; exports: string[] },
  hooks?: { extract?: () => void; exported?: (repo: string, sha: string) => void },
) {
  let exported: string | undefined;
  const vcs: Vcs = {
    resolveCommit: async (repo, revision): Promise<Result<string, VcsFault>> => {
      reads?.resolved.push({ repo, revision });
      const held = repositories[repo];
      if (held === undefined) return { ok: false, fault: { kind: "not-repository-root", detail: repo } };
      if (/^[0-9a-f]{40}$/.test(revision) && held.holds !== undefined && !held.holds.includes(revision)) return { ok: false, fault: { kind: "unknown-revision", detail: revision } };
      return { ok: true, value: /^[0-9a-f]{40}$/.test(revision) ? revision : (revision === "HEAD" && resolveHead !== undefined ? resolveHead() : (held.sha ?? SHA)) };
    },
    remotes: async (repo) => ({ ok: true, value: repositories[repo]?.remotes ?? [] }),
    headBranch: async (repo) => ({ ok: true, value: repositories[repo]?.branch }),
    canonicalRoot: async (repo) => ({ ok: true, value: repo }),
    repositoryName: async () => ({ ok: true, value: "library" }),
    exportCommit: async (repo, _sha, _destination, plan) => {
      reads?.exports.push(repo);
      hooks?.exported?.(repo, _sha);
      exported = repo;
      const files: ExportedFile[] = Object.keys(repositories[repo]?.files ?? {}).map((path) => ({ path, blob: path, written: plan.write(path) }));
      return { ok: true, value: { files, skipped: repositories[repo]?.skipped ?? [], ...(repositories[repo]?.stopped === undefined ? {} : { stopped: repositories[repo].stopped }) } };
    },
  };
  const scratch: ScratchDirectory = { create: async () => "/scratch", remove: async () => undefined };
  const reader: SourceReader = { read: async (_root, paths) => paths.map((path) => ({ path, content: repositories[exported ?? ""]?.files[path] ?? "" })) };
  const extractor: EntrypointExtractor = { extract: async (files, libraries) => { hooks?.extract?.(); const held = libraries?.length ? Object.values(repositories).find((repository) => files.every(({ path }) => path in repository.files)) : repositories[exported ?? ""]; return (libraries?.length ? held?.inherited : undefined) ?? held?.entrypoints ?? []; } };
  const digest: Digest = testDigest ?? { of: (text) => `digest(${text})` };
  const deps: WorkspaceQueriesDeps = {
    vcs,
    scratch,
    reader,
    extractor,
    digest,
    matcher: scoped ? { matches: (path, glob) => path === glob || (glob.endsWith("/**") && path.startsWith(glob.slice(0, -2))) } : matcher,
    callSites,
    evidence: { names: (sources) => scoped ? sources.map(({ path }) => configurationName(path, path, 1)) : repositories[exported ?? ""]?.names ?? [], artifacts: () => repositories[exported ?? ""]?.artifacts ?? [] },
    producer: { name: "ye-ast", version: "0.0.0" },
    engines: {},
    ...(trust === undefined ? {} : { trust }),
    ...(defaults === undefined ? {} : { defaults }),
    ...(refresh === undefined ? {} : { refresh: { refresh: async (requests) => {
      refresh.asked?.push(...requests);
      return requests.map((request) => refresh.answers.find((answer) => answer.url === request.url) ?? { url: request.url, freshness: { status: "unverified" as const, reason: "failed" as const } });
    } } }),
  };
  return createWorkspaceQueries(deps);
}

const deterministicDigest: Digest = { of: (text) => {
  let hash = 0n;
  for (const character of text) hash = (hash * 131n + BigInt(character.codePointAt(0)!)) % (1n << 256n);
  return hash.toString(16).padStart(64, "0");
} };

test("workspace pins every member before the first extraction", async () => {
  const old = "b".repeat(40);
  const next = "c".repeat(40);
  let head = old;
  const exports: { repo: string; sha: string }[] = [];
  const sources: string[] = [];
  const repos: Repositories = { "/work/app": { files: { "app.ts": "app" } }, "/work/lib": { files: { "lib.ts": old } } };
  const queries = setup(repos, { of: async (files) => { sources.push(...files.filter((file) => file.path === "lib.ts").map((file) => file.content)); return []; } }, undefined, undefined, undefined, false, () => head, undefined, undefined, {
    extract: () => { head = next; }, exported: (repo, sha) => { exports.push({ repo, sha }); if (repo === "/work/lib") repos[repo]!.files["lib.ts"] = sha; },
  });
  const value = valueOf(await queries.outwardNames({ repo: { path: "/work/app" }, repos: [{ path: "/work/lib" }] }));
  assert.deepEqual(exports, [{ repo: "/work/app", sha: old }, { repo: "/work/lib", sha: old }]);
  assert.deepEqual(value.repositorySnapshots.map(({ snapshot }) => snapshot.kind === "sha" ? snapshot.sha : null), [old, old]);
  assert.deepEqual(sources, [old]);
});

test("workspace rejects invalid selectors before resolving or exporting", async () => {
  for (const trust of [undefined, TRUSTED]) {
    for (const request of [
      { repo: { path: "/work/app", live: false } },
      { repo: { path: "/work/app" }, repos: [{ path: "/work/lib", live: true, revision: "HEAD" }] },
    ]) {
      const reads = { resolved: [] as { repo: string; revision: string }[], exports: [] as string[] };
      const queries = setup({ "/work/app": { files: {} }, "/work/lib": { files: {} } }, undefined, trust, undefined, undefined, false, undefined, undefined, reads);
      const result = await queries.outwardNames(request as unknown as Parameters<typeof queries.outwardNames>[0]);
      assert.ok(!result.ok);
      assert.equal(result.fault.kind, "git-failed");
      assert.deepEqual(reads, { resolved: [], exports: [] });
    }
  }
});

test("persisted workspace replay pins moving branches without changing the fact", async () => {
  const repos: Repositories = { "/work/app": { files: { "app.ts": "app" }, sha: "a".repeat(40) }, "/work/lib": { files: { "lib.ts": "lib" }, sha: "b".repeat(40) } };
  const queries = setup(repos, undefined, TRUSTED, persisted({ repos: [{ path: "/work/lib", revision: "release" }] }), undefined, false, undefined, deterministicDigest);
  const request = { repo: { path: "/work/app", revision: "main" } };
  const first = readOf(await queries.outwardNames(request));
  assert.ok(first.workspaceReplay);
  repos["/work/app"]!.sha = "c".repeat(40);
  repos["/work/lib"]!.sha = "d".repeat(40);
  const replayRequest = { ...request, replay: first.workspaceReplay };
  const replay = readOf(await queries.outwardNames(replayRequest));
  assert.deepEqual(replay.fact, first.fact);
  assert.equal(valueOf({ ok: true, value: replay }).workspace.source, "persisted");
  assert.deepEqual(replay.workspaceReplay, first.workspaceReplay);
});

test("replay rejects malformed contexts and changed declarations before source reads", async () => {
  const member = { path: "/work/lib", id: "lib", revision: "release", remote: "https://example.test/a" };
  let manifest: WorkspaceManifest = { repos: [member], gateways: [{ prefix: "api", repo: "lib" }] };
  let available = true;
  let mode: "trusted" | "untrusted" = "trusted";
  const defaults: WorkspaceDefaults = { of: async () => available ? { ok: true, value: manifest } : { ok: false, fault: { kind: "unreadable", detail: "unavailable" } }, resolve: (_root, resolved) => resolved };
  const reads = { resolved: [] as { repo: string; revision: string }[], exports: [] as string[] };
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup({ "/work/app": { files: {} }, "/work/lib": { files: {} } }, undefined, { read: async () => ({ ok: true, value: mode }) }, defaults, { answers: [], asked }, false, undefined, deterministicDigest, reads);
  const request = { repo: { path: "/work/app", id: "app" }, offline: true };
  const context = readOf(await queries.outwardNames(request)).workspaceReplay!;
  const mismatch = async (replay: unknown, extra: object = {}) => {
    reads.resolved.length = 0; reads.exports.length = 0; asked.length = 0;
    const result = await queries.outwardNames({ ...request, ...extra, replay: replay as typeof context });
    assert.ok(!result.ok && result.fault.kind === "workspace-replay-mismatch");
    assert.deepEqual(reads.resolved, []); assert.deepEqual(reads.exports, []); assert.deepEqual(asked, []);
  };
  const [a, b] = context.snapshots;
  for (const bad of [null, { ...context, version: 2 }, { ...context, declaration: "ws-r1:bad" }, { ...context, snapshots: [a, a] }, { ...context, snapshots: [b, a] }, { ...context, snapshots: [a] }, { ...context, snapshots: [a, { ...b, repo: "extra" }] }, { ...context, snapshots: [a, { ...b, sha: "HEAD" }] }, { ...context, snapshots: [a, { repo: "lib", kind: "live", head: SHA, stateId: "state" }] }, { ...context, snapshots: [a, { ...b, extra: true }] }]) await mismatch(bad);
  await mismatch({ ...context, declaration: "ws-r1:bad" }, { offline: false });
  manifest = { ...manifest, repos: [{ ...member, revision: "other" }] }; await mismatch(context);
  manifest = { ...manifest, repos: [{ ...member, id: "other" }] }; await mismatch(context);
  manifest = { ...manifest, repos: [member], gateways: [{ prefix: "other", repo: "lib" }] }; await mismatch(context);
  manifest = { ...manifest, repos: [{ ...member, remote: "https://example.test/b" }], gateways: [{ prefix: "api", repo: "lib" }] }; await mismatch(context);
  manifest = { repos: [member], gateways: [{ prefix: "api", repo: "lib" }] }; await mismatch(context, { repos: [member] });
  mode = "untrusted"; await mismatch(context); mode = "trusted";
  available = false; await mismatch(context); await mismatch(context, { repos: [member] });
});

test("replay reads old remote pins from the authorized mirror and preserves unavailable sections", async () => {
  const oldSha = "b".repeat(40), newSha = "c".repeat(40);
  const repositories: Repositories = { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: "d".repeat(40) }, [MIRROR]: { files: {}, holds: [oldSha, newSha] } };
  const answers: RefreshedRemote[] = [refreshed(REMOTE, { branches: [{ name: "main", sha: oldSha }], defaultBranch: "main" }, { status: "verified" }, MIRROR)];
  const asked: RemoteRefreshRequest[] = [];
  const reads = { resolved: [] as { repo: string; revision: string }[], exports: [] as string[] };
  const queries = setup(repositories, undefined, trusted([TRIGGER, SIBLING]), persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }), { answers, asked }, false, undefined, deterministicDigest, reads);
  const request = { repo: { path: TRIGGER } };
  const first = readOf(await queries.outwardNames(request));
  assert.ok(first.workspaceReplay);
  answers[0] = refreshed(REMOTE, { branches: [{ name: "main", sha: newSha }], defaultBranch: "main" }, { status: "verified" }, MIRROR);
  reads.resolved.length = 0;
  const replay = readOf(await queries.outwardNames({ ...request, replay: first.workspaceReplay }));
  assert.deepEqual(replay.fact, first.fact);
  assert.deepEqual(replay.refresh?.resolution, [{ repo: "orders-svc", asked: oldSha, step: "explicit", consulted: [{ branch: "main", sha: newSha }], sha: oldSha }]);
  assert.deepEqual(replay.refresh?.freshness, [{ repo: "orders-svc", url: REMOTE, freshness: { status: "verified" } }]);
  assert.ok(reads.resolved.some(({ repo, revision }) => repo === MIRROR && revision === oldSha));
  assert.equal(reads.resolved.some(({ repo }) => repo === SIBLING), false);
  repositories[MIRROR]!.holds = [newSha]; reads.resolved.length = 0;
  const unavailable = readOf(await queries.outwardNames({ ...request, replay: first.workspaceReplay }));
  const section = valueOf({ ok: true, value: unavailable }).sections["orders-svc"];
  assert.ok(section?.status === "unknown" && section.reason === "revision-unavailable");
  assert.deepEqual(unavailable.workspaceReplay, first.workspaceReplay);
  assert.deepEqual(unavailable.refresh?.resolution, replay.refresh?.resolution);
  assert.equal(reads.resolved.some(({ repo }) => repo === SIBLING), false);
  answers[0] = refreshed(REMOTE, { branches: [{ name: "main", sha: newSha }], defaultBranch: "main" }, { status: "verified" });
  reads.resolved.length = 0;
  const absent = readOf(await queries.outwardNames({ ...request, replay: first.workspaceReplay }));
  assert.deepEqual(absent.workspaceReplay, first.workspaceReplay);
  assert.deepEqual(absent.refresh?.resolution, replay.refresh?.resolution);
  assert.ok(absent.repositoryRoots?.some(({ repo, path }) => repo === "orders-svc" && path === SIBLING));
  assert.equal(absent.repositorySources?.some(({ repo }) => repo === "orders-svc"), false);
  assert.equal(valueOf({ ok: true, value: absent }).sections["orders-svc"]?.status, "unknown");
  assert.equal(reads.resolved.some(({ repo }) => repo === SIBLING), false);
});

test("offline replay reads pins from clones and handles prototype-like repository ids", async () => {
  const reads = { resolved: [] as { repo: string; revision: string }[], exports: [] as string[] };
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup({ "/work/app": { files: {} }, "/work/lib": { files: {}, sha: "b".repeat(40) } }, undefined, TRUSTED, persisted({ repos: [{ path: "/work/lib", id: "__proto__", remote: "https://example.test/a" }] }), { answers: [], asked }, false, undefined, deterministicDigest, reads);
  const request = { repo: { path: "/work/app", id: "constructor" }, offline: true };
  const first = readOf(await queries.outwardNames(request));
  assert.ok(first.workspaceReplay);
  assert.ok(Object.hasOwn(valueOf({ ok: true, value: first }).sections, "__proto__"));
  reads.resolved.length = 0;
  const replay = readOf(await queries.outwardNames({ ...request, replay: first.workspaceReplay }));
  assert.deepEqual(replay.fact, first.fact);
  assert.ok(reads.resolved.some(({ repo, revision }) => repo === "/work/lib" && revision === "b".repeat(40)));
  assert.deepEqual(asked, []);
});

test("workspace emits deterministic replay context with actual sorted snapshots", async () => {
  const queries = setup({ "/work/app": { files: {}, sha: "a".repeat(40) }, "/work/lib": { files: {}, sha: "b".repeat(40) } }, undefined, undefined, undefined, undefined, false, undefined, deterministicDigest);
  const request = { repo: { path: "/work/app", id: "z" }, repos: [{ path: "/work/lib", id: "a" }] };
  const first = readOf(await queries.outwardNames(request));
  const context = first.workspaceReplay;
  assert.ok(context);
  assert.equal(context.version, 1);
  assert.match(context.declaration, /^ws-r1:[0-9a-f]{64}$/);
  assert.deepEqual(context.snapshots, [{ repo: "a", kind: "sha", sha: "b".repeat(40) }, { repo: "z", kind: "sha", sha: "a".repeat(40) }]);
  assert.deepEqual(readOf(await queries.outwardNames(request)).workspaceReplay, context);
});

test("workspace replay declaration tracks effective source, revisions, gateways and authorized remotes", async () => {
  const repos = { "/work/app": { files: {} }, "/work/lib": { files: {} }, "/else/app": { files: {} }, "/else/lib": { files: {} } };
  const member = { path: "/work/lib", id: "lib" };
  const base = { repo: { path: "/work/app", id: "app" }, repos: [member] };
  const queries = setup(repos, undefined, TRUSTED, persisted({ repos: [member] }), undefined, false, undefined, deterministicDigest);
  const declaration = async (request: Parameters<typeof queries.outwardNames>[0]) => {
    const context = readOf(await queries.outwardNames(request)).workspaceReplay;
    assert.ok(context);
    return context.declaration;
  };
  const original = await declaration(base);
  assert.equal(await declaration({ repo: { path: "/else/app", id: "app", revision: "other" }, repos: [{ path: "/else/lib", id: "lib", revision: "HEAD" }] }), original);
  assert.notEqual(await declaration({ ...base, repos: [{ ...member, revision: "release" }] }), original);
  assert.notEqual(await declaration({ ...base, gateways: [{ prefix: "api", repo: "lib" }] }), original);
  assert.notEqual(await declaration({ repo: base.repo }), original);
  assert.notEqual(await declaration({ ...base, repos: [{ ...member, id: "different" }] }), original);

  const remote = async (url: string) => {
    const q = setup(repos, undefined, TRUSTED, persisted({ repos: [{ ...member, remote: url }] }), { answers: [] }, false, undefined, deterministicDigest);
    return readOf(await q.outwardNames({ repo: base.repo, offline: true })).workspaceReplay?.declaration;
  };
  assert.notEqual(await remote("https://example.test/a"), await remote("https://example.test/b"));
});

test("workspace replay context includes the known snapshot of an unavailable remote", async () => {
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: LOCAL_SHA }, [MIRROR]: mirrorWith([], []) },
    undefined, trusted([TRIGGER, SIBLING]), persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)] },
    false, undefined, deterministicDigest,
  );
  const read = readOf(await queries.outwardNames({ repo: { path: TRIGGER } }));
  assert.deepEqual(read.workspaceReplay?.snapshots, [{ repo: "orders-svc", kind: "sha", sha: REMOTE_SHA }, { repo: "shop-web", kind: "sha", sha: SHA }]);
  assert.match(read.workspaceReplay?.declaration ?? "", /^ws-r1:[0-9a-f]{64}$/);
  assert.equal(read.fact.status, "partial");
});

test("an unavailable persisted authority does not break an explicit offline read", async () => {
  const defaults: WorkspaceDefaults = { of: async () => ({ ok: false, fault: { kind: "unreadable", detail: "unavailable" } }), resolve: (_root, resolved) => resolved };
  const queries = setup({ "/work/app": { files: {} }, "/work/lib": { files: {} } }, undefined, TRUSTED, defaults, undefined, false, undefined, deterministicDigest);
  const result = await queries.outwardNames({ repo: { path: "/work/app" }, repos: [{ path: "/work/lib" }], offline: true });
  assert.ok(result.ok);
  assert.equal(result.value.fact.status, "complete");
  assert.equal(result.value.workspaceReplay, undefined);
});

test("workspace scope selects source findings while keeping extractor configuration unless excluded", async () => {
  let parsed: readonly string[] = [];
  const callSites: CallSiteReader = { of: async (sources) => { parsed = sources.map(({ path }) => path); return []; } };
  const queries = setup({ "/work/app": { files: { "src/a.ts": "", "src/keep.ts": "", "other/b.ts": "", "tsconfig.json": "" } } }, callSites, undefined, undefined, undefined, true);
  const request = { repo: { path: "/work/app" }, scope: { include: ["src/**"], exclude: ["src/a.ts"] } };
  const result = await queries.outwardNames(request);
  const section = valueOf(result).sections.app;
  assert.ok(section && section.status !== "unknown");
  assert.deepEqual(section.value.names.map(({ name }) => name), ["src/keep.ts"]);
  assert.deepEqual(parsed.toSorted(), ["src/keep.ts", "tsconfig.json"]);
  assert.deepEqual(section.inputs.declaredScope.include, ["src/**"]);
  assert.deepEqual(section.inputs.declaredScope.exclude, ["src/a.ts"]);
});

test("a stopped workspace export keeps its budget cut", async () => {
  const queries = setup({ "/work/app": { files: {}, stopped: { at: "src/next.ts", limit: 2 } } });
  const result = await queries.outwardNames({ repo: { path: "/work/app" } });
  const section = valueOf(result).sections.app;
  assert.equal(section?.status, "partial");
  assert.deepEqual(section?.status === "partial" && section.cuts, [{ kind: "caller-budget", at: ["src/next.ts"], limit: 2 }]);
});

test("an in-scope source skipped by export remains a repository cut", async () => {
  const queries = setup({ "/work/app": { files: {}, skipped: [{ path: "src/missing.ts", reason: "symlink" }] } });
  const section = valueOf(await queries.outwardNames({ repo: { path: "/work/app" } })).sections.app;
  assert.equal(section?.status, "partial");
  assert.deepEqual(section?.status === "partial" && section.cuts, [{ kind: "not-exported", at: ["src/missing.ts"] }]);
});

test("workspace identity includes every repository snapshot and the declared gateways", async () => {
  const request = { repo: { path: "/work/app" }, repos: [{ path: "/work/sibling" }] };
  const first = setup({ "/work/app": { files: {} }, "/work/sibling": { files: {}, sha: "b".repeat(40) } });
  const second = setup({ "/work/app": { files: {} }, "/work/sibling": { files: {}, sha: "c".repeat(40) } });
  const a = readOf(await first.outwardNames(request)).fact;
  const b = readOf(await second.outwardNames(request)).fact;
  const changedContent = readOf(await setup({ "/work/app": { files: {} }, "/work/sibling": { files: { "src/new.ts": "changed" }, sha: "b".repeat(40) } }).outwardNames(request)).fact;
  const gateway = readOf(await first.outwardNames({ ...request, gateways: [{ prefix: "api", repo: "sibling" }] })).fact;
  assert.equal(sameIdentity(a, b), false);
  assert.equal(sameIdentity(a, changedContent), false);
  assert.equal(sameIdentity(a, gateway), false);
  assert.equal(JSON.stringify(a), JSON.stringify(readOf(await first.outwardNames(request)).fact));
});

test("workspace returns original declared repository roots outside the fact", async () => {
  const queries = setup({ "/work/app": { files: {} }, "/work/sibling": { files: {} } });
  const read = readOf(await queries.outwardNames({ repo: { path: "/work/app", id: "z" }, repos: [{ path: "/work/sibling", id: "a" }] }));
  assert.deepEqual(read.repositoryRoots, [{ repo: "a", path: "/work/sibling" }, { repo: "z", path: "/work/app" }]);
  assert.equal(JSON.stringify(read.fact).includes("/work/"), false);
});

test("a moving HEAD cannot mix discovery and the trigger walk", async () => {
  let head = "a".repeat(40);
  const discovery = setup({ "/work/app": { files: {}, branch: "release" } }, undefined, undefined, undefined, undefined, false, () => head);
  let revision = "";
  const workspace = { outwardNames: async (ask: Parameters<typeof discovery.outwardNames>[0]) => {
    const result = await discovery.outwardNames(ask);
    head = "b".repeat(40);
    return result;
  } };
  const impact = { callers: async (ask: { revision: string }) => {
    revision = ask.revision;
    const resolved = ask.revision === "HEAD" ? head : ask.revision;
    const found = readOf(await discovery.outwardNames({ repo: { path: "/work/app", revision: resolved } })).fact;
    return { ok: true as const, value: { ...found, status: "complete" as const, value: { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } } } };
  } } as unknown as ImpactQueries;
  const result = await createWorkspaceImpactQueries({ workspace, impact, digest: { of: (text) => text } }).callers({ repo: { path: "/work/app" }, targets: [{ file: "src/a.ts", symbol: "a" }] });
  assert.ok(result.ok && result.value.fact.status !== "unknown");
  assert.equal(revision, "a".repeat(40));
  assert.deepEqual(result.value.fact.snapshot, { repo: "app", kind: "sha", sha: "a".repeat(40) });
  const section = result.value.fact.value.sections.app;
  assert.ok(section && section.status !== "unknown");
  assert.deepEqual(section.value.reads.map(({ fact }) => fact.snapshot.kind === "sha" && fact.snapshot.sha), ["a".repeat(40), "a".repeat(40)]);
});

function configurationName(name: string, path: string, line: number): OutwardName {
  return { name, kind: "configuration-url", evidence: [{ path, line }] };
}

function dependencyName(name: string, path: string, line: number): OutwardName {
  return { name, kind: "dependency", evidence: [{ path, line }] };
}

test("a name equal to a repository's own id is served by it, with basis exact-name", async () => {
  const queries = setup({
    "/work/shop-web": { files: {}, names: [configurationName("http://orders-svc.b2c:8080/orders", "src/main/resources/application.yaml", 7)] },
    "/work/orders-svc": { files: {} },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders-svc" }] });

  assert.deepEqual(valueOf(result).candidates.map((candidate) => `${candidate.name} -> ${candidate.repo} (${candidate.basis})`), ["http://orders-svc.b2c:8080/orders -> orders-svc (exact-name)"]);
  assert.deepEqual(valueOf(result).unserved, []);
});

test("a coordinate a repository's build declares names it with basis artifact", async () => {
  const queries = setup({
    "/work/shop-web": { files: {}, names: [dependencyName("events-lib", "package.json", 3)] },
    "/work/library": { files: {}, artifacts: ["events-lib"] },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/library" }] });

  assert.deepEqual(valueOf(result).candidates.map((candidate) => `${candidate.name} ${candidate.basis}`), ["events-lib artifact"]);
});

test("a name that matches the tail of a repository's remote is served with basis remote", async () => {
  const queries = setup({
    "/work/shop-web": { files: {}, names: [dependencyName("events-lib", "package.json", 3)] },
    "/work/library": { files: {}, remotes: [{ name: "origin", url: "git@github.com:shop/events-lib.git" }] },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/library" }] });

  assert.deepEqual(valueOf(result).candidates.map((candidate) => `${candidate.repo} ${candidate.basis}`), ["library remote"]);
});

test("a name a clone's upstream states cites the remote that states it, never the one that does not", async () => {
  const queries = setup({
    "/work/shop-web": { files: {}, names: [dependencyName("events-lib", "package.json", 3)] },
    "/work/library": {
      files: {},
      remotes: [
        { name: "origin", url: "git@github.com:shop/billing.git" },
        { name: "upstream", url: "git@github.com:shop/events-lib.git" },
      ],
    },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/library" }] });

  const candidates = valueOf(result).candidates;
  assert.deepEqual(
    candidates.map((candidate) => `${candidate.repo} ${candidate.basis} ${candidate.evidence.map((place) => `${place.path}:${place.line}${place.via === undefined ? "" : ` via ${place.via}`}`).join(", ")}`),
    ["library remote .git/config:1 via upstream, package.json:3"],
  );
});

test("a name no repository given serves is listed as unserved, and the service label decides what is compared", async () => {
  const queries = setup({
    "/work/shop-web": { files: {}, names: [configurationName("http://geo-svc.b2c:8080/addresses", "src/main/resources/application.yaml", 7)] },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" } });

  assert.deepEqual(valueOf(result).candidates, []);
  assert.deepEqual(valueOf(result).unserved.map((name) => `${name.kind} ${name.name}`), ["configuration-url http://geo-svc.b2c:8080/addresses"]);
});

test("the same name written twice is one name with both places", async () => {
  const queries = setup({
    "/work/shop-web": {
      files: {},
      names: [configurationName("http://orders-svc.b2c:8080/orders", "src/main/resources/application.yaml", 7), configurationName("http://orders-svc.b2c:8080/orders", "src/main/resources/config/application.yaml", 7)],
    },
    "/work/orders-svc": { files: {} },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders-svc" }] });

  const section = valueOf(result).sections["shop-web"];
  assert.ok(section !== undefined && section.status === "complete");
  assert.deepEqual(section.value.names.map((name) => name.name), ["http://orders-svc.b2c:8080/orders"]);
  assert.deepEqual(section.value.names[0]?.evidence.map((place: Evidence) => place.path), ["src/main/resources/application.yaml", "src/main/resources/config/application.yaml"]);
  assert.deepEqual(section.evidence.map((place: Evidence) => place.path), ["src/main/resources/application.yaml", "src/main/resources/config/application.yaml"]);
});

test("the same dependency declared by two repositories and served by none is one unserved name with both places", async () => {
  const queries = setup({
    "/work/shop-web": { files: {}, names: [dependencyName("org.example:payments-core", "pom.xml", 12)] },
    "/work/orders-svc": { files: {}, names: [dependencyName("org.example:payments-core", "build.gradle", 5)] },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders-svc" }] });

  assert.deepEqual(
    valueOf(result).unserved.map((name) => `${name.kind} ${name.name} (${name.evidence.map((place) => `${place.path}:${place.line}`).join(", ")})`),
    ["dependency org.example:payments-core (build.gradle:5, pom.xml:12)"],
  );
});

test("a name two configuration lines state and one repository serves is one candidate with both lines", async () => {
  const url = "http://ms-name-restaurants.b2c:8080/restaurants/{restaurantId}";
  const queries = setup({
    "/work/shop-web": { files: {}, names: [configurationName(url, "src/main/resources/application.yaml", 77)] },
    "/work/reporting": { files: {}, names: [configurationName(url, "src/main/resources/application.yaml", 91)] },
    "/work/ms-name-restaurants": { files: {} },
  });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/reporting" }, { path: "/work/ms-name-restaurants" }] });

  assert.deepEqual(
    valueOf(result).candidates.map((candidate) => `${candidate.name} -> ${candidate.repo} (${candidate.basis}) (${candidate.evidence.map((place) => `${place.path}:${place.line}`).join(", ")})`),
    [`${url} -> ms-name-restaurants (exact-name) (src/main/resources/application.yaml:77, src/main/resources/application.yaml:91)`],
  );
});

test("two repositories asked under one id are a fault, never one answer for both", async () => {
  const queries = setup({ "/work/a": { files: {} }, "/work/b": { files: {} } });
  const repos: WorkspaceRepositoryRequest[] = [{ path: "/work/a", id: "shop" }];

  const result = await queries.outwardNames({ repo: { path: "/work/b", id: "shop" }, repos });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.fault.kind, "duplicate-repository");
});

test("every repository read is listed with its own snapshot, sorted by repository", async () => {
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders-svc" }] });

  const value = valueOf(result);
  assert.deepEqual(value.repositorySnapshots.map(({ repo, snapshot }) => `${repo} ${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`), [`orders-svc ${SHA}`, `shop-web ${SHA}`]);
  assert.deepEqual(value.workspace.repos, ["orders-svc", "shop-web"]);
  assert.ok(result.ok);
  assert.equal(result.value.fact.snapshot.repo, "shop-web");
});

test("a path prefix and a host a call site names are outward names, and an undecided call site cuts the section", async () => {
  const callSites: CallSiteReader = {
    of: async (_files, repo) =>
      repo !== "shop-web"
        ? []
        : [
            { repo, file: "src/app/order/order.api.ts", line: 7, symbol: "OrderApi.create", transport: "http", target: { status: "complete", value: { method: "POST", path: "orders-api/orders" }, evidence: [] } },
            { repo, file: "src/app/map/route.service.ts", line: 85, symbol: "RouteService.fetchRoute", transport: "http", target: { status: "complete", value: { method: "GET", path: "{}", base: "https://maps.example.com/geo" }, evidence: [] } },
            { repo, file: "src/app/core/auth/auth.service.ts", line: 48, symbol: "AuthService.refresh", transport: "http", target: { status: "unknown", reason: "unresolved", evidence: [{ path: "src/app/core/auth/auth.service.ts", line: 48 }] } },
          ],
  };
  const queries = setup({ "/work/shop-web": { files: {} } }, callSites);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" } });

  const value = valueOf(result);
  assert.deepEqual(value.sections["shop-web"]?.status, "partial");
  assert.deepEqual(
    value.sections["shop-web"]?.status === "partial" ? value.sections["shop-web"].cuts.map((cut) => `${cut.kind} ${cut.at.join(" ")}`) : [],
    ["unresolved-link src/app/core/auth/auth.service.ts src/app/core/auth/auth.service.ts:48"],
  );
  const section = value.sections["shop-web"];
  assert.ok(section !== undefined);
  assert.deepEqual(section.value.names.map((name) => `${name.kind} ${name.name}`), ["http-host https://maps.example.com/geo", "path-prefix orders-api"]);
  assert.equal(section.status === "partial" && section.cuts[0]?.reason, "unresolved");
  assert.deepEqual(section.value.unresolved, [{ path: "src/app/core/auth/auth.service.ts", line: 48, symbol: "AuthService.refresh", transport: "http", reason: "unresolved", evidence: [{ path: "src/app/core/auth/auth.service.ts", line: 48 }] }]);
});

test("a repository that depends on another one given reads its calls through that repository's sources", async () => {
  const calls: { repo: string; libraries: readonly string[] }[] = [];
  const callSites: CallSiteReader = {
    of: async (_files, repo, libraries) => {
      calls.push({ repo, libraries: (libraries ?? []).map((file) => file.path) });
      return [];
    },
  };
  const queries = setup(
    {
      "/work/orders": {
        files: { "pom.xml": "<project/>", "src/main/java/orders/Orders.java": "class Orders {}" },
        names: [dependencyName("com.shop:shop-clients", "pom.xml", 20)],
      },
      "/work/shop-clients": { files: { "src/main/java/clients/RestClient.java": "interface RestClient {}" }, artifacts: ["com.shop:shop-clients"] },
      "/work/billing": { files: { "pom.xml": "<project/>" } },
    },
    callSites,
  );

  await queries.outwardNames({ repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-clients" }, { path: "/work/billing" }] });

  assert.deepEqual(calls, [
    { repo: "orders", libraries: ["src/main/java/clients/RestClient.java"] },
    { repo: "shop-clients", libraries: [] },
    { repo: "billing", libraries: [] },
  ]);
});

test("every repository of a request is read under its own trust declaration, and an undeclared one is untrusted", async () => {
  const declared: Record<string, "trusted"> = { "/work/orders-svc": "trusted" };
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } }, undefined, { read: async (repo) => (declared[repo] === undefined ? { ok: true, value: undefined } : { ok: true, value: declared[repo] }) });

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders-svc" }] });

  assert.deepEqual(
    Object.entries(valueOf(result).sections).map(([repo, section]) => `${repo} ${section.inputs.trust}`),
    ["orders-svc trusted", "shop-web untrusted"],
  );
  assert.deepEqual(
    valueOf(result).repositories.map(({ repo, declaredTrust }) => `${repo} ${declaredTrust ?? "none"}`).sort(),
    ["orders-svc trusted", "shop-web none"],
  );
});

const TRUSTED: TrustRecordReader = { read: async () => ({ ok: true, value: "trusted" }) };

function persisted(manifest: WorkspaceManifest | undefined, asked: string[] = []): WorkspaceDefaults {
  return {
    of: async (root) => {
      asked.push(root);
      return { ok: true, value: manifest };
    },
    resolve: (_root, resolved) => resolved,
  };
}

test("a request that names no repositories works over the persisted manifest's repositories and gateways", async () => {
  const asked: string[] = [];
  const defaults = persisted({ repos: [{ path: "/work/orders-svc" }], gateways: [{ prefix: "orders-api", repo: "orders-svc" }] }, asked);
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } }, undefined, TRUSTED, defaults);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" } });

  assert.deepEqual(asked, ["/work/shop-web"]);
  assert.deepEqual(valueOf(result).workspace, { repos: ["orders-svc", "shop-web"], gateways: [{ prefix: "orders-api", repo: "orders-svc", basis: "gateway-prefix" }], source: "persisted" });
  assert.deepEqual(Object.keys(valueOf(result).sections), ["orders-svc", "shop-web"]);
});

test("a repository the trust mode does not trust states no workspace: its persisted manifest is never read", async () => {
  const asked: string[] = [];
  const defaults = persisted({ repos: [{ path: "/work/orders-svc" }], gateways: [{ prefix: "orders-api", repo: "orders-svc" }] }, asked);
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } }, undefined, undefined, defaults);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" } });

  assert.deepEqual(asked, []);
  assert.deepEqual(valueOf(result).workspace, { repos: ["shop-web"], gateways: [], source: "none" });
  assert.deepEqual(Object.keys(valueOf(result).sections), ["shop-web"]);
});

test("a request that names repositories ignores the persisted workspace, its gateways included", async () => {
  const asked: string[] = [];
  const defaults = persisted({ repos: [{ path: "/work/billing" }], gateways: [{ prefix: "orders-api", repo: "billing" }] }, asked);
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} }, "/work/billing": { files: {} } }, undefined, undefined, defaults);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders-svc" }] });

  assert.deepEqual(asked, []);
  assert.deepEqual(valueOf(result).workspace, { repos: ["orders-svc", "shop-web"], gateways: [], source: "request" });
});

test("a gateway the request declares itself wins over the one the manifest persists", async () => {
  const defaults = persisted({ repos: [{ path: "/work/orders-svc" }], gateways: [{ prefix: "orders-api", repo: "orders-svc" }] });
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } }, undefined, TRUSTED, defaults);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, gateways: [{ prefix: "legacy", repo: "orders-svc" }] });

  assert.deepEqual(valueOf(result).workspace.gateways, [{ prefix: "legacy", repo: "orders-svc", basis: "gateway-prefix" }]);
});

test("a manifest that cannot be read is the answer's fault, never an empty workspace", async () => {
  const defaults: WorkspaceDefaults = { of: async () => ({ ok: false, fault: { kind: "unreadable", detail: ".ye-ast/workspace.json: repos: a non-empty array" } }), resolve: (_root, manifest) => manifest };
  const queries = setup({ "/work/shop-web": { files: {} } }, undefined, TRUSTED, defaults);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" } });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.fault.kind, "unreadable");
});

test("a repository that persists no manifest answers exactly as it does without one", async () => {
  const repositories: Repositories = { "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } };
  const request = { repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders-svc" }] };

  const without = await setup(repositories).outwardNames(request);
  const withNone = await setup(repositories, undefined, undefined, persisted(undefined)).outwardNames(request);

  assert.equal(JSON.stringify(withNone), JSON.stringify(without));
});

test("a request that names no repositories and finds no manifest says its answer covers the bound repository alone", async () => {
  const queries = setup({ "/work/shop-web": { files: {} } }, undefined, undefined, persisted(undefined));

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" } });

  assert.deepEqual(valueOf(result).workspace, { repos: ["shop-web"], gateways: [], source: "none" });
});

const TRIGGER = "/work/shop-web";
const SIBLING = "/work/orders-svc";
const REMOTE = "https://git.example.com/shop/orders-svc.git";
const MIRROR = "/mirror/orders-svc";
const REMOTE_SHA = "b".repeat(40);
const RELEASE_SHA = "c".repeat(40);
const LOCAL_SHA = "d".repeat(40);

test("a request remote cannot choose a refresh destination", async () => {
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup({ [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: LOCAL_SHA } }, undefined, trusted([TRIGGER, SIBLING]), undefined, { answers: [], asked });
  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  assert.deepEqual(asked, []);
  assert.equal(shaOf(valueOf(result).repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), LOCAL_SHA);
});

test("a persisted remote remains authoritative when a request names its clone", async () => {
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup({ [TRIGGER]: { files: {} }, [SIBLING]: { files: {} }, [MIRROR]: mirrorWith([], [REMOTE_SHA]) }, undefined, trusted([TRIGGER, SIBLING]), persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }), { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)], asked });
  await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: "https://attacker.example/repo" }] });
  assert.deepEqual(asked.map(({ url }) => url), [REMOTE]);
});

/** The trust record a host declared: `trusted` for the paths given, undeclared for the rest. */
function trusted(paths: readonly string[]): TrustRecordReader {
  return { read: async (repo) => ({ ok: true, value: paths.includes(repo) ? "trusted" : undefined }) };
}

/** A refresh of the declared remote, answering one listing and a mirror. */
function refreshed(url: string, listing: RemoteListing, freshness: RemoteFreshness, mirror?: string): RefreshedRemote {
  return { url, listing, freshness, ...(mirror === undefined ? {} : { mirror }) };
}

function shaOf(snapshot: SnapshotRef | undefined): string {
  return snapshot?.kind === "sha" ? snapshot.sha : "";
}

function mirrorWith(names: readonly OutwardName[], holds: readonly string[]): Repositories[string] {
  return { files: {}, names, holds };
}

test("a trusted repository with a remote is read at the remote's default-branch sha, and the answer records the resolution and the freshness", async () => {
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, remotes: [{ name: "origin", url: REMOTE }] }, [MIRROR]: mirrorWith([configurationName("http://orders.internal/orders", "src/orders.yaml", 4)], [REMOTE_SHA]) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)], asked },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const read = readOf(result);
  const value = valueOf(result);

  assert.deepEqual(asked, [{ url: REMOTE, seed: SIBLING }]);
  assert.equal(read.fact.status, "complete");
  assert.equal(shaOf(value.repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), REMOTE_SHA);
  assert.equal(read.repositorySources?.find(({ repo }) => repo === "orders-svc")?.path, MIRROR);
  assert.equal(read.repositoryRoots?.find(({ repo }) => repo === "orders-svc")?.path, SIBLING);
  const section = value.sections["orders-svc"];
  assert.ok(section !== undefined && section.status === "complete");
  assert.deepEqual(section.value.names.map(({ name }) => name), ["http://orders.internal/orders"]);
  assert.deepEqual(read.refresh, {
    resolution: [{ repo: "orders-svc", step: "default-branch", consulted: [{ branch: "main", sha: REMOTE_SHA }], sha: REMOTE_SHA }],
    freshness: [{ repo: "orders-svc", url: REMOTE, freshness: { status: "verified" } }],
  });
});

test("an explicit revision of a refreshed repository picks that branch of the remote's listing", async () => {
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {} }, [MIRROR]: mirrorWith([], [RELEASE_SHA]) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }, { name: "release", sha: RELEASE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE, revision: "release" }] });
  const read = readOf(result);

  assert.equal(shaOf(valueOf(result).repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), RELEASE_SHA);
  assert.deepEqual(read.refresh?.resolution, [{ repo: "orders-svc", asked: "release", step: "explicit", consulted: [{ branch: "release", sha: RELEASE_SHA }], sha: RELEASE_SHA }]);
});

test("the branch named like the trigger's line wins over the remote's default branch", async () => {
  const queries = setup(
    { [TRIGGER]: { files: {}, branch: "release" }, [SIBLING]: { files: {} }, [MIRROR]: mirrorWith([], [RELEASE_SHA]) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }, { name: "release", sha: RELEASE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const read = readOf(result);

  assert.equal(shaOf(valueOf(result).repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), RELEASE_SHA);
  assert.deepEqual(read.refresh?.resolution, [{ repo: "orders-svc", step: "trigger-line", consulted: [{ branch: "release", sha: RELEASE_SHA }], sha: RELEASE_SHA }]);
});

test("a request naming HEAD as the trigger's revision scopes the refresh by the branch HEAD points at", async () => {
  const queries = setup(
    { [TRIGGER]: { files: {}, branch: "release" }, [SIBLING]: { files: {} }, [MIRROR]: mirrorWith([], [RELEASE_SHA]) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }, { name: "release", sha: RELEASE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER, revision: "HEAD" }, repos: [{ path: SIBLING, remote: REMOTE }] });

  assert.deepEqual(readOf(result).refresh?.resolution, [{ repo: "orders-svc", step: "trigger-line", consulted: [{ branch: "release", sha: RELEASE_SHA }], sha: RELEASE_SHA }]);
});

test("a pinned sha the mirror lacks is an unknown section naming that sha, and the repository is left out of the answer's repositories", async () => {
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: LOCAL_SHA }, [MIRROR]: mirrorWith([], []) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const read = readOf(result);
  const value = valueOf(result);

  const section = value.sections["orders-svc"];
  assert.ok(section !== undefined && section.status === "unknown");
  assert.equal(read.repositoryRoots?.find(({ repo }) => repo === "orders-svc")?.path, SIBLING);
  assert.equal(section.reason, "revision-unavailable");
  assert.equal(section.snapshot.kind === "sha" ? section.snapshot.sha : "", REMOTE_SHA);
  assert.equal(value.repositories.some(({ repo }) => repo === "orders-svc"), false);
  assert.equal(value.repositorySnapshots.some(({ repo }) => repo === "orders-svc"), false);
  assert.deepEqual(value.workspace.repos, ["orders-svc", "shop-web"]);
  assert.equal(read.fact.status, "partial");
  assert.deepEqual(read.fact.status === "partial" ? read.fact.cuts : [], [{ kind: "section", at: ["orders-svc"] }]);
});

test("a listing that chooses no sha leaves the section unknown with the local clone's revision as its snapshot", async () => {
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: LOCAL_SHA }, [MIRROR]: mirrorWith([], []) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "draft", sha: REMOTE_SHA }] }, { status: "verified" }, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const read = readOf(result);
  const section = valueOf(result).sections["orders-svc"];

  assert.ok(section !== undefined && section.status === "unknown");
  assert.equal(section.reason, "revision-unavailable");
  assert.equal(section.snapshot.kind === "sha" ? section.snapshot.sha : "", LOCAL_SHA);
  assert.deepEqual(read.refresh?.resolution, [{ repo: "orders-svc", step: "revision-unavailable", consulted: [] }]);
});

test("an untrusted repository with a remote is read from its own clone and the answer carries no sidecar", async () => {
  const repositories: Repositories = { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: LOCAL_SHA } };
  const request = { repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] };
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup(repositories, undefined, trusted([TRIGGER]), undefined, { answers: [], asked });

  const result = await queries.outwardNames(request);
  const read = readOf(result);
  const value = valueOf(result);

  assert.deepEqual(asked, []);
  assert.equal("refresh" in read, false);
  assert.equal(shaOf(value.repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), LOCAL_SHA);
  assert.equal(read.repositorySources?.find(({ repo }) => repo === "orders-svc")?.path, SIBLING);
  assert.equal(JSON.stringify(read), JSON.stringify(readOf(await setup(repositories, undefined, trusted([TRIGGER])).outwardNames(request))));
});

test("an offline request refreshes no remote and reads every repository from its own clone, byte-identical to a workspace with no refresh at all", async () => {
  const repositories: Repositories = { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: LOCAL_SHA } };
  const request = { repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }], offline: true };
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup(
    repositories,
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)], asked },
  );

  const result = await queries.outwardNames(request);
  const read = readOf(result);
  const value = valueOf(result);

  assert.deepEqual(asked, []);
  assert.equal("refresh" in read, false);
  assert.equal(shaOf(value.repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), LOCAL_SHA);
  assert.equal(read.repositorySources?.find(({ repo }) => repo === "orders-svc")?.path, SIBLING);
  assert.deepEqual(read.fact, readOf(await setup(repositories, undefined, trusted([TRIGGER, SIBLING])).outwardNames({ ...request, offline: true })).fact);
});

test("a failed refresh with a recorded listing still pins from it and answers the recorded freshness", async () => {
  const failed: RemoteFreshness = { status: "unverified", reason: "failed", lastVerifiedAt: "2026-11-02T10:00:00.000Z" };
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {} }, [MIRROR]: mirrorWith([], [REMOTE_SHA]) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, failed, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const read = readOf(result);

  assert.equal(shaOf(valueOf(result).repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), REMOTE_SHA);
  assert.deepEqual(read.refresh?.freshness, [{ repo: "orders-svc", url: REMOTE, freshness: failed }]);
});

test("the trigger repository is read locally even when it declares a remote", async () => {
  const triggerRemote = "https://git.example.com/shop/shop-web.git";
  const asked: RemoteRefreshRequest[] = [];
  const queries = setup(
    { [TRIGGER]: { files: {}, sha: LOCAL_SHA, remotes: [{ name: "origin", url: triggerRemote }] }, [SIBLING]: { files: {} }, [MIRROR]: mirrorWith([], [REMOTE_SHA]) },
    undefined,
    trusted([TRIGGER, SIBLING]),
    persisted({ repos: [{ path: SIBLING, remote: REMOTE }] }),
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)], asked },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER, remote: triggerRemote }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const value = valueOf(result);
  const read = readOf(result);

  assert.deepEqual(asked.map(({ url }) => url), [REMOTE]);
  assert.equal(shaOf(value.repositorySnapshots.find(({ repo }) => repo === "shop-web")?.snapshot), LOCAL_SHA);
  assert.equal(read.repositorySources?.find(({ repo }) => repo === "shop-web")?.path, TRIGGER);
});

test("an absent trust declaration and an explicit untrusted declaration have distinct workspace and decision identities", async () => {
  const repositories = { "/work/app": { files: {} } };
  const absent = setup(repositories);
  const explicit = setup(repositories, undefined, { read: async () => ({ ok: true, value: "untrusted" }) });
  const request = { repo: { path: "/work/app" } };
  const before = readOf(await absent.outwardNames(request)).fact;
  const after = readOf(await explicit.outwardNames(request)).fact;
  assert.equal(before.inputs.trust, after.inputs.trust);
  assert.equal(sameIdentity(before, after), false);
  const decisionQueries = (workspace: ReturnType<typeof setup>) => createDecisionQueries({ workspace, digest: { of: (value) => value }, vcs: { remotes: async () => ({ ok: true, value: [] }) } });
  const unknownTrust = await decisionQueries(absent).decisions(request);
  const knownTrust = await decisionQueries(explicit).decisions(request);
  assert.ok(unknownTrust.ok && knownTrust.ok && unknownTrust.value.fact.status !== "unknown" && knownTrust.value.fact.status !== "unknown");
  assert.ok(unknownTrust.value.fact.value.decisions.some((decision) => decision.kind === "trust"));
  assert.equal(knownTrust.value.fact.value.decisions.some((decision) => decision.kind === "trust"), false);
  assert.equal(sameIdentity(unknownTrust.value.fact, knownTrust.value.fact), false);
});
test("workspace cancellation while reading call sites cannot return a completed fact", async () => {
  const controller = new AbortController();
  const queries = setup({ "/work/app": { files: { "app.ts": "app" } } }, { of: async () => {
    controller.abort();
    return [];
  } });
  const result = await queries.outwardNames({ repo: { path: "/work/app" }, signal: controller.signal });
  assert.ok(!result.ok);
  assert.equal(result.fault.kind, "aborted");
});

const ORDERS_HANDLER = { path: "src/main/java/app/Orders.java", symbol: "Orders.create", line: 10 };
const LISTENER_HANDLER = { path: "src/main/java/app/OrdersListener.java", symbol: "OrdersListener.on", line: 8 };

function served(entrypoint: Entrypoint): Finding<Entrypoint> {
  return { status: "complete", value: entrypoint, evidence: [] };
}

function postRoute(path: string, handler = ORDERS_HANDLER): Finding<Entrypoint> {
  return served({ kind: "http-route", name: `POST ${path}`, method: "POST", path, handler, basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] } });
}

function natsListener(destination: string, handler = LISTENER_HANDLER): Finding<Entrypoint> {
  return served({ kind: "listener", name: `nats ${destination}`, protocol: "nats", destination, handler });
}

function postSite(repo: string, path: string, line = 7): CallSite {
  return { repo, file: `src/app/${repo}.api.ts`, line, symbol: `${repo}.call${line}`, transport: "http", target: { status: "complete", value: { method: "POST", path }, evidence: [] } };
}

function publishSite(repo: string, destination: string, line = 7): CallSite {
  return { repo, file: `src/main/java/app/${repo}/Publisher.java`, line, symbol: `${repo}.publish${line}`, transport: "event", target: { status: "complete", value: { protocol: "nats", destination, role: "publish" }, evidence: [] } };
}

/** Call sites by repository id, as the reader answers them. */
function sitesOf(byRepo: Record<string, readonly CallSite[]>): CallSiteReader {
  return { of: async (_files, repo) => byRepo[repo] ?? [] };
}

const LINKED = { repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders" }] };

test("workspace answers each link between the repositories it read, the same Link the workspace impact admits for those snapshots", async () => {
  const repositories: Repositories = { "/work/shop-web": { files: {} }, "/work/orders": { files: {}, entrypoints: [postRoute("/orders")] } };
  const discovery = setup(repositories, sitesOf({ "shop-web": [postSite("shop-web", "/orders")] }));
  const value = valueOf(await discovery.outwardNames(LINKED));

  const impact = { callers: async () => {
    const found = readOf(await discovery.outwardNames({ repo: { path: "/work/orders" } })).fact;
    return { ok: true as const, value: { ...found, status: "complete" as const, value: { seeds: [], symbols: [], entrypoints: [{ kind: "http-route", name: "POST /orders", handler: ORDERS_HANDLER, depth: 0, confidence: 1, seeds: [] }], cost: { expansionsUsed: 0 } } } };
  } } as unknown as ImpactQueries;
  const impacted = await createWorkspaceImpactQueries({ workspace: discovery, impact, digest: { of: (text) => text } }).callers({ repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-web" }], targets: [{ file: ORDERS_HANDLER.path, symbol: ORDERS_HANDLER.symbol }] });
  assert.ok(impacted.ok && impacted.value.fact.status !== "unknown");

  assert.deepEqual(value.links.map(({ from, to, basis, confidence }) => `${from.repo}:${from.line} -> ${to.repo} ${to.name} (${basis} ${confidence})`), ["shop-web:7 -> orders POST /orders (exact 1)"]);
  assert.deepEqual(value.links, impacted.value.fact.value.links.map(({ link }) => link));
  assert.deepEqual(value.unlinked, []);
});

test("workspace exposes the gateways the join inferred beside those declared, each with its basis", async () => {
  const repositories: Repositories = { "/work/shop-web": { files: {} }, "/work/orders": { files: {}, entrypoints: [postRoute("/orders")] } };
  const queries = setup(repositories, sitesOf({ "shop-web": [postSite("shop-web", "/orders-api/orders"), postSite("shop-web", "/edge/orders", 9)] }));

  const value = valueOf(await queries.outwardNames({ ...LINKED, gateways: [{ prefix: "edge", repo: "orders" }] }));

  assert.deepEqual(value.workspace.gateways, [{ prefix: "edge", repo: "orders", basis: "gateway-prefix" }, { prefix: "orders-api", repo: "orders", basis: "route-overlap" }]);
  assert.deepEqual(value.links.map(({ from, basis }) => `${from.line} ${basis}`), ["7 route-overlap", "9 gateway-prefix"]);
});

test("a call the join reaches without a link is an explicit outcome: unmatched under a declared service, ambiguous between two, the latter a cut of its section", async () => {
  const repositories: Repositories = {
    "/work/shop-web": { files: {} },
    "/work/orders": { files: {}, entrypoints: [postRoute("/orders"), postRoute("/shared", { ...ORDERS_HANDLER, symbol: "Orders.shared" })] },
    "/work/billing": { files: {}, entrypoints: [postRoute("/shared", { ...ORDERS_HANDLER, symbol: "Billing.shared" })] },
  };
  const queries = setup(repositories, sitesOf({ "shop-web": [postSite("shop-web", "/shared", 3), postSite("shop-web", "/orders/missing", 5)] }));

  const read = readOf(await queries.outwardNames({ ...LINKED, repos: [{ path: "/work/orders" }, { path: "/work/billing" }] }));
  const value = valueOf({ ok: true, value: read });

  assert.deepEqual(value.links, []);
  assert.deepEqual(value.unlinked, [
    { from: { repo: "shop-web", file: "src/app/shop-web.api.ts", line: 3, symbol: "shop-web.call3" }, transport: "http", outcome: "ambiguous", name: "shared", repos: ["billing", "orders"] },
    { from: { repo: "shop-web", file: "src/app/shop-web.api.ts", line: 5, symbol: "shop-web.call5" }, transport: "http", outcome: "unmatched", name: "/orders/missing" },
  ]);
  const section = value.sections["shop-web"];
  assert.equal(section?.status, "partial");
  assert.deepEqual(section?.status === "partial" ? section.cuts : [], [{ kind: "unresolved-link", at: ["src/app/shop-web.api.ts", "src/app/shop-web.api.ts:3"] }]);
});

test("a published destination is an outward name the repository whose listener the join linked serves, with basis event-destination; one nothing consumes is unserved", async () => {
  const repositories: Repositories = { "/work/shop-web": { files: {} }, "/work/orders": { files: {}, entrypoints: [natsListener("orders.*")] } };
  const queries = setup(repositories, sitesOf({ "shop-web": [publishSite("shop-web", "orders.{}"), publishSite("shop-web", "audit.logged", 9)] }));

  const value = valueOf(await queries.outwardNames(LINKED));

  assert.deepEqual(value.sections["shop-web"]?.status === "unknown" ? [] : value.sections["shop-web"]?.value.names.map(({ name, kind }) => `${kind} ${name}`), ["destination audit.logged", "destination orders.{}"]);
  assert.deepEqual(value.candidates, [{
    name: "orders.{}", repo: "orders", basis: "event-destination",
    evidence: [{ path: "src/main/java/app/OrdersListener.java", line: 8, repo: "orders" }, { path: "src/main/java/app/shop-web/Publisher.java", line: 7, repo: "shop-web" }],
  }]);
  assert.deepEqual(value.unserved.map(({ name }) => name), ["audit.logged"]);
});

test("a destination is never served by a repository whose name equals it: only a listener the join linked serves it", async () => {
  const repositories: Repositories = { "/work/shop-web": { files: {} }, "/work/audit": { files: {} } };
  const queries = setup(repositories, sitesOf({ "shop-web": [publishSite("shop-web", "audit")] }));

  const value = valueOf(await queries.outwardNames({ ...LINKED, repos: [{ path: "/work/audit" }] }));

  assert.deepEqual(value.candidates, []);
  assert.deepEqual(value.unserved.map(({ name, kind }) => `${kind} ${name}`), ["destination audit"]);
});

test("a listener a repository inherits from a repository it depends on is linked from the publisher", async () => {
  const extractions: string[] = [];
  const repositories: Repositories = {
    "/work/shop-web": { files: {} },
    "/work/orders": {
      files: { "pom.xml": "<project/>", "src/main/java/orders/Created.java": "class Created {}" },
      names: [dependencyName("com.shop:messenger", "pom.xml", 20)],
      inherited: [natsListener("orders.created")],
    },
    "/work/messenger": { files: { "src/main/java/lib/Base.java": "class Base {}" }, artifacts: ["com.shop:messenger"] },
  };
  const queries = setup(repositories, sitesOf({ "shop-web": [publishSite("shop-web", "orders.created")] }), undefined, undefined, undefined, false, undefined, undefined, undefined, { extract: () => extractions.push("read") });

  const value = valueOf(await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders" }, { path: "/work/messenger" }] }));

  assert.deepEqual(value.links.map(({ from, to }) => `${from.repo} -> ${to.repo} ${to.name}`), ["shop-web -> orders nats orders.created"]);
  assert.equal(extractions.length, 4);
});

test("without a dependency on a repository given, a listener that repository's sources would complete stays unread", async () => {
  const repositories: Repositories = {
    "/work/shop-web": { files: {} },
    "/work/orders": { files: { "pom.xml": "<project/>" }, inherited: [natsListener("orders.created")] },
    "/work/messenger": { files: {}, artifacts: ["com.shop:messenger"] },
  };
  const queries = setup(repositories, sitesOf({ "shop-web": [publishSite("shop-web", "orders.created")] }));

  const value = valueOf(await queries.outwardNames({ repo: { path: "/work/shop-web" }, repos: [{ path: "/work/orders" }, { path: "/work/messenger" }] }));

  assert.deepEqual(value.links, []);
});

test("duplicate dependency coordinates are a typed cut and never a union of library sources", async () => {
  const libraries: string[][] = [];
  const queries = setup({
    "/work/app": { files: { "pom.xml": "<project/>" }, names: [dependencyName("com.acme:clients", "pom.xml", 4)] },
    "/work/one": { files: { "One.java": "class One {}" }, artifacts: ["com.acme:clients"] },
    "/work/two": { files: { "Two.java": "class Two {}" }, artifacts: ["com.acme:clients"] },
  }, { of: async (_files, repo, sources) => { if (repo === "app") libraries.push((sources ?? []).map(s => s.path)); return []; } });
  const ask = { repo: { path: "/work/app" }, repos: [{ path: "/work/two" }, { path: "/work/one" }] };
  const first = readOf(await queries.outwardNames(ask)).fact;
  assert.deepEqual(libraries, [[]]);
  assert.notEqual(first.status, "unknown");
  if (first.status === "unknown") return;
  const section = first.value.sections.app;
  assert.equal(section?.status, "partial");
  assert.deepEqual(section?.status === "partial" && section.cuts, [{ kind: "unresolved-link", reason: "unresolved", at: ["pom.xml", "pom.xml:4"], dependency: { name: "com.acme:clients", reason: "ambiguous", candidates: ["one", "two"] } }]);
  assert.deepEqual(readOf(await queries.outwardNames({ ...ask, repos: [...ask.repos].reverse() })).fact, first);
});

test("a dependency matching only a clone name stays an explicit unproven-coordinate cut", async () => {
  for (const id of ["clients", "com.acme:clients"]) {
    const libraries: string[][] = [];
    const queries = setup({
      "/work/app": { files: { "pom.xml": "<project/>" }, names: [dependencyName("com.acme:clients", "pom.xml", 7)] },
      "/work/clients": { files: { "Client.java": "class Client {}" } },
    }, { of: async (_files, repo, sources) => { if (repo === "app") libraries.push((sources ?? []).map(s => s.path)); return []; } });
    const value = valueOf(await queries.outwardNames({ repo: { path: "/work/app" }, repos: [{ path: "/work/clients", id }] }));
    assert.deepEqual(libraries, [[]]);
    const section = value.sections.app;
    assert.deepEqual(section?.status === "partial" && section.cuts[0]?.dependency, { name: "com.acme:clients", reason: "unproven-coordinates", candidates: [id] });
  }
});

test("a unique proven dependency ignores a same-artifact repository from another Maven group", async () => {
  const libraries: string[][] = [];
  const queries = setup({
    "/work/app": { files: { "pom.xml": "<project/>" }, names: [dependencyName("com.acme:clients", "pom.xml", 4)] },
    "/work/clients": { files: { "Correct.java": "class Correct {}" }, artifacts: ["com.acme:clients"] },
    "/work/wrong": { files: { "Wrong.java": "class Wrong {}" }, artifacts: ["org.other:clients"] },
  }, { of: async (_files, repo, sources) => { if (repo === "app") libraries.push((sources ?? []).map(s => s.path)); return []; } });
  const value = valueOf(await queries.outwardNames({ repo: { path: "/work/app" }, repos: [{ path: "/work/clients" }, { path: "/work/wrong" }] }));
  assert.deepEqual(libraries, [["Correct.java"]]);
  assert.equal(value.sections.app?.status, "complete");
});

test("Maven coordinates that are incomplete or still contain properties cannot authorize library sources", async () => {
  for (const coordinate of ["clients", "\u0024{group}:clients"]) {
    const libraries: string[][] = [];
    const queries = setup({
      "/work/app": { files: { "pom.xml": "<project/>" }, names: [dependencyName(coordinate, "pom.xml", 4)] },
      "/work/clients": { files: { "Client.java": "class Client {}" }, artifacts: [coordinate] },
    }, { of: async (_files, repo, sources) => { if (repo === "app") libraries.push((sources ?? []).map(s => s.path)); return []; } });
    const value = valueOf(await queries.outwardNames({ repo: { path: "/work/app" }, repos: [{ path: "/work/clients" }] }));
    assert.deepEqual(libraries, [[]]);
    assert.deepEqual(value.candidates, []);
    const section = value.sections.app;
    assert.equal(section?.status === "partial" && section.cuts[0]?.dependency?.reason, "unproven-coordinates");
  }
});

test("a conflicting Maven group is unserved rather than a speculative dependency ambiguity", async () => {
  const libraries: string[][] = [];
  const queries = setup({
    "/work/app": { files: { "pom.xml": "<project/>" }, names: [dependencyName("com.acme:clients", "pom.xml", 4)] },
    "/work/clients": { files: { "Wrong.java": "class Wrong {}" }, artifacts: ["org.other:clients"] },
  }, { of: async (_files, repo, sources) => { if (repo === "app") libraries.push((sources ?? []).map(s => s.path)); return []; } });
  const value = valueOf(await queries.outwardNames({ repo: { path: "/work/app" }, repos: [{ path: "/work/clients" }] }));
  assert.deepEqual(libraries, [[]]);
  assert.equal(value.sections.app?.status, "complete");
  assert.deepEqual(value.unserved.map(({ name }) => name), ["com.acme:clients"]);
});

test("an ambiguous dependency does not suppress independently proven library sources", async () => {
  const libraries: string[][] = [];
  const queries = setup({
    "/work/app": { files: { "pom.xml": "<project/>" }, names: [dependencyName("com.acme:clients", "pom.xml", 4), dependencyName("com.acme:safe", "pom.xml", 5)] },
    "/work/one": { files: { "One.java": "class One {}" }, artifacts: ["com.acme:clients"] },
    "/work/two": { files: { "Two.java": "class Two {}" }, artifacts: ["com.acme:clients"] },
    "/work/safe": { files: { "Safe.java": "class Safe {}" }, artifacts: ["com.acme:safe"] },
  }, { of: async (_files, repo, sources) => { if (repo === "app") libraries.push((sources ?? []).map(s => s.path)); return []; } });
  const value = valueOf(await queries.outwardNames({ repo: { path: "/work/app" }, repos: [{ path: "/work/one" }, { path: "/work/two" }, { path: "/work/safe" }] }));
  assert.deepEqual(libraries, [["Safe.java"]]);
  const section = value.sections.app;
  assert.deepEqual(section?.status === "partial" && section.cuts.map(cut => cut.dependency?.name), ["com.acme:clients"]);
});
