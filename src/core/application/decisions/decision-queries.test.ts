import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "../../domain/decisions/decision.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import { SCHEMA, type CompleteFact, type Fact, type Finding, type PartialFact } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import type { NameCandidate, OutwardName } from "../../domain/topology/outward-name.ts";
import type { DecisionQueries, DecisionValue } from "../../ports/decision-queries.port.ts";
import type { Vcs, RemoteRef } from "../../ports/vcs.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceFault, WorkspaceRepository, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries, WorkspaceRefresh, WorkspaceRequest, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import { createDecisionQueries } from "./decision-queries.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function base<T>(value: T): CompleteFact<T> {
  return {
    schema: SCHEMA,
    snapshot: { repo: "orders", kind: "sha", sha: SHA },
    producer: { name: "ye-ast", version: "0.0.0" },
    inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
    evidence: [{ path: "src/app/order.api.ts", line: 7 }],
    status: "complete",
    value,
  };
}

function route(path: string, line: number): HttpRoute {
  return { kind: "http-route", name: `GET ${path}`, method: "GET", path, handler: { path: `src/${path.slice(1)}.java`, symbol: "App.run", line }, basePath: { status: "unknown", reason: "unresolved", evidence: [] } };
}

function served(value: Entrypoint): Finding<Entrypoint> {
  return { status: "complete", value, evidence: [] };
}

function callSite(repo: string, path: string): CallSite {
  return { repo, file: `src/app/${repo}.api.ts`, line: 7, symbol: `${repo}.call`, transport: "http", target: { status: "complete", value: { method: "GET", path }, evidence: [] } };
}

function repository(repo: string, overrides: Partial<WorkspaceRepository> = {}): WorkspaceRepository {
  return { repo, path: `/work/${repo}`, snapshot: { repo, kind: "sha", sha: SHA }, entrypoints: [], callSites: [], declaredTrust: "untrusted", ...overrides };
}

function outward(name: string): OutwardName {
  return { name, kind: "path-prefix", evidence: [{ path: `src/${name}.ts`, line: 2 }] };
}

function section(repo: string, names: readonly OutwardName[]): Fact<WorkspaceSection> {
  return { ...base<WorkspaceSection>({ names, unresolved: [] }), snapshot: { repo, kind: "sha", sha: SHA } };
}

const ORDERS = repository("orders", { entrypoints: [served(route("/orders", 10))] });
const BILLING = repository("billing", { entrypoints: [served(route("/orders", 20))] });
const ORDERS_CORE = repository("orders-core");
const WEB = repository("shop-web", { callSites: [callSite("shop-web", "geo-api/orders")] });

function workspaceValue(gateways: readonly { prefix: string; repo: string }[] = []): WorkspaceValue {
  const read = [BILLING, ORDERS, ORDERS_CORE, WEB];
  const candidates: NameCandidate[] = [
    { name: "orders-api", repo: "orders", basis: "exact-name", evidence: [{ path: "src/app/order.api.ts", line: 7 }] },
    { name: "shared-api", repo: "orders-core", basis: "artifact", evidence: [{ path: "src/app/shared.api.ts", line: 3 }] },
  ];
  return {
    workspace: { repos: read.map(({ repo }) => repo), gateways, source: "request" },
    repositorySnapshots: read.map(({ repo, snapshot }) => ({ repo, snapshot })),
    sections: { billing: section("billing", []), orders: section("orders", []), "orders-core": section("orders-core", []), "shop-web": section("shop-web", [outward("shared-api")]) },
    candidates,
    unserved: [{ name: "geo.example.com", kind: "http-host", evidence: [{ path: "src/app/geo.api.ts", line: 11 }] }],
    repositories: read,
  };
}

const REQUEST: WorkspaceRequest = { repo: { path: "/work/orders" }, repos: [{ path: "/work/shop-web" }, { path: "/work/billing" }] };

function setup(answer: Result<Fact<WorkspaceValue>, WorkspaceFault>, defaults?: WorkspaceDefaults, refresh?: WorkspaceRefresh, vcs: Pick<Vcs, "remotes"> = remotesOf({})): { queries: DecisionQueries; asks: WorkspaceRequest[] } {
  const asks: WorkspaceRequest[] = [];
  const workspace: WorkspaceQueries = {
    outwardNames: async (request) => {
      asks.push(request);
      return answer.ok ? { ok: true, value: { fact: answer.value, ...(refresh === undefined ? {} : { refresh }) } } : answer;
    },
  };
  return { queries: createDecisionQueries({ workspace, ...(defaults === undefined ? {} : { defaults }), vcs }), asks };
}

/** A git that states the remotes of each clone named here, and every clone it was asked about. */
function remotesOf(stated: Readonly<Record<string, string | readonly RemoteRef[]>>, asked: string[] = []): Pick<Vcs, "remotes"> {
  return {
    remotes: async (repo) => {
      asked.push(repo);
      const remotes = stated[repo];
      if (remotes === undefined) return { ok: true, value: [] };
      return { ok: true, value: typeof remotes === "string" ? [{ name: "origin", url: remotes }] : remotes };
    },
  };
}

/** The declaration a repository persisted, as the defaults port answers it. */
function declared(repos: readonly { path: string; id?: string }[]): WorkspaceDefaults {
  return { of: async () => ({ ok: true, value: { repos } }), resolve: (_root, manifest) => manifest };
}

function valueOf(result: Result<FactRead<DecisionValue>, WorkspaceFault>): DecisionValue {
  assert.ok(result.ok);
  assert.notEqual(result.value.fact.status, "unknown");
  return (result.value.fact as { value: DecisionValue }).value;
}

function decisionOf(value: DecisionValue, id: string): Decision {
  const found = value.decisions.find((decision) => decision.id === id);
  assert.ok(found !== undefined, id);
  return found;
}

test("each gap the workspace read states becomes one decision, in the domain's order", async () => {
  const { queries } = setup({ ok: true, value: base(workspaceValue()) });

  const value = valueOf(await queries.decisions(REQUEST));

  assert.equal(value.source, "request", "the set says where its repositories came from");
  assert.deepEqual(value.decisions.map((decision) => decision.id), ["gateway:geo-api", "membership:clone:billing", "membership:name:shared-api", "repository:geo.example.com"]);
  assert.deepEqual(
    decisionOf(value, "membership:name:shared-api").options.map((option) => `${option.value}${option.recommended ? "*" : ""}${option.basis === undefined ? "" : `(${option.basis})`}`),
    ["orders-core*(artifact)"],
  );
  const unserved = decisionOf(value, "repository:geo.example.com");
  assert.deepEqual(unserved.options, []);
  assert.equal(unserved.allowsFreeText, true);
  assert.deepEqual(unserved.evidence, [{ path: "src/app/geo.api.ts", line: 11 }]);
});

test("a clone the persisted declaration holds is no membership decision, and a name the bound repository serves is none either", async () => {
  const { queries } = setup({ ok: true, value: base(workspaceValue()) }, declared([
    { path: "/work/billing", id: "billing" },
    { path: "/work/orders-core", id: "orders-core" },
  ]));

  const ids = valueOf(await queries.decisions(REQUEST)).decisions.map((decision) => decision.id);

  assert.deepEqual(ids, ["gateway:geo-api", "repository:geo.example.com"]);
});

test("a declaration that cannot be read fails the set with its fault", async () => {
  const broken: WorkspaceDefaults = { of: async () => ({ ok: false, fault: { kind: "unreadable", detail: ".ye-ast/workspace.json: broken" } }), resolve: (_root, manifest) => manifest };
  const { queries } = setup({ ok: true, value: base(workspaceValue()) }, broken);

  assert.deepEqual(await queries.decisions(REQUEST), { ok: false, fault: { kind: "unreadable", detail: ".ye-ast/workspace.json: broken" } });
});

test("the options of a gateway come from the routes each repository serves behind the prefix", async () => {
  const { queries } = setup({ ok: true, value: base(workspaceValue()) });

  const gateway = decisionOf(valueOf(await queries.decisions(REQUEST)), "gateway:geo-api");

  assert.deepEqual(
    gateway.options.map((option) => `${option.value} ${option.evidence.map((evidence) => `${evidence.path}:${evidence.line}`).join()}`),
    ["billing src/orders.java:20", "orders src/orders.java:10"],
  );
});

test("a clone that states no name is offered as a membership decision, and one whose section states a name is not", async () => {
  const { queries } = setup({ ok: true, value: base(workspaceValue()) });

  const ids = valueOf(await queries.decisions(REQUEST)).decisions.map((decision) => decision.id);

  assert.ok(ids.includes("membership:clone:billing"));
  assert.equal(ids.includes("membership:clone:shop-web"), false);
});

test("the decision fact carries the workspace read's base and the snapshot of every repository it read", async () => {
  const read = base(workspaceValue());
  const { queries, asks } = setup({ ok: true, value: read });

  const result = await queries.decisions(REQUEST);

  assert.deepEqual(asks, [REQUEST]);
  assert.ok(result.ok);
  const { schema, snapshot, producer, inputs } = read;
  assert.deepEqual(result.value.fact, { schema, snapshot, producer, inputs, evidence: [], status: "complete", value: valueOf(result) });
  assert.deepEqual(valueOf(result).repositories, read.value.repositorySnapshots);
});

test("a gateway the caller declares is not a gap", async () => {
  const gateways = [{ prefix: "geo-api", repo: "orders" }];
  const { queries } = setup({ ok: true, value: base(workspaceValue(gateways)) });

  const ids = valueOf(await queries.decisions({ ...REQUEST, gateways })).decisions.map((decision) => decision.id);

  assert.equal(ids.includes("gateway:geo-api"), false);
});

test("a workspace read that fails answers its fault and no decision", async () => {
  const { queries } = setup({ ok: false, fault: { kind: "unknown-revision", detail: "no such revision" } });

  assert.deepEqual(await queries.decisions(REQUEST), { ok: false, fault: { kind: "unknown-revision", detail: "no such revision" } });
});

test("a workspace read that answers nothing is a git-failed fault, never an empty set", async () => {
  const unknown: Fact<WorkspaceValue> = { ...base(workspaceValue()), status: "unknown", reason: "index-unavailable" } as Fact<WorkspaceValue>;
  const { queries } = setup({ ok: true, value: unknown });

  const result = await queries.decisions(REQUEST);

  assert.ok(!result.ok);
  assert.equal(result.fault.kind, "git-failed");
});

test("a partial workspace read keeps its cuts on the decision fact", async () => {
  const cuts = [{ kind: "section", at: ["shop-web"] }] as const;
  const partial: Fact<WorkspaceValue> = { ...base(workspaceValue()), status: "partial", cuts } as PartialFact<WorkspaceValue>;
  const { queries } = setup({ ok: true, value: partial });

  const result = await queries.decisions(REQUEST);

  assert.ok(result.ok);
  assert.equal(result.value.fact.status, "partial");
  assert.deepEqual(result.value.fact.status === "partial" ? result.value.fact.cuts : [], cuts);
});

test("a repository with no declared trust is a required decision, and one with a record is not", async () => {
  const value = workspaceValue();
  const repositories = value.repositories.map((repository) =>
    repository.repo === "billing"
      ? { repo: repository.repo, path: repository.path, snapshot: repository.snapshot, entrypoints: repository.entrypoints, callSites: repository.callSites }
      : repository,
  );
  const { queries } = setup({ ok: true, value: base<WorkspaceValue>({ ...value, repositories }) });

  const result = await queries.decisions(REQUEST);

  assert.ok(result.ok);
  assert.notEqual(result.value.fact.status, "unknown");
  const trust = (result.value.fact as CompleteFact<DecisionValue>).value.decisions.filter((decision) => decision.kind === "trust");
  assert.deepEqual(trust.map((decision) => `${decision.id} ${decision.required} ${decision.options.map((option) => option.value).join(",")}`), ["trust:billing true trusted,untrusted"]);
});

const REFRESH: WorkspaceRefresh = {
  resolution: [{ repo: "billing", step: "default-branch", consulted: [{ branch: "main", sha: OTHER_SHA }], sha: OTHER_SHA }],
  freshness: [{ repo: "billing", url: "https://git.example.com/billing.git", freshness: { status: "verified" } }],
};

test("the decision answer carries the refresh the workspace read consumed beside the fact", async () => {
  const plain = await setup({ ok: true, value: base(workspaceValue()) });
  const refreshed = await setup({ ok: true, value: base(workspaceValue()) }, undefined, REFRESH);

  const before = await plain.queries.decisions(REQUEST);
  const after = await refreshed.queries.decisions(REQUEST);

  assert.ok(before.ok && after.ok);
  assert.equal("refresh" in before.value, false);
  assert.deepEqual(after.value.refresh, REFRESH);
  assert.deepEqual(after.value.fact, before.value.fact);
  assert.equal("refresh" in after.value.fact, false);
});

test("a repository the request declares without a remote offers each remote its clone states, and the bound repository is never read for one", async () => {
  const asked: string[] = [];
  const vcs = remotesOf(
    {
      "/work/billing": [
        { name: "origin", url: "https://git.example.com/me/billing.git" },
        { name: "upstream", url: "https://git.example.com/shop/billing.git" },
      ],
      "/work/shop-web": "https://git.example.com/shop-web.git",
    },
    asked,
  );
  const { queries } = setup({ ok: true, value: base(workspaceValue()) }, undefined, undefined, vcs);

  const value = valueOf(await queries.decisions(REQUEST));

  assert.deepEqual(asked, ["/work/billing", "/work/shop-web"]);
  const remote = decisionOf(value, "remote:billing");
  assert.deepEqual(
    remote.options.map((option) => `${option.value}${option.recommended ? "*" : ""}(${option.basis} ${option.evidence.map((place) => place.via).join(",")})`),
    ["https://git.example.com/me/billing.git(origin origin)", "https://git.example.com/shop/billing.git(origin upstream)"],
  );
  assert.equal(remote.allowsFreeText, true);
  assert.equal(value.decisions.some((decision) => decision.id === "remote:orders"), false);
});

test("a remote the declaration would refuse as an address is no option, and the gap keeps its free text", async () => {
  const vcs = remotesOf({ "/work/billing": [{ name: "origin", url: "/srv/git/billing.git" }] });
  const { queries } = setup({ ok: true, value: base(workspaceValue()) }, undefined, undefined, vcs);

  const remote = decisionOf(valueOf(await queries.decisions(REQUEST)), "remote:billing");

  assert.deepEqual(remote.options, []);
  assert.equal(remote.allowsFreeText, true);
});

test("a repository whose declaration states a remote is not read for an origin and is no remote decision", async () => {
  const asked: string[] = [];
  const vcs = remotesOf({ "/work/billing": "https://git.example.com/billing.git", "/work/shop-web": "https://git.example.com/shop-web.git" }, asked);
  const { queries } = setup({ ok: true, value: base(workspaceValue()) }, undefined, undefined, vcs);

  const value = valueOf(
    await queries.decisions({ ...REQUEST, repos: [{ path: "/work/shop-web", remote: "https://git.example.com/shop-web.git" }, { path: "/work/billing" }] }),
  );

  assert.deepEqual(asked, ["/work/billing"]);
  assert.deepEqual(value.decisions.filter((decision) => decision.kind === "remote").map((decision) => decision.id), ["remote:billing"]);
});

test("a clone's remotes that cannot be read fail the set with that fault", async () => {
  const broken: Pick<Vcs, "remotes"> = { remotes: async () => ({ ok: false, fault: { kind: "git-failed", detail: "/work/billing: no repository" } }) };
  const { queries } = setup({ ok: true, value: base(workspaceValue()) }, undefined, undefined, broken);

  assert.deepEqual(await queries.decisions(REQUEST), { ok: false, fault: { kind: "git-failed", detail: "/work/billing: no repository" } });
});

test("a repository the refresh pinned at the default branch while the trigger's line differed is a revision decision, and the sidecar stays beside the fact", async () => {
  const refresh: WorkspaceRefresh = {
    resolution: [{ repo: "billing", step: "default-branch", consulted: [{ branch: "feature/web" }, { branch: "main", sha: OTHER_SHA }], sha: OTHER_SHA }],
    freshness: [{ repo: "billing", url: "https://git.example.com/billing.git", freshness: { status: "verified" } }],
  };
  const { queries } = setup({ ok: true, value: base(workspaceValue()) }, undefined, refresh);

  const result = await queries.decisions(REQUEST);

  assert.ok(result.ok);
  const revision = decisionOf(valueOf(result), "revision:billing");
  assert.deepEqual(revision.options.map((option) => `${option.value}${option.recommended ? "*" : ""}(${option.basis})`), ["main*(default-branch)"]);
  assert.equal(revision.allowsFreeText, true);
  assert.equal(revision.required, false);
  assert.deepEqual(result.value.refresh, refresh);
});

test("a clone origin adds only remote decisions, leaving every other decision byte-identical", async () => {
  const withoutVcs = valueOf(await setup({ ok: true, value: base(workspaceValue()) }).queries.decisions(REQUEST));
  const withVcs = valueOf(await setup({ ok: true, value: base(workspaceValue()) }, undefined, undefined, remotesOf({ "/work/billing": "https://git.example.com/billing.git" })).queries.decisions(REQUEST));

  assert.deepEqual(withVcs.decisions.filter((decision) => decision.kind !== "remote"), withoutVcs.decisions);
  assert.deepEqual(withVcs.decisions.filter((decision) => decision.kind === "remote").map((decision) => decision.id), ["remote:billing"]);
});

test("a clone that states no origin offers no remote decision", async () => {
  const value = valueOf(await setup({ ok: true, value: base(workspaceValue()) }, undefined, undefined, remotesOf({})).queries.decisions(REQUEST));

  assert.deepEqual(value.decisions.filter((decision) => decision.kind === "remote"), []);
});
