import { test } from "node:test";
import assert from "node:assert/strict";
import { type Hypothesis, parseHypothesis } from "../../domain/contracts/hypothesis.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import type { Carrier } from "../../domain/contracts/consumer-flow.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { DeclaredMemberNames } from "../../ports/declared-member-names.port.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";
import type { ConsumerSession, ServingWorkspace } from "../../ports/consumer-sources.port.ts";
import type { WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import type { ReadScope } from "../snapshot/read-snapshot.ts";
import { NOTHING_DECLARED } from "../navigation/edge-targets.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "../navigation/fake-code-graph.testing.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import { createConsumerSources, isCallOf } from "./consumer-sources.ts";

const sha = "a".repeat(40);

const route = (name: string, path: string): Entrypoint => ({
  kind: "http-route",
  name,
  method: "GET",
  path,
  handler: { path: "src/Controller.java", symbol: "handle", line: 10 },
  basePath: { status: "complete", value: { prefix: "", sources: [] }, evidence: [] } as never,
});

const call = (repo: string, path: string, line: number): CallSite => ({
  repo,
  file: "src/client.ts",
  line,
  symbol: "load",
  transport: "http",
  target: { status: "complete", value: { method: "GET", path }, evidence: [] },
});

function hypothesis(path: string): Hypothesis {
  const parsed = parseHypothesis({ method: "GET", path, target: "response", property: "total", change: "nullable" });
  assert.ok(parsed.ok);
  return parsed.value;
}

interface Workbench {
  withWorkspace<T>(use: (workspace: ServingWorkspace) => Promise<T>): Promise<T>;
  exported: string[];
  flowReads: string[];
  callSiteReads: () => number;
}

function workbench(layout: { routes: Record<string, Entrypoint[]>; calls: Record<string, CallSite[]> }): Workbench {
  const exported: string[] = [];
  const flowReads: string[] = [];
  let callSiteReads = 0;
  const repos = [...new Set([...Object.keys(layout.routes), ...Object.keys(layout.calls)])].sort();
  const repositories = repos.map((repo) => ({
    repo,
    entrypoints: (layout.routes[repo] ?? []).map((value) => ({ status: "complete", value, evidence: [] })),
    get callSites() {
      if (repo === "web") callSiteReads++;
      return layout.calls[repo] ?? [];
    },
  })) as unknown as WorkspaceRepository[];
  const fact = {
    status: "complete",
    schema: "0",
    snapshot: { repo: "api", kind: "sha", sha },
    producer: { name: "test", version: "0" },
    inputs: { engines: {}, declaredConfig: {} },
    evidence: [],
    value: { repositories, workspace: { repos, gateways: [], source: "request" }, sections: {} },
  };
  const context = {
    plans: repos.map((repo) => ({ kind: "read", at: { source: `/${repo}`, declared: `/${repo}`, repoId: repo, revision: "HEAD" } })),
    scope: { include: [], exclude: [] },
    selection: () => true,
    preparation: { obtain: (_key: string, _deps: unknown, build: (root: string, keep: ReadScope["keep"]) => Promise<unknown>) => build("/root", (sources) => [...sources]) },
    signal: undefined,
  };
  const sources = createConsumerSources({
    operation: {
      withRead: async (_request: unknown, use: (read: unknown, context: unknown) => Promise<{ ok: boolean; value?: unknown }>) => {
        const result = await use({ fact }, context);
        return result.ok ? { ok: true, value: { value: result.value } } : result;
      },
    } as never,
    heads: {
      vcs: { exportCommit: async (repo: string) => { exported.push(repo); return { ok: true, value: { files: [], skipped: [] } }; } },
      reader: { read: async () => [] },
      scratch: { create: async () => "/scratch", remove: async () => undefined },
      graph: { index: async () => ({ ok: false, fault: { kind: "stage-failed", detail: "" } }) },
      digest: { of: () => "d" },
      matcher: { matches: () => true },
      producer: { name: "test", version: "0" },
    } as never,
    digest: { of: () => "d" },
    flow: async (_files, repo) => {
      flowReads.push(repo);
      return { follow: () => ({ uses: [], next: [], frontiers: [] }) };
    },
    metadata: { read: async () => ({ classes: [] }) } as never,
    templateFlow: { follow: () => ({ uses: [], next: [], frontiers: [] }) },
    origins: () => ({ ofBody: async () => [], ofArgument: async () => ({ kind: "omitted" }) }),
    relations: { extract: async () => assert.fail("the code graph is unavailable here") } as never,
    engines: {},
  });
  return { withWorkspace: async (use) => { const answered = await sources.withWorkspace({ repo: { path: "/api", id: "api" } }, use); assert.ok(answered.ok); return answered.value; }, exported, flowReads, callSiteReads: () => callSiteReads };
}

const settled = async (session: Promise<{ ok: boolean; value?: ConsumerSession }>): Promise<ConsumerSession> => {
  const answered = await session;
  assert.ok(answered.ok && answered.value !== undefined);
  return answered.value;
};

const carrierIn = (repo: string): Carrier => ({ site: { kind: "return", repo, file: "src/client.ts", symbol: "load", line: 1 }, path: [] as never });

const SERVED = { api: [route("GET /orders", "/orders"), route("GET /items", "/items")] };

test("hypotheses asked at once on a prepared workspace read each repository once", async () => {
  const bench = workbench({ routes: SERVED, calls: { web: [call("web", "/orders", 3), call("web", "/items", 5)] } });
  await bench.withWorkspace((workspace) => Promise.all([workspace.session(hypothesis("/orders")), workspace.session(hypothesis("/items"))]));
  assert.deepEqual(bench.exported, ["/web"]);
  assert.deepEqual(bench.flowReads, ["web"]);
});

test("a later hypothesis reads only the repositories no earlier one reached", async () => {
  const bench = workbench({ routes: SERVED, calls: { web: [call("web", "/orders", 3), call("web", "/items", 5)], mobile: [call("mobile", "/items", 7)] } });
  await bench.withWorkspace(async (workspace) => {
    await settled(workspace.session(hypothesis("/orders")));
    assert.deepEqual(bench.flowReads, ["web"]);
    await settled(workspace.session(hypothesis("/items")));
  });
  assert.deepEqual(bench.flowReads, ["web", "mobile"]);
});

test("a session follows values only through the repositories its own hypothesis reaches", async () => {
  const bench = workbench({ routes: SERVED, calls: { web: [call("web", "/orders", 3), call("web", "/items", 5)], mobile: [call("mobile", "/items", 7)] } });
  const followed = await bench.withWorkspace(async (workspace) => {
    await settled(workspace.session(hypothesis("/items")));
    const orders = await settled(workspace.session(hypothesis("/orders")));
    return { web: orders.flow.follow(carrierIn("web")).frontiers.length, mobile: orders.flow.follow(carrierIn("mobile")).frontiers.length };
  });
  assert.deepEqual(followed, { web: 0, mobile: 1 });
});

test("the call sites of a workspace are joined once however many hypotheses it answers", async () => {
  const bench = workbench({ routes: SERVED, calls: { web: [call("web", "/orders", 3), call("web", "/items", 5)] } });
  await bench.withWorkspace(async (workspace) => {
    await settled(workspace.session(hypothesis("/orders")));
    await settled(workspace.session(hypothesis("/items")));
  });
  assert.equal(bench.callSiteReads(), 1);
});

test("a call site two repositories serve equally is ambiguous only for the operation they serve", async () => {
  const bench = workbench({
    routes: { api: [route("GET /orders", "/orders"), route("GET /items", "/items")], legacy: [route("GET /orders", "/orders")] },
    calls: { web: [call("web", "/orders", 3), call("web", "/items", 5)] },
  });
  const answers = await bench.withWorkspace(async (workspace) => {
    const orders = await settled(workspace.session(hypothesis("/orders")));
    const items = await settled(workspace.session(hypothesis("/items")));
    return { orders: orders.ambiguousCalls.map(({ from }) => from.line), items: items.ambiguousCalls.map(({ from }) => from.line), itemLinks: items.links.filter((link) => isCallOf(link, "GET /items")).length };
  });
  assert.deepEqual(answers, { orders: [3], items: [], itemLinks: 1 });
});

test("a call site its own repository serves consumes the operation", async () => {
  const bench = workbench({ routes: { web: [route("GET /orders", "/orders")] }, calls: { web: [call("web", "/orders", 3)] } });
  const links = await bench.withWorkspace(async (workspace) => (await settled(workspace.session(hypothesis("/orders")))).links.filter((link) => isCallOf(link, "GET /orders")).length);
  assert.equal(links, 1);
});

test("a call site two routes of one repository take equally is ambiguous for the operation either serves, and links to neither", async () => {
  const bench = workbench({ routes: { api: [route("GET /orders/{id}", "/orders/{id}"), route("GET /orders/{key}", "/orders/{key}")] }, calls: { web: [call("web", "/orders/{}", 3)] } });
  const answer = await bench.withWorkspace(async (workspace) => {
    const session = await settled(workspace.session(hypothesis("/orders/{id}")));
    return { ambiguous: session.ambiguousCalls.map(({ from, repos }) => `${from.line} ${repos.join(",")}`), links: session.links.length };
  });
  assert.deepEqual(answer, { ambiguous: ["3 api"], links: 0 });
});

test("an operation a contract declares is served by the route the join links calls to: by path or by the context path, and no route or two repositories are answers of their own", async () => {
  const configured = (path: string): HttpRoute => ({ ...(route(`GET ${path}`, path) as HttpRoute), basePath: { status: "complete", value: { default: { contextPath: "/api" }, profiles: {} }, evidence: [] } });
  const bench = workbench({ routes: { api: [configured("/orders/{id}")], legacy: [configured("/legacy")], mirror: [configured("/legacy")] }, calls: {} });
  const served = await bench.withWorkspace(async (workspace) => ["/api/orders/{orderId}", "/orders/{id}", "/missing", "/api/legacy"].map((path) => workspace.serving({ method: "GET", path })));
  assert.deepEqual(served, [
    { kind: "served", method: "GET", path: "/orders/{id}" },
    { kind: "served", method: "GET", path: "/orders/{id}" },
    { kind: "unserved" },
    { kind: "ambiguous", repos: ["legacy", "mirror"] },
  ]);
});

const API_FILE = "src/api.ts";
const STORE_FILE = "src/store.ts";
const API_SOURCE = `import { HttpClient } from "@angular/common/http";
export class Api {
  constructor(private http: HttpClient) {}
  getArticle(): string { return this.http.get("/orders"); }
}
`;
const STORE_SOURCE = `export const Store = signalStore(
  withMethods((s, api = inject(Api)) => ({
    load: () => api.getArticle(),
  })),
);
`;
const STORE_OWNER = { name: "Store", start: 1, nameLine: 1, nameColumn: 0, startColumn: 0, endLine: 5, endColumn: 1 };
const WRITTEN_CALL = { kind: "calls" as const, line: 3, column: 16, name: "api.getArticle", callee: "getArticle", owners: [STORE_OWNER] };
const MEMBER_USE: MemberUseOrigin = {
  owner: { path: STORE_FILE, symbol: "Store", line: 1 },
  receiver: { path: API_FILE, symbol: "Api", line: 2 },
  member: { path: API_FILE, symbol: "getArticle", line: 4 },
  reference: { file: STORE_FILE, line: 3, column: 16, name: "api.getArticle", kind: "calls" },
};

interface ReadingLayout {
  nodes: readonly FakeNode[];
  edges?: readonly FakeEdge[];
  syntax: Readonly<Record<string, DeclaredMemberNames>>;
  calls: Record<string, CallSite[]>;
}

/** A workspace read that reaches a real line over a fake index: the sources, their syntax and the graph it holds. */
function readingWorkbench(layout: ReadingLayout): { withWorkspace: Workbench["withWorkspace"] } {
  const routes: Record<string, Entrypoint[]> = { web: [route("GET /orders", "/orders")] };
  const repos = [...new Set([...Object.keys(routes), ...Object.keys(layout.calls)])].sort();
  const repositories = repos.map((repo) => ({
    repo,
    entrypoints: (routes[repo] ?? []).map((value) => ({ status: "complete", value, evidence: [] })),
    callSites: layout.calls[repo] ?? [],
  })) as unknown as WorkspaceRepository[];
  const fact = {
    status: "complete",
    schema: "0",
    snapshot: { repo: "api", kind: "sha", sha },
    producer: { name: "test", version: "0" },
    inputs: { engines: {}, declaredConfig: {} },
    evidence: [],
    value: { repositories, workspace: { repos, gateways: [], source: "request" }, sections: {} },
  };
  const context = {
    plans: repos.map((repo) => ({ kind: "read", at: { source: `/${repo}`, declared: `/${repo}`, repoId: repo, revision: "HEAD" } })),
    scope: { include: [], exclude: [] },
    selection: () => true,
    preparation: { obtain: (_key: string, _deps: unknown, build: (root: string, keep: ReadScope["keep"]) => Promise<unknown>) => build("/root", (sources) => [...sources]) },
    signal: undefined,
  };
  const sources = [{ path: API_FILE, content: API_SOURCE }, { path: STORE_FILE, content: STORE_SOURCE }];
  const store = fakeCodeGraph(layout.nodes, layout.edges ?? []);
  const unknown = async (sites: readonly unknown[]) => sites.map(() => ({ status: "unknown", reason: "unresolved", evidence: [] }));
  const importOrigins = { origins: unknown, rootOrigins: unknown, rootBindings: async (sites: readonly unknown[]) => sites.map(() => ({ kind: "unknown" })), receiverMethods: async (sites: readonly unknown[]) => sites.map(() => ({ kind: "unknown" })) } as unknown as ImportOrigins;
  const relations = {
    language: { reads: () => true },
    extract: async () => ({ relations: [], fields: [], locals: [], memberUses: [MEMBER_USE] }),
  } as unknown as RelationExtractor;
  const consumer = createConsumerSources({
    operation: {
      withRead: async (_request: unknown, use: (read: unknown, context: unknown) => Promise<{ ok: boolean; value?: unknown }>) => {
        const result = await use({ fact }, context);
        return result.ok ? { ok: true, value: { value: result.value } } : result;
      },
    } as never,
    heads: {
      vcs: { exportCommit: async () => ({ ok: true, value: { files: sources.map(({ path }) => ({ path, written: true })), skipped: [] } }) },
      reader: { read: async () => sources },
      scratch: { create: async () => "/scratch", remove: async () => undefined },
      graph: { index: async () => ({ ok: true, value: { filesNotIndexed: [] } }), open: () => ({ ok: true, value: store }) },
      digest: { of: () => "d" },
      matcher: { matches: () => true },
      producer: { name: "test", version: "0" },
    } as never,
    digest: { of: () => "d" },
    flow: async () => ({ follow: () => ({ uses: [], next: [], frontiers: [] }) }),
    metadata: { read: async () => ({ classes: [] }) } as never,
    templateFlow: { follow: () => ({ uses: [], next: [], frontiers: [] }) },
    origins: () => ({ ofBody: async () => [], ofArgument: async () => ({ kind: "omitted" }) }),
    relations,
    engines: {},
    importOrigins: () => importOrigins,
    memberNames: { memberNames: async (file) => layout.syntax[file.path] ?? NOTHING_DECLARED },
  });
  return { withWorkspace: async (use) => { const answered = await consumer.withWorkspace({ repo: { path: "/web", id: "web" } }, use); assert.ok(answered.ok); return answered.value; } };
}

const GRAPH: readonly FakeNode[] = [fakeNode("Api", "class", API_FILE, 2, 5), fakeNode("Api.getArticle", "method", API_FILE, 4, 4, "getArticle"), fakeNode("Store", "constant", STORE_FILE, 1, 5)];
const CONTAINS: readonly FakeEdge[] = [{ from: "Api", to: "Api.getArticle", kind: "contains" }];
const CALL_SITE: CallSite = { repo: "web", file: API_FILE, line: 4, symbol: "Api.getArticle", transport: "http", target: { status: "complete", value: { method: "GET", path: "/orders" }, evidence: [] } };

const consumerCallers = (bench: ReturnType<typeof readingWorkbench>) =>
  bench.withWorkspace(async (workspace) => {
    const session = await settled(workspace.session(hypothesis("/orders")));
    return session.callers({ repo: "web", file: API_FILE, symbol: "getArticle", line: 4 });
  });

test("a consumer call the index does not record reaches the contract answer", async () => {
  const bench = readingWorkbench({ nodes: GRAPH, edges: CONTAINS, syntax: { [STORE_FILE]: { ...NOTHING_DECLARED, calls: [WRITTEN_CALL] } }, calls: { web: [CALL_SITE] } });

  assert.deepEqual(await consumerCallers(bench), { kind: "found", callers: [{ file: STORE_FILE, line: 1, at: 3, kind: "call", provenance: "resolved", confidence: 1, proven: true }] });
});

test("a consumer call record the source contradicts is no caller of the contract answer", async () => {
  const bench = readingWorkbench({ nodes: GRAPH, edges: [...CONTAINS, { from: "Store", to: "Api.getArticle", kind: "calls", line: 3, column: 15 }], syntax: { [STORE_FILE]: { ...NOTHING_DECLARED, calls: [] } }, calls: { web: [CALL_SITE] } });

  assert.deepEqual(await consumerCallers(bench), { kind: "found", callers: [] });
});
