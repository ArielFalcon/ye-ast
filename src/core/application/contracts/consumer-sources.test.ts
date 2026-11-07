import { test } from "node:test";
import assert from "node:assert/strict";
import { type Hypothesis, parseHypothesis } from "../../domain/contracts/hypothesis.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import type { Carrier } from "../../domain/contracts/consumer-flow.ts";
import type { ConsumerSession, PreparedWorkspace } from "../../ports/consumer-sources.port.ts";
import type { WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
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
  withWorkspace<T>(use: (workspace: PreparedWorkspace) => Promise<T>): Promise<T>;
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
    preparation: { obtain: (_key: string, _deps: unknown, build: (root: string) => Promise<unknown>) => build("/root") },
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
