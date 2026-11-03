import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntrypointExtractor } from "../../ports/entrypoint-extractor.port.ts";
import type { CommitExport, ExportedFile, ExportPlan, RemoteRef, Vcs, VcsFault } from "../../ports/vcs.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { SourceReader } from "../../ports/source-reader.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { Evidence, Fact, SnapshotRef } from "../../domain/shared/fact.ts";
import type { WorkspaceRead, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import type { RefreshedRemote, RemoteRefreshRequest } from "../../ports/remote-refresh.port.ts";
import type { RemoteFreshness, RemoteListing } from "../../domain/topology/remote-snapshot.ts";
import type { WorkspaceRepositoryRequest } from "../../ports/workspace-repos.port.ts";
import type { OutwardName } from "../../domain/topology/outward-name.ts";
import type { CallSiteReader } from "../../domain/topology/call-site.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { WorkspaceDefaults, WorkspaceManifest } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceQueriesDeps } from "./workspace-queries.ts";
import { createWorkspaceQueries } from "./workspace-queries.ts";

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
) {
  let exported: string | undefined;
  const vcs: Vcs = {
    resolveCommit: async (repo, revision): Promise<Result<string, VcsFault>> => {
      const held = repositories[repo];
      if (held === undefined) return { ok: false, fault: { kind: "not-repository-root", detail: repo } };
      if (/^[0-9a-f]{40}$/.test(revision) && held.holds !== undefined && !held.holds.includes(revision)) return { ok: false, fault: { kind: "unknown-revision", detail: revision } };
      return { ok: true, value: /^[0-9a-f]{40}$/.test(revision) ? revision : (held.sha ?? SHA) };
    },
    remotes: async (repo) => ({ ok: true, value: repositories[repo]?.remotes ?? [] }),
    headBranch: async (repo) => ({ ok: true, value: repositories[repo]?.branch }),
    repositoryName: async () => ({ ok: true, value: "library" }),
    exportCommit: async (repo, _sha, _destination, plan) => {
      exported = repo;
      const files: ExportedFile[] = Object.keys(repositories[repo]?.files ?? {}).map((path) => ({ path, blob: path, written: plan.write(path) }));
      return { ok: true, value: { files, skipped: [] } };
    },
  };
  const scratch: ScratchDirectory = { create: async () => "/scratch", remove: async () => undefined };
  const reader: SourceReader = { read: async (_root, paths) => paths.map((path) => ({ path, content: repositories[exported ?? ""]?.files[path] ?? "" })) };
  const extractor: EntrypointExtractor = { extract: async () => [] };
  const digest: Digest = { of: (text) => `digest(${text})` };
  const deps: WorkspaceQueriesDeps = {
    vcs,
    scratch,
    reader,
    extractor,
    digest,
    matcher,
    callSites,
    evidence: { names: () => repositories[exported ?? ""]?.names ?? [], artifacts: () => repositories[exported ?? ""]?.artifacts ?? [] },
    producer: { name: "ye-ast", version: "0.0.0" },
    engines: {},
    ...(trust === undefined ? {} : { trust }),
    ...(defaults === undefined ? {} : { defaults }),
    ...(refresh === undefined ? {} : { refresh: { refresh: async (requests) => {
      refresh.asked?.push(...requests);
      return requests.map((request) => refresh.answers.find((answer) => answer.url === request.url)!);
    } } }),
  };
  return createWorkspaceQueries(deps);
}

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
    ["library remote package.json:3, .git/config:1 via upstream"],
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
      "/work/shop-clients": { files: { "src/main/java/clients/RestClient.java": "interface RestClient {}" } },
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
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } }, undefined, undefined, defaults);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" } });

  assert.deepEqual(asked, ["/work/shop-web"]);
  assert.deepEqual(valueOf(result).workspace, { repos: ["orders-svc", "shop-web"], gateways: [{ prefix: "orders-api", repo: "orders-svc" }], source: "persisted" });
  assert.deepEqual(Object.keys(valueOf(result).sections), ["orders-svc", "shop-web"]);
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
  const queries = setup({ "/work/shop-web": { files: {} }, "/work/orders-svc": { files: {} } }, undefined, undefined, defaults);

  const result = await queries.outwardNames({ repo: { path: "/work/shop-web" }, gateways: [{ prefix: "legacy", repo: "orders-svc" }] });

  assert.deepEqual(valueOf(result).workspace.gateways, [{ prefix: "legacy", repo: "orders-svc" }]);
});

test("a manifest that cannot be read is the answer's fault, never an empty workspace", async () => {
  const defaults: WorkspaceDefaults = { of: async () => ({ ok: false, fault: { kind: "unreadable", detail: ".ye-ast/workspace.json: repos: a non-empty array" } }), resolve: (_root, manifest) => manifest };
  const queries = setup({ "/work/shop-web": { files: {} } }, undefined, undefined, defaults);

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
    trusted([SIBLING]),
    undefined,
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)], asked },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const read = readOf(result);
  const value = valueOf(result);

  assert.deepEqual(asked, [{ url: REMOTE, seed: SIBLING }]);
  assert.equal(read.fact.status, "complete");
  assert.equal(shaOf(value.repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), REMOTE_SHA);
  assert.equal(value.repositories.find(({ repo }) => repo === "orders-svc")?.path, MIRROR);
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
    trusted([SIBLING]),
    undefined,
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
    trusted([SIBLING]),
    undefined,
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
    trusted([SIBLING]),
    undefined,
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }, { name: "release", sha: RELEASE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER, revision: "HEAD" }, repos: [{ path: SIBLING, remote: REMOTE }] });

  assert.deepEqual(readOf(result).refresh?.resolution, [{ repo: "orders-svc", step: "trigger-line", consulted: [{ branch: "release", sha: RELEASE_SHA }], sha: RELEASE_SHA }]);
});

test("a pinned sha the mirror lacks is an unknown section naming that sha, and the repository is left out of the answer's repositories", async () => {
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {}, sha: LOCAL_SHA }, [MIRROR]: mirrorWith([], []) },
    undefined,
    trusted([SIBLING]),
    undefined,
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)] },
  );

  const result = await queries.outwardNames({ repo: { path: TRIGGER }, repos: [{ path: SIBLING, remote: REMOTE }] });
  const read = readOf(result);
  const value = valueOf(result);

  const section = value.sections["orders-svc"];
  assert.ok(section !== undefined && section.status === "unknown");
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
    trusted([SIBLING]),
    undefined,
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
  assert.equal(value.repositories.find(({ repo }) => repo === "orders-svc")?.path, SIBLING);
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
    undefined,
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)], asked },
  );

  const result = await queries.outwardNames(request);
  const read = readOf(result);
  const value = valueOf(result);

  assert.deepEqual(asked, []);
  assert.equal("refresh" in read, false);
  assert.equal(shaOf(value.repositorySnapshots.find(({ repo }) => repo === "orders-svc")?.snapshot), LOCAL_SHA);
  assert.equal(value.repositories.find(({ repo }) => repo === "orders-svc")?.path, SIBLING);
  assert.equal(JSON.stringify(read), JSON.stringify(readOf(await setup(repositories, undefined, trusted([TRIGGER, SIBLING])).outwardNames({ ...request, offline: true }))));
});

test("a failed refresh with a recorded listing still pins from it and answers the recorded freshness", async () => {
  const failed: RemoteFreshness = { status: "unverified", reason: "failed", lastVerifiedAt: "2026-11-02T10:00:00.000Z" };
  const queries = setup(
    { [TRIGGER]: { files: {} }, [SIBLING]: { files: {} }, [MIRROR]: mirrorWith([], [REMOTE_SHA]) },
    undefined,
    trusted([SIBLING]),
    undefined,
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
    undefined,
    { answers: [refreshed(REMOTE, { branches: [{ name: "main", sha: REMOTE_SHA }], defaultBranch: "main" }, { status: "verified" }, MIRROR)], asked },
  );

  const value = valueOf(await queries.outwardNames({ repo: { path: TRIGGER, remote: triggerRemote }, repos: [{ path: SIBLING, remote: REMOTE }] }));

  assert.deepEqual(asked.map(({ url }) => url), [REMOTE]);
  assert.equal(shaOf(value.repositorySnapshots.find(({ repo }) => repo === "shop-web")?.snapshot), LOCAL_SHA);
  assert.equal(value.repositories.find(({ repo }) => repo === "shop-web")?.path, TRIGGER);
});
