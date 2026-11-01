import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntrypointExtractor } from "../../ports/entrypoint-extractor.port.ts";
import type { CommitExport, ExportedFile, ExportPlan, RemoteRef, Vcs, VcsFault } from "../../ports/vcs.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { SourceReader } from "../../ports/source-reader.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { Evidence, Fact } from "../../domain/shared/fact.ts";
import type { WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import type { WorkspaceRepositoryRequest } from "../../ports/workspace-repos.port.ts";
import type { OutwardName } from "../../domain/topology/outward-name.ts";
import type { CallSiteReader } from "../../domain/topology/call-site.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { WorkspaceQueriesDeps } from "./workspace-queries.ts";
import { createWorkspaceQueries } from "./workspace-queries.ts";

const SHA = "a".repeat(40);

function valueOf(result: Result<Fact<WorkspaceValue>, unknown>): WorkspaceValue {
  assert.ok(result.ok);
  assert.notEqual(result.value.status, "unknown");
  return (result.value as { value: WorkspaceValue }).value;
}

type Repositories = Record<string, { files: Record<string, string>; remotes?: RemoteRef[]; names?: OutwardName[]; artifacts?: string[] }>;

const matcher: PathMatcher = { matches: () => true };

function setup(repositories: Repositories, callSites: CallSiteReader = { of: async () => [] }) {
  let exported: string | undefined;
  const vcs: Vcs = {
    resolveCommit: async (repo): Promise<Result<string, VcsFault>> => (repositories[repo] === undefined ? { ok: false, fault: { kind: "not-repository-root", detail: repo } } : { ok: true, value: SHA }),
    remotes: async (repo) => ({ ok: true, value: repositories[repo]?.remotes ?? [] }),
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
  assert.equal(result.value.snapshot.repo, "shop-web");
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
