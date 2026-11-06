import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { Entrypoint, Listener } from "../../domain/entrypoints/entrypoint.ts";
import { unresolvedCallSite, type CallSite, type EventTarget } from "../../domain/topology/call-site.ts";
import type { ImpactValue, Seed } from "../../domain/impact/impact-fact.ts";
import { sameIdentity, type CompleteFact, type Cut, type Fact, type SnapshotRef } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CallersTarget, ImpactCallersRequest, ImpactFault, ImpactOfChangeRequest, ImpactQueries } from "../../ports/impact-queries.port.ts";
import type { FactRead, WorkspaceQueries, WorkspaceRefresh, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import type { WorkspaceRepository, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import type { WorkspaceDefaults, WorkspaceManifest } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceRequest } from "../../ports/workspace-queries.port.ts";
import type { WorkspaceImpactValue, RepoImpact } from "../../ports/workspace-impact-queries.port.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { createCapturedWorkspaceImpactQueries, createWorkspaceImpactQueries } from "./workspace-impact.ts";
import { fakeLive } from "../live/fake-live.testing.ts";
import { withWorkspaceSnapshots, type WorkspaceSnapshotContext } from "./workspace-snapshots.ts";
import type { WorkspaceReadOperation } from "./workspace-operation.ts";
import { workspaceInForce } from "./workspace-defaults.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TRUSTED: TrustRecordReader = { read: async () => ({ ok: true, value: "trusted" }) };
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

const CONSUMER = { path: "src/main/java/app/OrdersListener.java", symbol: "OrdersListener.on", line: 8 };

function listener(destination: string, protocol: Listener["protocol"] = "kafka", handler = CONSUMER): Listener {
  return { kind: "listener", name: `${protocol} ${destination}`, protocol, destination, handler };
}

function eventSite(repo: string, destination: string, line = 7, protocol: EventTarget["protocol"] = "kafka"): CallSite {
  const file = `src/main/java/app/${repo}/Orders.java`;
  const value: EventTarget = { protocol, destination, role: "publish" };
  return { repo, file, line, symbol: `${repo}.publish${line}`, transport: "event", target: { status: "complete", value, evidence: [] } };
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
  repositories: Record<string, { entrypoints?: readonly Entrypoint[]; callSites?: readonly CallSite[]; cuts?: readonly Cut[]; trust?: "trusted" | "untrusted"; sha?: string; snapshot?: SnapshotRef }>;
  /** Repositories the read named but could not reach: their section is unknown and they are no repository read. */
  unavailable?: readonly string[];
  trigger?: ImpactValue;
  /** The outward names the workspace read found no local repository for. */
  unserved?: readonly string[];
  /** Per repository: what a walk from one of its call sites reaches, by the line the walk is seeded with. */
  reached?: Record<string, readonly WalkModel[]>;
  /** The workspace the bound repository persists, honoured only when the trigger is `trusted`. */
  defaults?: WorkspaceDefaults;
  /** The declared trust of the trigger; absent reads it `untrusted`, which never honours the persisted workspace. */
  trust?: TrustRecordReader;
  /** What the workspace read refreshed, carried beside the fact. */
  refresh?: WorkspaceRefresh;
  walkFact?: (repo: string, answer: Fact<ImpactValue>) => Fact<ImpactValue>;
}

/** One call site of a repository as its walk sees it: the line a range is seeded by, the declaration it sits in, and what the walk reaches. */
interface WalkModel {
  line: number;
  declaration: number;
  symbol: string;
  entrypoints: ImpactValue["entrypoints"];
}

/** A walk seeded by line ranges: the declaration each range holds, and the entrypoints each declaration reaches. */
function walkAnswer(model: readonly WalkModel[], targets: readonly CallersTarget[]): ImpactValue {
  const found = targets.flatMap((target): { target: { file: string; start: number; end: number }; at: WalkModel }[] => {
    if ("symbol" in target) return [];
    const at = model.find((entry) => entry.line >= target.start && entry.line <= target.end);
    return at === undefined ? [] : [{ target, at }];
  });
  const seeds: Seed[] = [
    ...new Map(found.map(({ target, at }) => [`${target.file}\0${at.symbol}`, { file: target.file, symbol: at.symbol.split(".").at(-1)!, line: at.declaration, endLine: target.end, basis: "requested" as const }])).values(),
  ].sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol));
  const seedOf = (target: { file: string }, at: WalkModel): number => seeds.findIndex((seed) => seed.file === target.file && seed.symbol === at.symbol.split(".").at(-1));
  const entrypoints = found.flatMap(({ target, at }) => at.entrypoints.map((entrypoint) => ({ ...entrypoint, seeds: [seedOf(target, at)] })));
  return { cost: { expansionsUsed: 0 }, seeds, symbols: [], entrypoints };
}

function setup({ repositories, unavailable = [], trigger = impactOf(REACHED), unserved = [], reached = {}, defaults, trust, refresh, walkFact = (_repo, answer) => answer }: Setup) {
  const missing = new Set(unavailable);
  const names = Object.keys(repositories).filter((repo) => !missing.has(repo)).sort();
  const all = [...new Set([...names, ...unavailable])].sort();
  const read: WorkspaceRepository[] = names.map((repo) => ({
    repo,
    snapshot: repositories[repo]?.snapshot ?? { repo, kind: "sha", sha: repositories[repo]?.sha ?? SHA },
    entrypoints: (repositories[repo]?.entrypoints ?? []).map((value) => ({ status: "complete" as const, value, evidence: [] })),
    callSites: repositories[repo]?.callSites ?? [],
  }));
  const section = (repo: string): Fact<WorkspaceSection> => {
    const held = repositories[repo];
    const unresolved = (held?.callSites ?? []).flatMap((site) => (site.target.status === "unknown" ? [unresolvedCallSite(site)] : []));
    const complete = fact(repo, held?.trust ?? "untrusted", { names: [], unresolved }, held?.sha ?? SHA) as CompleteFact<WorkspaceSection>;
    const [first, ...rest] = held?.cuts ?? [];
    return first === undefined ? complete : { ...complete, status: "partial", cuts: [first, ...rest] };
  };
  /** The section of a repository the read pinned but could not reach: no content, and the reason it has none. */
  const unreachable = (repo: string): Fact<WorkspaceSection> => {
    const { value: _value, ...base } = fact(repo, "trusted", { names: [], unresolved: [] }) as CompleteFact<WorkspaceSection>;
    return { ...base, status: "unknown", reason: "revision-unavailable" };
  };
  const asks: WorkspaceRequest[] = [];
  const read_: WorkspaceQueries = {
    outwardNames: async (request) => {
      asks.push(request);
      const declaration = trust === undefined ? undefined : await trust.read(request.repo.path);
      const mode = declaration?.ok ? declaration.value ?? "untrusted" : "untrusted";
      const effective = await workspaceInForce(request, defaults, mode);
      if (!effective.ok) return effective;
      const value: WorkspaceValue = {
        workspace: { repos: all, gateways: effective.value.gateways.map((gateway) => ({ ...gateway, basis: "gateway-prefix" as const })), source: effective.value.source },
        links: [],
        unlinked: [],
        repositorySnapshots: read.map(({ repo, snapshot }) => ({ repo, snapshot })),
        sections: Object.fromEntries(all.map((repo) => [repo, missing.has(repo) ? unreachable(repo) : section(repo)])),
        candidates: [],
        unserved: unserved.map((name) => ({ name, kind: "path-prefix" as const, evidence: [] })),
        repositories: read,
      };
      const triggerRepo = request.repo.id ?? request.repo.path.split("/").pop() ?? "";
      return {
        ok: true,
        value: {
          fact: { ...fact(triggerRepo, repositories[triggerRepo]?.trust ?? "untrusted", value), snapshot: read.find((entry) => entry.repo === triggerRepo)?.snapshot ?? read[0]!.snapshot },
          repositorySources: read.map(({ repo }) => ({ repo, path: `/work/${repo}` })),
          repositoryRoots: all.map((repo) => ({ repo, path: `/work/${repo}` })),
          ...(refresh === undefined ? {} : { refresh }),
        },
      };
    },
  };
  const walks: ImpactCallersRequest[] = [];
  const impact = {
    callers: async (request: ImpactCallersRequest): Promise<Result<Fact<ImpactValue>, ImpactFault>> => {
      walks.push(request);
      const model = reached[request.repoId];
      const value = request.targets.some((target) => "symbol" in target) ? trigger : model === undefined ? impactOf([]) : walkAnswer(model, request.targets);
      return { ok: true, value: walkFact(request.repoId, fact(request.repoId, "untrusted", value)) };
    },
    ofChange: async (request: ImpactOfChangeRequest): Promise<Result<Fact<ImpactValue>, ImpactFault>> => ({ ok: true, value: fact(request.repoId, "trusted", { ...trigger, mergeBase: OTHER_SHA }) }),
  } as unknown as ImpactQueries;
  return { queries: createWorkspaceImpactQueries({ workspace: read_, impact, digest: { of: (text) => `digest(${text})` } }), walks, asks, read_ };
}

const ASK = { repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-web" }], targets: [{ file: HANDLER.path, symbol: HANDLER.symbol }] };

function valueOf(result: Result<FactRead<WorkspaceImpactValue>, unknown>): WorkspaceImpactValue {
  assert.ok(result.ok);
  assert.notEqual(result.value.fact.status, "unknown");
  return (result.value.fact as { value: WorkspaceImpactValue }).value;
}

function repoImpact(value: WorkspaceImpactValue, repo: string): RepoImpact & { status: string } {
  const section = value.sections[repo];
  assert.ok(section !== undefined && section.status !== "unknown");
  return { ...section.value, status: section.status };
}

const pathOf = (site: CallSite): string => (site.target.status === "complete" && "path" in site.target.value ? site.target.value.path : "?");
const ORDERS = { entrypoints: [route("POST", "/orders"), route("GET", "/refunds", "Orders.refunds", 30)] };

test("committed consumer walks reject live snapshots instead of substituting HEAD", async () => {
  const { queries, walks } = setup({ repositories: {
    orders: ORDERS,
    "shop-web": { callSites: [callSite("shop-web", "/orders")], snapshot: { repo: "shop-web", kind: "live", head: SHA, stateId: "live-state" } },
  } });
  const result = await queries.callers(ASK);
  assert.equal(result.ok, false);
  assert.equal(walks.length, 1);
});

test("captured callers walk selected live and SHA states while every live lease is held", async () => {
  const fake = fakeLive({ "src/a.ts": "v1" });
  const signal = new AbortController().signal;
  const discovery = setup({ repositories: {
    orders: ORDERS,
    "shop-web": { callSites: [callSite("shop-web", "/orders")] },
    batch: { callSites: [callSite("batch", "/orders")] },
  } }).read_;
  const deps: Parameters<typeof withWorkspaceSnapshots>[0] = {
    vcs: {
      canonicalRoot: async (path) => ({ ok: true, value: `/real${path}` }),
      resolveCommit: async () => ({ ok: true, value: SHA }),
      remotes: async () => ({ ok: true, value: [] }),
      headBranch: async () => ({ ok: true, value: "main" }),
      exportCommit: async () => assert.fail("unexpected export"),
      repositoryName: async () => assert.fail("unexpected repository name"),
    },
    trust: { read: async () => ({ ok: true, value: "trusted" }) },
    digest: { of: () => "b".repeat(64) }, matcher: { matches: () => true },
    scratch: { create: async () => "/scratch", remove: async () => undefined },
    reader: { read: async () => assert.fail("unexpected read") },
    extractor: { extract: async () => assert.fail("unexpected extraction") },
    producer: { name: "test", version: "0" }, graph: fake.deps.graph, live: fake.deps,
  };
  let operations = 0;
  let contextSeen: WorkspaceSnapshotContext | undefined;
  const requests: ImpactCallersRequest[] = [];
  const operation: WorkspaceReadOperation = {
    withRead: async (request, use) => {
      operations++;
      return withWorkspaceSnapshots(deps, request, async (context) => {
        contextSeen = context;
        const found = await discovery.outwardNames({ repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-web" }, { path: "/work/batch" }] });
        assert.ok(found.ok && found.value.fact.status !== "unknown");
        const snapshots = new Map(context.selectedSnapshots.map((snapshot) => [snapshot.repo, snapshot]));
        const value = found.value.fact.value;
        const sections = Object.fromEntries(Object.entries(value.sections).map(([repo, part]) => [repo, { ...part, snapshot: snapshots.get(repo)! }]));
        const read = { ...found.value, fact: { ...found.value.fact, snapshot: snapshots.get("orders")!, value: { ...value, sections, repositories: value.repositories.map((repo) => ({ ...repo, snapshot: snapshots.get(repo.repo)! })), repositorySnapshots: context.selectedSnapshots.map((snapshot) => ({ repo: snapshot.repo, snapshot })) } } };
        return use(read, context);
      });
    },
  };
  const impactAt = (context: WorkspaceSnapshotContext): ImpactQueries => {
    assert.strictEqual(context, contextSeen);
    return {
      callers: async (request) => {
        assert.equal(fake.held.locks - fake.held.released, 2);
        assert.strictEqual(request.signal, signal);
        requests.push(request);
        const snapshot = context.selectedSnapshots.find((entry) => entry.repo === request.repoId)!;
        if (request.repoId === "orders") fake.tree.set("src/a.ts", "v2");
        return { ok: true, value: { ...fact(request.repoId, "trusted", request.repoId === "orders" ? impactOf(REACHED) : impactOf([])), snapshot } };
      },
      ofChange: async () => assert.fail("unexpected change walk"),
      importers: async () => assert.fail("unexpected importers walk"),
    };
  };
  const queries = createCapturedWorkspaceImpactQueries({ operation, impactAt, digest: { of: (text) => text } });
  const result = await queries.callers({ repo: { path: "/work/orders", live: true }, repos: [{ path: "/work/shop-web", live: true }, { path: "/work/batch" }], targets: ASK.targets, signal });
  assert.ok(result.ok);
  assert.equal(operations, 1);
  assert.equal(fake.held.released, 2);
  assert.deepEqual(requests.map(({ repoId, repo, revision, live }) => ({ repoId, repo, revision, live })).sort((a, b) => a.repoId.localeCompare(b.repoId)), [
    { repoId: "batch", repo: "/work/batch", revision: SHA, live: undefined },
    { repoId: "orders", repo: "/real/work/orders", revision: undefined, live: true },
    { repoId: "shop-web", repo: "/real/work/shop-web", revision: undefined, live: true },
  ]);
  assert.ok(result.value.workspaceLive?.some(({ repo }) => repo === "orders"));
  assert.deepEqual(result.value.workspaceReplay?.snapshots, contextSeen!.selectedSnapshots);
  const value = valueOf(result);
  assert.deepEqual(repoImpact(value, "shop-web").reads.map(({ fact }) => fact.snapshot), [contextSeen!.selectedSnapshots.find(({ repo }) => repo === "shop-web"), contextSeen!.selectedSnapshots.find(({ repo }) => repo === "shop-web")]);

  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const failing = createCapturedWorkspaceImpactQueries({ operation, digest: { of: (text) => text }, impactAt: (context) => ({
      callers: async (request) => {
        assert.strictEqual(request.signal, context.signal);
        assert.equal(fake.held.locks - fake.held.released, 2);
        if (cancelled) controller.abort();
        return { ok: false, fault: { kind: "unknown-symbol", detail: "missing", entries: [] } };
      },
      ofChange: async () => assert.fail("unexpected change walk"),
      importers: async () => assert.fail("unexpected importers walk"),
    }) });
    const failed = await failing.callers({ repo: { path: "/work/orders", live: true }, repos: [{ path: "/work/shop-web", live: true }, { path: "/work/batch" }], targets: ASK.targets, signal: controller.signal });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.fault.kind, cancelled ? "aborted" : "unknown-symbol");
    assert.equal(fake.held.locks, fake.held.released);
  }
});

test("captured callers reject a missing live handle without walking HEAD", async () => {
  const s = capturedChangeFixture();
  const operation: WorkspaceReadOperation = { withRead: (request, use) => s.operation.withRead(request, (read, context) => use(read, { ...context, liveCaptures: new Map() })) };
  const queries = createCapturedWorkspaceImpactQueries({ operation, digest: { of: (text) => text }, impactAt: () => ({
    callers: async () => assert.fail("must not recapture or walk HEAD"),
    ofChange: async () => assert.fail("unexpected change walk"),
    importers: async () => assert.fail("unexpected importers walk"),
  }) });
  const result = await queries.callers({ repo: { path: "/work/webapp", live: true }, repos: [{ path: "/work/orders", live: true }, { path: "/work/payments" }], targets: ASK.targets });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "git-failed");
  assert.equal(s.fake.held.locks, s.fake.held.released);
});

test("prototype-like repository IDs retain sections, uncertainty and contributing read identity", async () => {
  for (const [available, unavailable] of [["__proto__", "constructor"], ["constructor", "__proto__"]] as const) {
    const read = (sha: string) => setup({
      repositories: { orders: ORDERS, [available]: { sha, cuts: [{ kind: "not-exported", at: ["src/missing.ts"] }] } },
      unavailable: [unavailable],
    }).queries.callers({ ...ASK, repos: [available, unavailable].map((id) => ({ id, path: `/work/${id}` })) });

    const first = await read(SHA);
    assert.ok(first.ok && first.value.fact.status === "partial");
    const sections = first.value.fact.value.sections;
    assert.deepEqual(Object.keys(sections).sort(), ["__proto__", "constructor", "orders"]);
    const known = sections[available];
    assert.ok(known?.status === "partial");
    assert.deepEqual(known.value.reads.map(({ kind, fact }) => [kind, fact.snapshot]), [["discovery", { repo: available, kind: "sha", sha: SHA }]]);
    assert.ok(known.cuts.some(({ kind }) => kind === "not-exported"));
    assert.equal(sections[unavailable]?.status, "unknown");
    assert.ok(first.value.fact.cuts.some(({ kind, at }) => kind === "section" && at[0] === available));
    assert.ok(first.value.fact.cuts.some(({ kind, at }) => kind === "section" && at[0] === unavailable));
    assert.equal(Object.getPrototypeOf(sections), Object.prototype);

    const changed = await read(OTHER_SHA);
    assert.ok(changed.ok);
    assert.notEqual(changed.value.fact.inputs.content, first.value.fact.inputs.content);
  }
});

test("an unavailable trigger walk remains named and makes the workspace partial", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS }, walkFact: (_repo, answer) => ({ ...answer, status: "unknown", reason: "index-unavailable" }) });
  const result = await queries.callers(ASK);
  assert.ok(result.ok);
  assert.equal(result.value.fact.status, "partial");
  const section = valueOf(result).sections.orders;
  assert.equal(section?.status, "partial");
  assert.deepEqual(section?.status === "partial" && section.value.reads.map(({ kind, fact }) => [kind, fact.status, fact.status === "unknown" ? fact.reason : undefined]), [["discovery", "complete", undefined], ["trigger", "unknown", "index-unavailable"]]);
});

test("an unknown consumer preserves both discovery cuts and its named reason", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders")], cuts: [{ kind: "not-exported", at: ["src/missing.ts"] }] } }, walkFact: (repo, answer) => repo === "shop-web" ? { ...answer, status: "unknown", reason: "index-unavailable" } : answer });
  const result = await queries.callers(ASK);
  const section = valueOf(result).sections["shop-web"];
  assert.equal(section?.status, "partial");
  assert.ok(section?.status === "partial");
  assert.ok(section.cuts.some(({ kind }) => kind === "not-exported"));
  assert.ok(section.cuts.some(({ kind, at }) => kind === "section" && at[0] === "upstream"));
  assert.deepEqual(section.value.reads.map(({ kind, fact }) => [kind, fact.status]), [["discovery", "partial"], ["upstream", "unknown"]]);
  assert.equal(section.value.reads[1]?.fact.status === "unknown" && section.value.reads[1].fact.reason, "index-unavailable");
});

test("a consumer walk retains its depth cut", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders")] } }, walkFact: (repo, answer) => repo === "shop-web" && answer.status === "complete" ? { ...answer, status: "partial", cuts: [{ kind: "depth", at: ["src/app/shop-web.api.ts"], limit: 1 }] } : answer });
  const result = await queries.callers(ASK);
  const section = valueOf(result).sections["shop-web"];
  assert.equal(section?.status, "partial");
  assert.deepEqual(section?.status === "partial" && section.cuts, [{ kind: "depth", at: ["src/app/shop-web.api.ts"], limit: 1 }]);
});

test("the trigger walk uses the snapshot resolved by workspace discovery", async () => {
  const { queries, walks } = setup({ repositories: { orders: { ...ORDERS, sha: OTHER_SHA } } });
  await queries.callers(ASK);
  assert.equal(walks[0]?.revision, OTHER_SHA);
});

test("composite identity distinguishes changed selection and walk bounds", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": {} } });
  const ask = { repo: { path: "/work/orders" }, base: "main", changed: ["src/a.ts"], budget: { depth: 1 } };
  const a = await queries.ofChange(ask);
  const b = await queries.ofChange({ ...ask, changed: ["src/b.ts"] });
  const c = await queries.ofChange({ ...ask, budget: { depth: 2 } });
  const again = await queries.ofChange(ask);
  assert.ok(a.ok && b.ok && c.ok && again.ok);
  assert.equal(sameIdentity(a.value.fact, b.value.fact), false);
  assert.equal(sameIdentity(a.value.fact, c.value.fact), false);
  assert.equal(JSON.stringify(a), JSON.stringify(again));
});

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
  assert.ok(result.ok && result.value.fact.status === "partial");
  assert.deepEqual(result.value.fact.cuts, [{ kind: "section", at: ["shop-web"] }]);
});

test("each section carries the unresolved call sites its own repository's discovery read, with the request they state", async () => {
  const stated = { ...undecidedCallSite("shop-web", 21), stated: { method: "GET" as const, path: "/orders" } };
  const { queries } = setup({
    repositories: { orders: ORDERS, "shop-web": { callSites: [stated] }, billing: { callSites: [undecidedCallSite("billing", 9)] } },
  });

  const value = valueOf(await queries.callers({ ...ASK, repos: [{ path: "/work/shop-web" }, { path: "/work/billing" }] }));

  assert.deepEqual(repoImpact(value, "shop-web").unresolved, [{ path: "src/app/shop-web.api.ts", line: 21, symbol: "shop-web.call21", transport: "http", stated: { method: "GET", path: "/orders" } }]);
  assert.deepEqual(repoImpact(value, "billing").unresolved, [{ path: "src/app/billing.api.ts", line: 9, symbol: "billing.call9", transport: "http" }]);
  assert.deepEqual(value.links, []);
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
  assert.equal(result.value.fact.inputs.trust, "trusted");
});

test("a change answer carries the merge base, and a removed route still links the callers that name it", async () => {
  const removed = impactOf([], { changedEntrypoints: [{ change: "removed", kind: "http-route", name: "DELETE /orders/{id}", handler: { ...HANDLER, symbol: "Orders.remove", line: 40 } }] });
  const { queries } = setup({ repositories: { orders: { entrypoints: [route("POST", "/orders")] }, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders", "POST", 7), callSite("shop-web", "orders-api/orders/:id", "DELETE", 9)] } }, trigger: removed });

  const answered = await queries.ofChange({ repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-web" }], base: "main" });

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

const EVENT_REACHED: ImpactValue["entrypoints"] = [{ kind: "listener", name: "kafka orders.created", handler: CONSUMER, depth: 0, confidence: 1, seeds: [] }];

test("a published destination a reached listener consumes is an upstream link, and an event site infers no gateway", async () => {
  const { queries } = setup({ repositories: { orders: { entrypoints: [listener("orders.created")] }, "shop-web": { callSites: [eventSite("shop-web", "orders.created")] } }, trigger: impactOf(EVENT_REACHED) });

  const value = valueOf(await queries.callers(ASK));

  assert.deepEqual(
    value.links.map(({ link, direction }) => `${direction} ${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name} (${link.basis})`),
    ["upstream shop-web:7 -> orders kafka orders.created (event-destination)"],
  );
  assert.deepEqual(value.workspace.gateways, []);
});

test("an event no listener consumes is external, never the drift of a service", async () => {
  const { queries } = setup({ repositories: { orders: { entrypoints: [listener("orders.created")] }, "shop-web": { callSites: [eventSite("shop-web", "orders.missing")] } }, trigger: impactOf(EVENT_REACHED) });

  const section = repoImpact(valueOf(await queries.callers(ASK)), "shop-web");

  assert.deepEqual(section.external.map((site) => site.line), [7]);
  assert.deepEqual(section.unmatched, []);
});

test("an event link that lands in a listener the walk did not reach is neither a link nor drift", async () => {
  const { queries } = setup({
    repositories: {
      orders: { entrypoints: [listener("orders.created"), listener("orders.refunded", "kafka", { ...CONSUMER, symbol: "OrdersListener.refund", line: 20 })] },
      "shop-web": { callSites: [eventSite("shop-web", "orders.refunded")] },
    },
    trigger: impactOf(EVENT_REACHED),
  });

  const section = repoImpact(valueOf(await queries.callers(ASK)), "shop-web");

  assert.deepEqual(section.callSites, []);
  assert.deepEqual(section.external, []);
});

test("an event two repositories consume is not a cut: the repository whose listener the walk reached is linked, the other one is no drift", async () => {
  const { queries } = setup({
    repositories: { orders: { entrypoints: [listener("orders.created")] }, billing: { entrypoints: [listener("orders.created", "kafka", { ...CONSUMER, symbol: "BillingListener.on", line: 3 })] }, "shop-web": { callSites: [eventSite("shop-web", "orders.created")] } },
    trigger: impactOf(EVENT_REACHED),
  });

  const value = valueOf(await queries.callers({ ...ASK, repos: [{ path: "/work/shop-web" }, { path: "/work/billing" }] }));

  assert.deepEqual(value.links.map(({ link }) => `${link.from.repo} -> ${link.to.repo}`), ["shop-web -> orders"]);
  assert.equal(value.sections["shop-web"]?.status, "complete");
});

const CHARGES = { path: "src/main/java/app/payments/PaymentController.java", symbol: "PaymentController.charge", line: 12 };
const REFUNDS = { path: "src/main/java/app/payments/PaymentController.java", symbol: "PaymentController.refund", line: 40 };
const ORDER_CONTROLLER = { path: "src/main/java/app/orders/OrderController.java", symbol: "OrderController.create", line: 20 };
const ORDER_LIST = { path: "src/main/java/app/orders/OrderController.java", symbol: "OrderController.list", line: 30 };
const ORDER_PAGE = { path: "src/app/pages/order.page.ts", symbol: "OrderPage.submit", line: 5 };
const NOTIFY = { path: "src/main/java/app/notifications/OrdersListener.java", symbol: "OrdersListener.on", line: 30 };

function routeOf(handler: HttpRoute["handler"], method: HttpRoute["method"], path: string): HttpRoute {
  return { kind: "http-route", name: `${method} ${path}`, method, path, handler, basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] } };
}

function reachedRoute(handler: HttpRoute["handler"], method: HttpRoute["method"], path: string): ImpactValue["entrypoints"][number] {
  return { kind: "http-route", name: `${method} ${path}`, handler, depth: 0, confidence: 1, seeds: [] };
}

function capturedChangeFixture() {
  const fake = fakeLive({ "src/a.ts": "v1" });
  const discovery = setup({ repositories: {
    webapp: { entrypoints: [route("POST", "/web")], callSites: [callSite("webapp", "orders-api/orders", "POST", 9)] },
    orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders")], callSites: [callSite("orders", "payments/charges", "POST", 7), callSite("orders", "webapp/web", "POST", 11)] },
    payments: { entrypoints: [routeOf(CHARGES, "POST", "/charges")], callSites: [callSite("payments", "external/log", "POST", 8)] },
  } }).read_;
  const deps: Parameters<typeof withWorkspaceSnapshots>[0] = {
    vcs: {
      canonicalRoot: async (path) => ({ ok: true, value: `/real${path}` }),
      resolveCommit: async () => ({ ok: true, value: SHA }),
      remotes: async () => ({ ok: true, value: [] }),
      headBranch: async () => ({ ok: true, value: "main" }),
      exportCommit: async () => assert.fail("unexpected export"),
      repositoryName: async () => assert.fail("unexpected repository name"),
    },
    trust: { read: async () => ({ ok: true, value: "trusted" }) },
    digest: { of: () => "b".repeat(64) }, matcher: { matches: () => true },
    scratch: { create: async () => "/scratch", remove: async () => undefined },
    reader: { read: async () => assert.fail("unexpected read") },
    extractor: { extract: async () => assert.fail("unexpected extraction") },
    producer: { name: "test", version: "0" }, graph: fake.deps.graph, live: fake.deps,
  };
  let operations = 0;
  let contextSeen: WorkspaceSnapshotContext | undefined;
  const operation: WorkspaceReadOperation = {
    withRead: async (request, use) => {
      operations++;
      return withWorkspaceSnapshots(deps, request, async (context) => {
        contextSeen = context;
        const found = await discovery.outwardNames({ repo: { path: "/work/webapp" }, repos: [{ path: "/work/orders" }, { path: "/work/payments" }] });
        assert.ok(found.ok && found.value.fact.status !== "unknown");
        const snapshots = new Map(context.selectedSnapshots.map((snapshot) => [snapshot.repo, snapshot]));
        const value = found.value.fact.value;
        const sections = Object.fromEntries(Object.entries(value.sections).map(([repo, part]) => [repo, { ...part, snapshot: snapshots.get(repo)! }]));
        return use({ ...found.value, fact: { ...found.value.fact, snapshot: snapshots.get("webapp")!, value: { ...value, sections, repositories: value.repositories.map((repo) => ({ ...repo, snapshot: snapshots.get(repo.repo)! })), repositorySnapshots: context.selectedSnapshots.map((snapshot) => ({ repo: snapshot.repo, snapshot })) } } }, context);
      });
    },
  };
  return { fake, operation, operations: () => operations, context: () => contextSeen };
}

test("captured change walks its selected live trigger and downstream live and SHA members under both leases", async () => {
  const s = capturedChangeFixture();
  const signal = new AbortController().signal;
  const changes: ImpactOfChangeRequest[] = [];
  const callers: ImpactCallersRequest[] = [];
  const impactAt = (context: WorkspaceSnapshotContext): ImpactQueries => {
    assert.strictEqual(context, s.context());
    return {
      ofChange: async (request) => {
        assert.equal(s.fake.held.locks - s.fake.held.released, 2);
        assert.strictEqual(request.signal, signal);
        changes.push(request);
        const snapshot = context.selectedSnapshots.find(({ repo }) => repo === "webapp")!;
        return { ok: true, value: { ...fact("webapp", "trusted", impactOf([{ ...REACHED[0]!, name: "POST /web" }], { mergeBase: OTHER_SHA, seeds: [{ file: "src/app/webapp.api.ts", symbol: "call9", line: 9, basis: "lines" }] })), snapshot } };
      },
      callers: async (request) => {
        assert.equal(s.fake.held.locks - s.fake.held.released, 2);
        assert.strictEqual(request.signal, signal);
        callers.push(request);
        const snapshot = context.selectedSnapshots.find(({ repo }) => repo === request.repoId)!;
        const model = request.repoId === "orders" ? [{ line: 7, declaration: 3, symbol: "orders.call7", entrypoints: [reachedRoute(ORDER_CONTROLLER, "POST", "/orders")] }] : [];
        if (request.repoId === "payments") s.fake.tree.set("src/a.ts", "v2");
        const answer = fact(request.repoId, "trusted", walkAnswer(model, request.targets));
        return { ok: true, value: request.repoId === "payments" && answer.status === "complete"
          ? { ...answer, snapshot, status: "partial", cuts: [{ kind: "caller-budget", at: ["payments.call8"], limit: 1 }] }
          : { ...answer, snapshot } };
      },
      importers: async () => assert.fail("unexpected importers walk"),
    };
  };
  const queries = createCapturedWorkspaceImpactQueries({ operation: s.operation, impactAt, digest: { of: (text) => text } });
  const result = await queries.ofChange({ repo: { path: "/work/webapp", live: true }, repos: [{ path: "/work/orders", live: true }, { path: "/work/payments" }], base: "base", changed: ["src/**"], signal });
  assert.ok(result.ok);
  assert.equal(s.operations(), 1);
  assert.deepEqual(changes.map(({ repo, head, live, base, changed }) => ({ repo, head, live, base, changed })), [{ repo: "/real/work/webapp", head: undefined, live: true, base: "base", changed: ["src/**"] }]);
  assert.deepEqual(callers.map(({ repoId, repo, revision, live }) => ({ repoId, repo, revision, live })), [
    { repoId: "orders", repo: "/real/work/orders", revision: undefined, live: true },
    { repoId: "orders", repo: "/real/work/orders", revision: undefined, live: true },
    { repoId: "payments", repo: "/work/payments", revision: SHA, live: undefined },
  ]);
  assert.equal(s.fake.held.locks, s.fake.held.released);
  assert.ok(result.value.workspaceLive?.length);
  assert.deepEqual(result.value.workspaceReplay?.snapshots, s.context()!.selectedSnapshots);
  const value = valueOf(result);
  assert.equal(value.trigger.mergeBase, OTHER_SHA);
  assert.deepEqual(value.links.map(({ direction, link }) => `${direction}:${link.from.repo}`), ["downstream:orders", "upstream:orders", "downstream:webapp"]);
  for (const repo of ["webapp", "orders", "payments"]) {
    const snapshot = s.context()!.selectedSnapshots.find((item) => item.repo === repo);
    const kinds = repo === "webapp" ? ["discovery", "trigger"] : repo === "orders" ? ["discovery", "upstream", "downstream"] : ["discovery", "downstream"];
    assert.deepEqual(repoImpact(value, repo).reads.map(({ kind, fact }) => [kind, fact.snapshot]), kinds.map((kind) => [kind, snapshot]));
  }
  const payments = value.sections.payments;
  assert.ok(payments?.status === "partial" && payments.cuts.some(({ kind }) => kind === "caller-budget"));
});

test("captured change pins a moving committed trigger and preserves its request", async () => {
  const s = capturedChangeFixture();
  const signal = new AbortController().signal;
  const scope = { include: ["src/**"] };
  const budget = { expansions: 7 };
  let received: ImpactOfChangeRequest | undefined;
  const queries = createCapturedWorkspaceImpactQueries({ operation: s.operation, digest: { of: (text) => text }, impactAt: (context) => ({
    ofChange: async (request) => {
      assert.equal(s.fake.held.locks - s.fake.held.released, 2);
      received = request;
      return { ok: true, value: { ...fact("webapp", "trusted", impactOf([], { mergeBase: OTHER_SHA })), snapshot: context.selectedSnapshots.find(({ repo }) => repo === "webapp")! } };
    },
    callers: async () => assert.fail("unexpected consumer walk"),
    importers: async () => assert.fail("unexpected importers walk"),
  }) });
  const result = await queries.ofChange({ repo: { path: "/work/webapp", revision: "moving-branch" }, repos: [{ path: "/work/orders", live: true }, { path: "/work/payments", live: true }], base: "base-revision", changed: ["src/**"], scope, budget, signal });
  assert.ok(result.ok);
  assert.deepEqual(received, { repo: "/work/webapp", repoId: "webapp", head: SHA, base: "base-revision", changed: ["src/**"], scope, budget, signal });
  assert.equal(valueOf(result).trigger.mergeBase, OTHER_SHA);
  assert.equal(s.fake.held.locks, s.fake.held.released);
});

test("captured change propagates faults and cancellation after releasing every live lease", async () => {
  for (const cancelled of [false, true]) {
    const s = capturedChangeFixture();
    const controller = new AbortController();
    const fault = { kind: "unknown-change-path" as const, detail: "missing", globs: ["missing/**"] };
    const queries = createCapturedWorkspaceImpactQueries({ operation: s.operation, digest: { of: (text) => text }, impactAt: (context) => ({
      ofChange: async (request) => {
        assert.strictEqual(request.signal, context.signal);
        assert.equal(s.fake.held.locks - s.fake.held.released, 2);
        if (cancelled) controller.abort();
        return { ok: false, fault };
      },
      callers: async () => assert.fail("unexpected consumer walk"),
      importers: async () => assert.fail("unexpected importers walk"),
    }) });
    const result = await queries.ofChange({ repo: { path: "/work/webapp", live: true }, repos: [{ path: "/work/orders", live: true }, { path: "/work/payments" }], base: "base", signal: controller.signal });
    assert.equal(result.ok, false);
    if (!result.ok) {
      if (cancelled) assert.equal(result.fault.kind, "aborted");
      else assert.strictEqual(result.fault, fault);
    }
    assert.equal(s.fake.held.locks, s.fake.held.released);
  }
});

test("captured change rejects a missing live handle before any trigger walk", async () => {
  const s = capturedChangeFixture();
  const operation: WorkspaceReadOperation = { withRead: (request, use) => s.operation.withRead(request, (read, context) => use(read, { ...context, liveCaptures: new Map() })) };
  const queries = createCapturedWorkspaceImpactQueries({ operation, digest: { of: (text) => text }, impactAt: () => ({
    ofChange: async () => assert.fail("must not fall back to HEAD"),
    callers: async () => assert.fail("unexpected consumer walk"),
    importers: async () => assert.fail("unexpected importers walk"),
  }) });
  const result = await queries.ofChange({ repo: { path: "/work/webapp", live: true }, repos: [{ path: "/work/orders", live: true }, { path: "/work/payments" }], base: "base" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "git-failed");
  assert.equal(s.fake.held.locks, s.fake.held.released);
});

const askIn = (trigger: string, others: readonly string[]) => ({ repo: { path: `/work/${trigger}` }, repos: others.map((repo) => ({ path: `/work/${repo}` })), targets: ASK.targets });

test("a chain of three repositories links hop by hop upstream, each link's reach naming the links crossed from the change", async () => {
  const { queries } = setup({
    repositories: {
      payments: { entrypoints: [routeOf(CHARGES, "POST", "/charges")] },
      orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders")], callSites: [callSite("orders", "payments/charges", "POST", 7)] },
      webapp: { callSites: [callSite("webapp", "orders-api/orders", "POST", 9)] },
    },
    trigger: impactOf([reachedRoute(CHARGES, "POST", "/charges")]),
    reached: { orders: [{ line: 7, declaration: 3, symbol: "orders.call7", entrypoints: [reachedRoute(ORDER_CONTROLLER, "POST", "/orders")] }] },
  });

  const value = valueOf(await queries.callers(askIn("payments", ["orders", "webapp"])));

  const [hop, onward] = value.links;
  assert.deepEqual(value.links.map(({ link, direction }) => `${direction} ${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name}`), [
    "upstream orders:7 -> payments POST /charges",
    "upstream webapp:9 -> orders POST /orders",
  ]);
  assert.deepEqual(hop?.reach, [hop?.link.id]);
  assert.deepEqual(onward?.reach, [hop?.link.id, onward?.link.id]);
});

test("a change sends links onward downstream, each link's reach naming the links crossed from it", async () => {
  const { queries } = setup({
    repositories: {
      webapp: { callSites: [callSite("webapp", "orders-api/orders", "POST", 9), callSite("webapp", "payments/charges", "POST", 12)] },
      orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders")], callSites: [callSite("orders", "payments/charges", "POST", 7)] },
      payments: { entrypoints: [routeOf(CHARGES, "POST", "/charges")] },
    },
    trigger: impactOf([], { seeds: [{ file: "src/app/webapp.api.ts", symbol: "call9", line: 9, basis: "lines" }] }),
    reached: { orders: [{ line: 7, declaration: 3, symbol: "orders.call7", entrypoints: [reachedRoute(ORDER_CONTROLLER, "POST", "/orders")] }] },
  });

  const value = valueOf(await queries.ofChange({ repo: { path: "/work/webapp" }, repos: [{ path: "/work/orders" }, { path: "/work/payments" }], base: "main" }));

  const onward = value.links.find(({ link }) => link.from.repo === "webapp");
  const next = value.links.find(({ link }) => link.from.repo === "orders");
  assert.deepEqual(value.links.map(({ link, direction }) => `${direction} ${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name}`), [
    "downstream orders:7 -> payments POST /charges",
    "downstream webapp:9 -> orders POST /orders",
  ]);
  assert.deepEqual(onward?.reach, [onward?.link.id]);
  assert.deepEqual(next?.reach, [onward?.link.id, next?.link.id]);
});

test("a downstream consumer's expansion cut remains on its repository section", async () => {
  const { queries } = setup({
    repositories: {
      webapp: { callSites: [callSite("webapp", "orders-api/orders", "POST", 9)] },
      orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders")], callSites: [callSite("orders", "payments/charges", "POST", 7)] },
      payments: { entrypoints: [routeOf(CHARGES, "POST", "/charges")] },
    },
    trigger: impactOf([], { seeds: [{ file: "src/app/webapp.api.ts", symbol: "call9", line: 9, basis: "lines" }] }),
    walkFact: (repo, answer) => repo === "orders" && answer.status === "complete" ? { ...answer, status: "partial", cuts: [{ kind: "caller-budget", at: ["orders.call7"], limit: 1 }] } : answer,
  });
  const result = await queries.ofChange({ repo: { path: "/work/webapp" }, repos: [{ path: "/work/orders" }, { path: "/work/payments" }], base: "main" });
  const section = valueOf(result).sections.orders;
  assert.equal(section?.status, "partial");
  assert.deepEqual(section?.status === "partial" && section.cuts, [{ kind: "caller-budget", at: ["orders.call7"], limit: 1 }]);
});

test("a cycle between two repositories terminates and admits each link once", async () => {
  const { queries, walks } = setup({
    repositories: {
      orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders")], callSites: [callSite("orders", "webapp/orders", "GET", 9)] },
      webapp: { entrypoints: [routeOf(ORDER_PAGE, "GET", "/orders")], callSites: [callSite("webapp", "orders-api/orders", "POST", 7)] },
    },
    trigger: impactOf([reachedRoute(ORDER_CONTROLLER, "POST", "/orders")]),
    reached: {
      webapp: [{ line: 7, declaration: 2, symbol: "webapp.call7", entrypoints: [reachedRoute(ORDER_PAGE, "GET", "/orders")] }],
      orders: [{ line: 9, declaration: 4, symbol: "orders.call9", entrypoints: [reachedRoute(ORDER_LIST, "GET", "/orders")] }],
    },
  });

  const value = valueOf(await queries.callers({ repo: { path: "/work/orders" }, repos: [{ path: "/work/webapp" }], targets: ASK.targets }));

  assert.deepEqual(value.links.map(({ link }) => `${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name}`), [
    "orders:9 -> webapp GET /orders",
    "webapp:7 -> orders POST /orders",
  ]);
  assert.deepEqual(walks.map((walk) => `${walk.repoId}:${walk.targets.length}`), ["orders:1", "webapp:1", "orders:1"]);
  assert.deepEqual(repoImpact(value, "orders").impact?.entrypoints.map(({ name }) => name), ["POST /orders"]);
  assert.deepEqual(repoImpact(value, "orders").reads.map(({ kind }) => kind), ["discovery", "trigger", "upstream"]);
  assert.ok(repoImpact(value, "orders").reads.every(({ fact }) => !("value" in fact)));
});

test("a repository is walked once for the call sites one round admits, and again only when a fresh link feeds it", async () => {
  const { queries, walks } = setup({
    repositories: {
      payments: { entrypoints: [routeOf(CHARGES, "POST", "/charges"), routeOf(REFUNDS, "GET", "/refunds")] },
      orders: {
        entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders"), routeOf(ORDER_LIST, "GET", "/orders")],
        callSites: [callSite("orders", "payments/charges", "POST", 7), callSite("orders", "payments/refunds", "GET", 8)],
      },
      webapp: { callSites: [callSite("webapp", "orders-api/orders", "POST", 9), callSite("webapp", "orders-api/orders", "GET", 12)] },
    },
    trigger: impactOf([reachedRoute(CHARGES, "POST", "/charges"), reachedRoute(REFUNDS, "GET", "/refunds")]),
    reached: {
      orders: [
        { line: 7, declaration: 3, symbol: "orders.call7", entrypoints: [reachedRoute(ORDER_CONTROLLER, "POST", "/orders")] },
        { line: 8, declaration: 3, symbol: "orders.call8", entrypoints: [reachedRoute(ORDER_LIST, "GET", "/orders")] },
      ],
    },
  });

  const value = valueOf(await queries.callers(askIn("payments", ["orders", "webapp"])));

  const [charges, refunds, posted, listed] = value.links;
  assert.deepEqual(walks.map((walk) => walk.repoId), ["payments", "orders", "webapp"]);
  assert.deepEqual(walks[1]?.targets.map((target) => ("start" in target ? target.start : -1)), [7, 8]);
  assert.deepEqual(charges?.reach, [charges?.link.id]);
  assert.deepEqual(refunds?.reach, [refunds?.link.id]);
  assert.deepEqual(posted?.reach, [charges?.link.id, posted?.link.id]);
  assert.deepEqual(listed?.reach, [refunds?.link.id, listed?.link.id]);
});

test("a removed route seeds its consumers, and the route they serve seeds the next repository", async () => {
  const removed = impactOf([], { changedEntrypoints: [{ change: "removed", kind: "http-route", name: "DELETE /charges/{id}", handler: CHARGES }] });
  const { queries } = setup({
    repositories: {
      payments: {},
      orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "DELETE", "/orders/{id}")], callSites: [callSite("orders", "payments/charges/:id", "DELETE", 7)] },
      webapp: { callSites: [callSite("webapp", "orders-api/orders/:id", "DELETE", 9)] },
    },
    trigger: removed,
    reached: { orders: [{ line: 7, declaration: 3, symbol: "orders.call7", entrypoints: [reachedRoute(ORDER_CONTROLLER, "DELETE", "/orders/{id}")] }] },
  });

  const value = valueOf(await queries.ofChange({ repo: { path: "/work/payments" }, repos: [{ path: "/work/orders" }, { path: "/work/webapp" }], base: "main" }));

  const [hop, onward] = value.links;
  assert.deepEqual(value.links.map(({ link }) => `${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name}`), [
    "orders:7 -> payments DELETE /charges/{id}",
    "webapp:9 -> orders DELETE /orders/{id}",
  ]);
  assert.deepEqual(onward?.reach, [hop?.link.id, onward?.link.id]);
});

test("a published destination and the NATS listener it reaches carry a chain as an HTTP call and route do", async () => {
  const { queries } = setup({
    repositories: {
      notifications: { entrypoints: [listener("orders.*", "nats", NOTIFY)] },
      orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders")], callSites: [eventSite("orders", "orders.created", 7, "nats")] },
      webapp: { callSites: [callSite("webapp", "orders-api/orders", "POST", 9)] },
    },
    trigger: impactOf([{ kind: "listener", name: "nats orders.*", handler: NOTIFY, depth: 0, confidence: 1, seeds: [] }]),
    reached: { orders: [{ line: 7, declaration: 3, symbol: "orders.publish7", entrypoints: [reachedRoute(ORDER_CONTROLLER, "POST", "/orders")] }] },
  });

  const value = valueOf(await queries.callers(askIn("notifications", ["orders", "webapp"])));

  const [published, called] = value.links;
  assert.deepEqual(value.links.map(({ link }) => `${link.from.repo} -> ${link.to.repo} ${link.to.name} (${link.basis})`), [
    "orders -> notifications nats orders.* (event-destination)",
    "webapp -> orders POST /orders (route-overlap)",
  ]);
  assert.deepEqual(called?.reach, [published?.link.id, called?.link.id]);
});

test("a link both directions reach enters the answer once, with the nearest reach and the direction that reached it first", async () => {
  const { queries } = setup({
    repositories: {
      orders: { entrypoints: [routeOf(ORDER_CONTROLLER, "POST", "/orders")], callSites: [callSite("orders", "webapp/orders", "GET", 9)] },
      webapp: { entrypoints: [routeOf(ORDER_PAGE, "GET", "/orders")], callSites: [callSite("webapp", "orders-api/orders", "POST", 7)] },
    },
    trigger: impactOf([reachedRoute(ORDER_CONTROLLER, "POST", "/orders")], { seeds: [{ file: "src/app/orders.api.ts", symbol: "call9", line: 9, basis: "lines" }] }),
    reached: { webapp: [{ line: 7, declaration: 2, symbol: "webapp.call7", entrypoints: [reachedRoute(ORDER_PAGE, "GET", "/orders")] }] },
  });

  const value = valueOf(await queries.ofChange({ repo: { path: "/work/orders" }, repos: [{ path: "/work/webapp" }], base: "main" }));

  const [onward, back] = value.links;
  assert.deepEqual(value.links.map(({ link, direction }) => `${direction} ${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name}`), [
    "downstream orders:9 -> webapp GET /orders",
    "upstream webapp:7 -> orders POST /orders",
  ]);
  assert.deepEqual(onward?.reach, [onward?.link.id]);
  assert.deepEqual(back?.reach, [back?.link.id]);
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

const ASK_WITHOUT_REPOS = { repo: { path: "/work/orders" }, targets: [{ file: HANDLER.path, symbol: HANDLER.symbol }] };

test("a request that names no repositories joins the persisted manifest's repositories with its gateways", async () => {
  const asked: string[] = [];
  const { queries, asks } = setup({
    repositories: {
      orders: { entrypoints: [route("POST", "/orders")] },
      webapp: { callSites: [callSite("webapp", "orders-api/orders", "POST", 9)] },
    },
    defaults: persisted({ repos: [{ path: "/work/webapp" }], gateways: [{ prefix: "orders-api", repo: "orders" }] }, asked),
    trust: TRUSTED,
  });

  const value = valueOf(await queries.callers(ASK_WITHOUT_REPOS));

  assert.deepEqual(asked, ["/work/orders"]);
  assert.equal(asks[0]?.repos, undefined);
  assert.equal(asks[0]?.gateways, undefined);
  assert.equal(value.workspace.source, "persisted");
  assert.deepEqual(value.workspace.gateways.map((gateway) => `${gateway.prefix} ${gateway.repo} ${gateway.basis}`), ["orders-api orders gateway-prefix"]);
  assert.deepEqual(value.links.map(({ link }) => `${link.from.repo} -> ${link.to.repo} ${link.to.name} (${link.basis})`), ["webapp -> orders POST /orders (gateway-prefix)"]);
});

test("a request that names repositories ignores the persisted workspace, its gateways included", async () => {
  const asked: string[] = [];
  const { queries, asks } = setup({
    repositories: { orders: { entrypoints: [route("POST", "/orders")] }, webapp: { callSites: [callSite("webapp", "orders/orders")] } },
    defaults: persisted({ repos: [{ path: "/work/webapp" }], gateways: [{ prefix: "orders-api", repo: "orders" }] }, asked),
  });

  const value = valueOf(await queries.callers({ ...ASK_WITHOUT_REPOS, repos: [{ path: "/work/webapp" }] }));

  assert.deepEqual(asked, []);
  assert.equal(asks[0]?.gateways, undefined);
  assert.deepEqual(value.workspace.gateways.filter((gateway) => gateway.basis === "gateway-prefix"), []);
});

test("a manifest that cannot be read is a fault and nothing is walked", async () => {
  const { queries, walks } = setup({
    repositories: { orders: { entrypoints: [route("POST", "/orders")] } },
    defaults: { of: async () => ({ ok: false, fault: { kind: "unreadable", detail: ".ye-ast/workspace.json: repos: a non-empty array" } }), resolve: (_root, manifest) => manifest },
    trust: TRUSTED,
  });

  const result = await queries.callers(ASK_WITHOUT_REPOS);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.fault.kind, "unreadable");
  assert.deepEqual(walks, []);
});

test("a repository that persists no manifest answers exactly as it does without one", async () => {
  const repositories: Setup["repositories"] = {
    orders: { entrypoints: [route("POST", "/orders")] },
    webapp: { callSites: [callSite("webapp", "orders-api/orders", "POST", 9)] },
  };
  const request = { ...ASK_WITHOUT_REPOS, repos: [{ path: "/work/webapp" }] };

  const without = await setup({ repositories }).queries.callers(request);
  const withNone = await setup({ repositories, defaults: persisted(undefined) }).queries.callers(request);

  assert.equal(JSON.stringify(withNone), JSON.stringify(without));
});

test("a repository the read could not reach keeps its unknown section, so the answer is partial and names why", async () => {
  const { queries } = setup({ repositories: { orders: ORDERS, "shop-web": {} }, unavailable: ["orders-web"] });

  const result = await queries.callers(ASK);

  assert.ok(result.ok);
  assert.equal(result.value.fact.status, "partial");
  assert.deepEqual(result.value.fact.status === "partial" ? result.value.fact.cuts : [], [{ kind: "section", at: ["orders-web"] }]);
  const section = valueOf(result).sections["orders-web"];
  assert.equal(section?.status, "unknown");
  assert.equal(section?.status === "unknown" ? section.reason : undefined, "revision-unavailable");
});

const REFRESH: WorkspaceRefresh = {
  resolution: [{ repo: "shop-web", step: "trigger-line", consulted: [{ branch: "topic", sha: OTHER_SHA }], sha: OTHER_SHA }],
  freshness: [{ repo: "shop-web", url: "https://git.example.com/shop-web.git", freshness: { status: "verified" } }],
};

test("a callers and a change answer carry the refresh the workspace read consumed beside the fact, and none when it refreshed nothing", async () => {
  const repositories: Setup["repositories"] = { orders: ORDERS, "shop-web": { callSites: [callSite("shop-web", "orders-api/orders")] } };
  const change = { repo: { ...ASK.repo, revision: SHA }, repos: ASK.repos, base: OTHER_SHA };

  const plain = setup({ repositories });
  const refreshed = setup({ repositories, refresh: REFRESH });
  const [beforeCallers, beforeChange] = [await plain.queries.callers(ASK), await plain.queries.ofChange(change)];
  const [afterCallers, afterChange] = [await refreshed.queries.callers(ASK), await refreshed.queries.ofChange(change)];

  assert.ok(beforeCallers.ok && beforeChange.ok && afterCallers.ok && afterChange.ok);
  assert.equal("refresh" in beforeCallers.value, false);
  assert.equal("refresh" in beforeChange.value, false);
  assert.deepEqual(afterCallers.value.refresh, REFRESH);
  assert.deepEqual(afterChange.value.refresh, REFRESH);
  assert.deepEqual(afterCallers.value.fact, beforeCallers.value.fact);
  assert.deepEqual(afterChange.value.fact, beforeChange.value.fact);
  assert.equal("refresh" in afterCallers.value.fact || "refresh" in afterChange.value.fact, false);
});

test("callers and change replay discovery pins and reject mismatch before any walk", async () => {
  const fixture = setup({ repositories: { orders: { entrypoints: [route("POST", "/orders")] }, webapp: { callSites: [callSite("webapp", "orders-api/orders")] } }, unavailable: ["missing"], defaults: persisted({ repos: [{ path: "/work/webapp", revision: "main" }], gateways: [{ prefix: "orders-api", repo: "orders" }] }), trust: TRUSTED });
  const context = { version: 1 as const, declaration: `ws-r1:${"c".repeat(64)}`, snapshots: [{ repo: "missing", kind: "sha" as const, sha: SHA }, { repo: "orders", kind: "sha" as const, sha: SHA }, { repo: "webapp", kind: "sha" as const, sha: OTHER_SHA }] };
  let current = OTHER_SHA;
  const seen: WorkspaceRequest[] = [];
  const calls: { repo: string; revision: string; source?: string }[] = [];
  const workspace: WorkspaceQueries = { outwardNames: async (request) => {
    seen.push(request);
    if (request.replay !== undefined && request.replay.declaration !== context.declaration) return { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "mismatch" } };
    const answer = await fixture.read_.outwardNames(request);
    if (!answer.ok || answer.value.fact.status === "unknown") return answer;
    const sha = request.replay === undefined ? current : OTHER_SHA;
    const original = answer.value.fact;
    const section = original.value.sections.webapp!;
    const snapshot = { repo: "webapp", kind: "sha" as const, sha };
    return { ok: true, value: { ...answer.value, workspaceReplay: context, repositorySources: [{ repo: "orders", path: "/work/orders" }, { repo: "webapp", path: "/mirror/webapp" }], fact: { ...original, value: { ...original.value, repositories: original.value.repositories.map((item) => item.repo === "webapp" ? { ...item, snapshot } : item), sections: { ...original.value.sections, webapp: { ...section, snapshot } }, repositorySnapshots: original.value.repositorySnapshots.map((item) => item.repo === "webapp" ? { ...item, snapshot } : item) } } } };
  } };
  const impact: ImpactQueries = {
    callers: async (request) => { assert.ok(request.revision); calls.push({ repo: request.repo, revision: request.revision, ...(request.source === undefined ? {} : { source: request.source }) }); return { ok: true, value: fact(request.repoId, "trusted", impactOf(request.repoId === "orders" ? REACHED : []), request.revision) }; },
    ofChange: async (request) => { assert.ok(request.head); calls.push({ repo: request.repo, revision: request.head }); return { ok: true, value: fact(request.repoId, "trusted", impactOf(REACHED, { mergeBase: SHA }), request.head) }; },
    importers: async () => { throw new Error("unexpected"); },
  };
  const queries = createWorkspaceImpactQueries({ workspace, impact, digest: { of: (text) => `digest(${text})` } });
  const callers = ASK_WITHOUT_REPOS;
  const change = { repo: { ...callers.repo, revision: "main" }, base: SHA };
  const first = await queries.callers(callers);
  const firstChange = await queries.ofChange(change);
  assert.ok(first.ok && firstChange.ok);
  assert.deepEqual(first.value.workspaceReplay, context);
  assert.equal(valueOf(first).workspace.source, "persisted");
  assert.equal(valueOf(first).sections.missing?.status, "unknown");
  assert.ok(calls.some((call) => call.repo === "/work/webapp" && call.revision === OTHER_SHA && call.source === "/mirror/webapp"));
  assert.deepEqual(calls.filter((call) => call.repo === "/work/orders").map((call) => call.revision), [SHA, SHA]);
  assert.equal(first.value.repositorySources, undefined);
  assert.ok(first.value.repositoryRoots);
  current = "d".repeat(40);
  const replayed = await queries.callers({ ...callers, replay: context });
  const replayedChange = await queries.ofChange({ ...change, replay: context });
  assert.ok(replayed.ok && replayedChange.ok);
  assert.deepEqual(replayed.value.fact, first.value.fact);
  assert.deepEqual(replayedChange.value.fact, firstChange.value.fact);
  assert.ok(seen.every((request) => request.repos === undefined && request.gateways === undefined));
  assert.equal(seen[0]?.replay, undefined);
  assert.equal(seen[1]?.replay, undefined);
  assert.deepEqual(seen[2]?.replay, context);
  assert.deepEqual(seen[3]?.replay, context);
  const count = calls.length;
  const mismatch = await queries.callers({ ...callers, replay: { ...context, declaration: `ws-r1:${"e".repeat(64)}` } });
  assert.ok(!mismatch.ok && mismatch.fault.kind === "workspace-replay-mismatch");
  assert.equal(calls.length, count);
});


test("captured walks reject discovery head and state mismatches before walking", async () => {
  for (const field of ["head", "stateId"] as const) {
    const s = capturedChangeFixture();
    const operation: WorkspaceReadOperation = { withRead: (request, use) => s.operation.withRead(request, (read, context) => {
      const fact = read.fact;
      assert.ok(fact.status !== "unknown");
      const section = fact.value.sections.webapp!;
      assert.ok(section.snapshot.kind === "live");
      const snapshot = { ...section.snapshot, [field]: field === "head" ? OTHER_SHA : "another-capture" };
      return use({ ...read, fact: { ...fact, value: { ...fact.value, sections: { ...fact.value.sections, webapp: { ...section, snapshot } } } } }, context);
    }) };
    const queries = createCapturedWorkspaceImpactQueries({ operation, digest: { of: (text) => text }, impactAt: () => ({
      callers: async () => assert.fail("mismatched discovery must not walk"),
      ofChange: async () => assert.fail("mismatched discovery must not walk"),
      importers: async () => assert.fail("unexpected importers walk"),
    }) });
    const result = await queries.callers({ repo: { path: "/work/webapp", live: true }, repos: [{ path: "/work/orders", live: true }, { path: "/work/payments" }], targets: ASK.targets });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.fault.kind, "git-failed");
    assert.equal(s.fake.held.locks, s.fake.held.released);
  }
});
