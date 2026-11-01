import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import type { ImpactValue } from "../../domain/impact/impact-fact.ts";
import type { CompleteFact, Cut, Fact, SnapshotRef } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { ImpactCallersRequest, ImpactFault, ImpactQueries } from "../../ports/impact-queries.port.ts";
import type { WorkspaceQueries, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import type { WorkspaceRepository, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceImpactValue, RepoImpact } from "../../ports/workspace-impact-queries.port.ts";
import { createWorkspaceImpactQueries } from "./workspace-impact.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HANDLER = { path: "src/main/java/app/Orders.java", symbol: "Orders.create", line: 10 };

function route(method: HttpRoute["method"], path: string, symbol = "Orders.create", line = 10): HttpRoute {
  return { kind: "http-route", name: `${method} ${path}`, method, path, handler: { ...HANDLER, symbol, line }, basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] } };
}

function callSite(repo: string, path: string, method: "GET" | "POST" | "DELETE" = "POST", line = 7): CallSite {
  return { repo, file: `src/app/${repo}.api.ts`, line, symbol: `${repo}.call${line}`, transport: "http", target: { status: "complete", value: { method, path }, evidence: [] } };
}

function undecidedCallSite(repo: string, line: number): CallSite {
  return { repo, file: `src/app/${repo}.api.ts`, line, symbol: `${repo}.call${line}`, transport: "http", target: { status: "unknown", reason: "unresolved", evidence: [{ path: `src/app/${repo}.api.ts`, line }] } };
}

function fact<T>(repo: string, trust: "trusted" | "untrusted", value: T, sha = SHA): Fact<T> {
  const snapshot: SnapshotRef = { repo, kind: "sha", sha };
  return {
    schema: "0.4.0",
    snapshot,
    producer: { name: "ye-ast", version: "0.0.0" },
    inputs: { trust, scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
    evidence: [],
    status: "complete",
    value,
  };
}

function impactOf(entrypoints: ImpactValue["entrypoints"], rest: Partial<ImpactValue> = {}): ImpactValue {
  return { cost: { expansionsUsed: 0 }, seeds: [], symbols: [], entrypoints, ...rest };
}

const REACHED: ImpactValue["entrypoints"] = [{ kind: "http-route", name: "POST /orders", handler: HANDLER, depth: 0, confidence: 1, seeds: [] }];

interface Setup {
  /** Per repository: its own routes and call sites. */
  repositories: Record<string, { entrypoints?: readonly Entrypoint[]; callSites?: readonly CallSite[]; cuts?: readonly Cut[]; trust?: "trusted" | "untrusted"; sha?: string }>;
  trigger?: ImpactValue;
  /** The outward names the workspace read found no local repository for. */
  unserved?: readonly string[];
}

function setup({ repositories, trigger = impactOf(REACHED), unserved = [] }: Setup) {
  const names = Object.keys(repositories).sort();
  const read: WorkspaceRepository[] = names.map((repo) => ({
    repo,
    path: `/work/${repo}`,
    snapshot: { repo, kind: "sha", sha: repositories[repo]?.sha ?? SHA },
    entrypoints: (repositories[repo]?.entrypoints ?? []).map((value) => ({ status: "complete" as const, value, evidence: [] })),
    callSites: repositories[repo]?.callSites ?? [],
  }));
  const section = (repo: string): Fact<WorkspaceSection> => {
    const held = repositories[repo];
    const complete = fact(repo, held?.trust ?? "untrusted", { names: [], unresolved: [] }, held?.sha ?? SHA) as CompleteFact<WorkspaceSection>;
    const [first, ...rest] = held?.cuts ?? [];
    return first === undefined ? complete : { ...complete, status: "partial", cuts: [first, ...rest] };
  };
  const read_: WorkspaceQueries = {
    outwardNames: async (request) => {
      const value: WorkspaceValue = {
        workspace: { repos: names, gateways: [] },
        repositorySnapshots: read.map(({ repo, snapshot }) => ({ repo, snapshot })),
        sections: Object.fromEntries(names.map((repo) => [repo, section(repo)])),
        candidates: [],
        unserved: unserved.map((name) => ({ name, kind: "path-prefix" as const, evidence: [] })),
        repositories: read,
      };
      const triggerRepo = request.repo.id ?? request.repo.path.split("/").pop() ?? "";
      return { ok: true, value: { ...fact(triggerRepo, repositories[triggerRepo]?.trust ?? "untrusted", value), snapshot: read.find((entry) => entry.repo === triggerRepo)?.snapshot ?? read[0]!.snapshot } };
    },
  };
  const walks: ImpactCallersRequest[] = [];
  const impact = {
    callers: async (request: ImpactCallersRequest): Promise<Result<Fact<ImpactValue>, ImpactFault>> => {
      walks.push(request);
      return { ok: true, value: fact(request.repoId, "untrusted", request.repoId === "orders" ? trigger : impactOf([])) };
    },
    ofChange: async (): Promise<Result<Fact<ImpactValue>, ImpactFault>> => ({ ok: true, value: fact("orders", "trusted", { ...trigger, mergeBase: OTHER_SHA }) }),
  } as unknown as ImpactQueries;
  return { queries: createWorkspaceImpactQueries({ workspace: read_, impact }), walks };
}

const ASK = { repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-web" }], targets: [{ file: HANDLER.path, symbol: HANDLER.symbol }] };

function valueOf(result: Result<Fact<WorkspaceImpactValue>, unknown>): WorkspaceImpactValue {
  assert.ok(result.ok);
  assert.notEqual(result.value.status, "unknown");
  return (result.value as { value: WorkspaceImpactValue }).value;
}

function repoImpact(value: WorkspaceImpactValue, repo: string): RepoImpact & { status: string } {
  const section = value.sections[repo];
  assert.ok(section !== undefined && section.status !== "unknown");
  return { ...section.value, status: section.status };
}

const pathOf = (site: CallSite): string => (site.target.status === "complete" && "path" in site.target.value ? site.target.value.path : "?");
const ORDERS = { entrypoints: [route("POST", "/orders"), route("GET", "/refunds", "Orders.refunds", 30)] };

test("a call site of another repository that lands in a reached route is an upstream link, inferred by route overlap when no gateway is declared", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders")] } } });

  const value = valueOf(await queries.callers(ASK));

  assert.deepEqual(
    value.links.map(({ link, direction, reach }) => `${direction} ${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name} (${link.basis}) reach ${reach.join()}`),
    [`upstream shop-web:7 -> orders POST /orders (route-overlap) reach ${value.links[0]?.link.id}`],
  );
  assert.deepEqual(value.workspace.gateways, [{ prefix: "orders-api", repo: "orders", basis: "route-overlap" }]);
});

test("a gateway the caller declares links with basis gateway-prefix, whatever the overlap says", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "edge/orders")] } } });

  const value = valueOf(await queries.callers({ ...ASK, gateways: [{ prefix: "edge", repo: "orders" }] }));

  assert.deepEqual(value.links.map(({ link }) => link.basis), ["gateway-prefix"]);
});

test("a call a repository makes to its own route is not a link across repositories", async () => {
  const { queries } = setup({ repositories: { orders: { ...ORDERS, callSites: [callSite("orders", "orders")] }, "shop-web": {} } });

  assert.deepEqual(valueOf(await queries.callers(ASK)).links, []);
});

test("a call to a route the walk did not reach is not impacted, and not drift either", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders"), callSite("shop-web", "orders-api/refunds", "GET", 9)] } } });

  const value = valueOf(await queries.callers(ASK));

  const section = repoImpact(value, "shop-web");
  assert.deepEqual(section.callSites.map((site) => site.line), [7]);
  assert.deepEqual(section.unmatched, []);
});

test("a call that reaches a declared service and matches none of its routes is unmatched; one that names no declared service is external", async () => {
  const { queries } = setup({
    repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders"), callSite("shop-web", "orders-api/missing", "POST", 8), callSite("shop-web", "geo-api/provinces", "GET", 9)] } },
  });

  const section = repoImpact(valueOf(await queries.callers(ASK)), "shop-web");

  assert.deepEqual(section.unmatched.map(pathOf), ["orders-api/missing"]);
  assert.deepEqual(section.external.map(pathOf), ["geo-api/provinces"]);
});

test("a call site whose target is undecided joins nothing and stays a cut naming its place", async () => {
  const place = "src/app/shop-web.api.ts";
  const { queries } = setup({
    repositories: { orders: ORDERS, "shop-web": { callSites: [undecidedCallSite("shop-web", 21)], cuts: [{ kind: "unresolved-link", at: [place, `${place}:21`] }] } },
  });

  const result = await queries.callers(ASK);

  const value = valueOf(result);
  const section = value.sections["shop-web"];
  assert.deepEqual(value.links, []);
  assert.deepEqual(repoImpact(value, "shop-web").external, []);
  assert.ok(section?.status === "partial");
  assert.deepEqual(section.cuts, [{ kind: "unresolved-link", at: [place, `${place}:21`] }]);
  assert.ok(result.ok && result.value.status === "partial");
  assert.deepEqual(result.value.cuts, [{ kind: "section", at: ["shop-web"] }]);
});

test("a call two repositories serve equally is no link: it is a cut naming its place", async () => {
  const { queries } = setup({
    repositories: { orders: ORDERS, billing: { entrypoints: [route("POST", "/orders", "Billing.create", 5)] }, "shop-web": { callSites: [callSite("shop-web", "orders", "POST", 12)] } },
  });

  const value = valueOf(await queries.callers({ ...ASK, repos: [{ path: "/work/shop-web" }, { path: "/work/billing" }] }));

  const section = value.sections["shop-web"];
  assert.deepEqual(value.links, []);
  assert.ok(section?.status === "partial");
  assert.deepEqual(section.cuts, [{ kind: "unresolved-link", at: ["src/app/shop-web.api.ts", "src/app/shop-web.api.ts:12"] }]);
});

test("the repository holding an impacted call site is walked from that call site's line at its own snapshot", async () => {
  const { queries, walks } = setup({ repositories: { orders: ORDERS, "shop-web": { sha: OTHER_SHA, callSites: [callSite("shop-web", "orders-api/orders", "POST", 7)] } } });

  const value = valueOf(await queries.callers(ASK));

  const consumer = walks.find((walk) => walk.repoId === "shop-web");
  assert.deepEqual(consumer, { repo: "/work/shop-web", repoId: "shop-web", revision: OTHER_SHA, targets: [{ file: "src/app/shop-web.api.ts", start: 7, end: 7 }] });
  assert.ok(repoImpact(value, "shop-web").impact !== undefined);
  assert.deepEqual(value.repositorySnapshots.map(({ repo, snapshot }) => `${repo} ${snapshot.kind === "sha" ? snapshot.sha.slice(0, 1) : "live"}`), ["orders a", "shop-web b"]);
});

test("a repository none of whose call sites landed in the change is not walked", async () => {
  const { queries, walks } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "geo-api/provinces", "GET")] } } });

  await queries.callers(ASK);

  assert.deepEqual(walks.map((walk) => walk.repoId), ["orders"]);
});

test("each section keeps the trust of its own repository and the answer keeps the trigger's", async () => {
  const { queries } = setup({ repositories: { orders: { ...ORDERS, trust: "trusted" }, "shop-web": { trust: "untrusted" } } });

  const result = await queries.callers(ASK);

  assert.deepEqual(Object.entries(valueOf(result).sections).map(([repo, section]) => `${repo} ${section.inputs.trust}`), ["orders trusted", "shop-web untrusted"]);
  assert.ok(result.ok);
  assert.equal(result.value.inputs.trust, "trusted");
});

test("a change answer carries the merge base, and a removed route still links the callers that name it", async () => {
  const removed = impactOf([], { changedEntrypoints: [{ change: "removed", kind: "http-route", name: "DELETE /orders/{id}", handler: { ...HANDLER, symbol: "Orders.remove", line: 40 } }] });
  const { queries } = setup({ repositories: { orders: { entrypoints: [route("POST", "/orders")] }, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders", "POST", 7), callSite("shop-web", "orders-api/orders/:id", "DELETE", 9)] } }, trigger: removed });

  const answered = await queries.ofChange({ repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-web" }], base: "main", head: "HEAD" });

  const value = valueOf(answered);
  assert.equal(value.trigger.mergeBase, OTHER_SHA);
  assert.deepEqual(value.links.map(({ link }) => `${link.from.line} -> ${link.to.name} (${link.basis})`), ["9 -> DELETE /orders/{id} (route-overlap)"]);
});

test("links and the call sites of a section are listed by place, whatever order the repositories gave them in", async () => {
  const { queries } = setup({
    repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders", "POST", 30), callSite("shop-web", "orders-api/refunds", "GET", 5), callSite("shop-web", "orders-api/orders", "POST", 12)] } },
  });

  const value = valueOf(await queries.callers(ASK));

  assert.deepEqual(value.links.map(({ link }) => link.from.line), [12, 30]);
  assert.deepEqual(repoImpact(value, "shop-web").callSites.map((site) => site.line), [12, 30]);
});

test("a name a gateway in force routes to a repository is not listed as unserved, and a name is listed once", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders")] } }, unserved: ["geo-api", "orders-api", "geo-api"] });

  assert.deepEqual(valueOf(await queries.callers(ASK)).workspace.unserved, ["geo-api"]);
});

test("a declared gateway that no call site names, or that routes to a repository not read, is reported as matching nothing", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "edge/orders"), callSite("shop-web", "pay/charges")] } } });

  const value = valueOf(await queries.callers({ ...ASK, gateways: [{ prefix: "edge", repo: "orders" }, { prefix: "legacy", repo: "orders" }, { prefix: "pay", repo: "billing" }] }));

  assert.deepEqual(value.workspace.unmatchedGateways, [{ prefix: "legacy", repo: "orders" }, { prefix: "pay", repo: "billing" }]);
});
