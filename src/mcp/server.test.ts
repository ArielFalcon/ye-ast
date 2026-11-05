import { test } from "node:test";
import assert from "node:assert/strict";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import { SCHEMA, type Cut, type Fact, type FactBase, type PartialFact, type Finding } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries, MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactCallersRequest, ImpactFault, ImpactImportersRequest, ImpactOfChangeRequest, ImpactQueries, OfChangeFault } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries, OutlineRequest } from "../core/ports/outline-queries.port.ts";
import type { OutlineValue } from "../core/domain/outline/outline-fact.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import type { VcsFault } from "../core/ports/vcs.port.ts";
import type { LiveFault } from "../core/ports/live-queries.port.ts";
import type { WorkspaceQueries, WorkspaceRequest, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceFault, WorkspaceSection } from "../core/ports/workspace-repos.port.ts";
import type { WorkspaceCallersRequest, WorkspaceImpactQueries, WorkspaceImpactValue, WorkspaceOfChangeRequest } from "../core/ports/workspace-impact-queries.port.ts";
import type { RepoImpact } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionQueries, DecisionsRequest, DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { OutwardName } from "../core/domain/topology/outward-name.ts";
import type { FactRead, WorkspaceRefresh } from "../core/ports/workspace-queries.port.ts";
import { createMcpServer, CUT_GUIDANCE, ENTRYPOINTS_OUTPUT, IMPACT_OUTPUT, CALLERS_OUTPUT, IMPORTERS_OUTPUT, OUTLINE_OUTPUT, WORKSPACE_OUTPUT, DECISIONS_OUTPUT } from "./server.ts";
import { openSession, type Session } from "./test-session.ts";
import { createHash } from "node:crypto";
import { encodeCursor, selectionDigest } from "./evidence-cursor.ts";

const SECRET = "hunter2-secret";
const REPOSITORY = { path: "/work/shop", repoId: "shop" };

function base(overrides: Partial<FactBase> = {}): FactBase {
  return {
    schema: SCHEMA,
    snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) },
    producer: { name: "ye-ast", version: "0.0.0" },
    inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: ["java"], frameworks: ["spring"], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
    evidence: [],
    ...overrides,
  };
}

const ROUTE: Entrypoint = {
  kind: "http-route",
  name: "GET /orders/{id}",
  method: "GET",
  path: "/orders/{id}",
  handler: { path: "src/OrderController.java", symbol: "OrderController.one", line: 17 },
  basePath: { status: "unknown", reason: "unresolved", evidence: [] },
};

function mapFact(overrides: Partial<EntrypointMapFact> = {}, repoId = "shop"): EntrypointMapFact {
  const b = (overrides: Partial<FactBase> = {}) => base({ ...overrides, snapshot: { ...base().snapshot, repo: repoId } });
  const item: Fact<Entrypoint> = { ...b({ evidence: [{ path: "src/OrderController.java", line: 17 }] }), status: "complete", value: ROUTE };
  const section: Fact<readonly Fact<Entrypoint>[]> = { ...b(), status: "complete", value: [item] };
  return { ...b(), status: "complete", value: { entrypoints: section }, ...overrides } as EntrypointMapFact;
}

const IMPACT: ImpactValue = {
  mergeBase: "b".repeat(40),
  seeds: [{ file: "src/OrderService.java", symbol: "OrderService.find", line: 31, basis: "lines" }],
  changedEntrypoints: [{ change: "added", kind: "http-route", name: "POST /orders", handler: { path: "src/OrderController.java", symbol: "OrderController.create", line: 40 } }],
  symbols: [{ file: "src/OrderController.java", symbol: "OrderController.one", kind: "method", line: 17, depth: 2, confidence: 0.75, fanIn: 3, via: { file: "src/OrderService.java", symbol: "OrderService.find", lines: [44], basis: "call" } }],
  entrypoints: [{ kind: "http-route", name: "GET /orders/{id}", handler: ROUTE.kind === "http-route" ? ROUTE.handler : never(), depth: 2, confidence: 0.75, seeds: [0] }],
  cost: { expansionsUsed: 0 },
};

function never(): never {
  throw new Error("unreachable");
}

function impactFact(overrides: Partial<Fact<ImpactValue>> = {}): Fact<ImpactValue> {
  return { ...base(), status: "complete", value: IMPACT, ...overrides } as Fact<ImpactValue>;
}

const SITE = { repo: "shop-web", file: "src/app/order.api.ts", line: 7, symbol: "OrderApi.create", transport: "http" as const, target: { status: "complete" as const, value: { method: "POST" as const, path: "orders-api/orders" }, evidence: [] } };

function workspaceImpactFact(): Fact<WorkspaceImpactValue> {
  const link = {
    id: "link-1",
    from: { repo: "shop-web", file: SITE.file, line: 7, symbol: SITE.symbol },
    to: { repo: "shop", kind: "http-route" as const, name: "GET /orders/{id}", handler: { path: "src/OrderController.java", symbol: "OrderController.one", line: 17 } },
    transport: "http" as const,
    basis: "route-overlap" as const,
    confidence: 1,
  };
  const section = (value: Omit<RepoImpact, "reads">): Fact<RepoImpact> => ({ ...base(), status: "complete", value: { ...value, reads: [] } });
  const value: WorkspaceImpactValue = {
    workspace: { repos: ["shop", "shop-web"], gateways: [{ prefix: "orders-api", repo: "shop", basis: "route-overlap" }], unmatchedGateways: [{ prefix: "legacy", repo: "shop" }], unserved: ["geo-api"], source: "request" },
    repositorySnapshots: [],
    trigger: { repo: "shop", mergeBase: "b".repeat(40) },
    sections: {
      shop: section({ impact: IMPACT, callSites: [], unmatched: [], external: [] }),
      "shop-web": section({ callSites: [SITE], unmatched: [{ ...SITE, line: 9, target: { status: "complete", value: { method: "GET", path: "orders-api/missing" }, evidence: [] } }], external: [{ ...SITE, line: 11, target: { status: "complete", value: { method: "GET", path: "geo-api/provinces" }, evidence: [] } }] }),
    },
    links: [{ link, direction: "upstream", reach: ["link-1"] }],
  };
  return { ...base(), status: "complete", value };
}

const WORKSPACE = { repos: [{ path: "/work/shop-web", id: "shop-web" }], gateways: [{ prefix: "edge", repo: "shop" }] };

const DECISIONS: DecisionValue = {
  repositories: [{ repo: "shop", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) } }],
  source: "request",
  decisions: [
    {
      id: "membership:name:orders-api",
      kind: "membership",
      subject: "orders-api",
      evidence: [{ path: "src/app/order.api.ts", line: 7, repo: "shop-web" }],
      options: [
        { value: "orders", basis: "exact-name", evidence: [{ path: "src/app/order.api.ts", line: 7, repo: "shop-web" }], recommended: true },
        { value: "orders-core", basis: "artifact", evidence: [], recommended: false },
      ],
      allowsFreeText: true,
      required: false,
    },
    {
      id: "repository:geo.example.com",
      kind: "repository",
      subject: "geo.example.com",
      evidence: [{ path: "src/app/geo.api.ts", line: 11, repo: "shop-web" }],
      options: [],
      allowsFreeText: true,
      required: false,
    },
  ],
};

function decisionFact(value: DecisionValue = DECISIONS): Fact<DecisionValue> {
  return { ...base(), status: "complete", value };
}

const DEPENDENCIES: readonly OutwardName[] = [
  { name: "@angular/core", kind: "dependency", evidence: [{ path: "package.json", line: 36 }] },
  { name: "@capacitor/core", kind: "dependency", evidence: [{ path: "package.json", line: 49 }] },
  { name: "rxjs", kind: "dependency", evidence: [{ path: "package.json", line: 74 }] },
];

const PREFIX: OutwardName = { name: "orders-api", kind: "path-prefix", evidence: [{ path: "src/app/order.api.ts", line: 7 }] };

function workspaceFact(): Fact<WorkspaceValue> {
  const names = [PREFIX, ...DEPENDENCIES];
  const section: Fact<WorkspaceSection> = {
    ...base(),
    status: "partial",
    value: { names, unresolved: [{ path: "src/app/order.api.ts", line: 9, endLine: 12, symbol: "OrderApi.create", transport: "http", stated: { method: "GET", path: "/orders" } }] },
    cuts: [{ kind: "unresolved-link", at: ["src/app/order.api.ts", "src/app/order.api.ts:9"] }],
  };
  return {
    ...base(),
    status: "partial",
    cuts: [{ kind: "section", at: ["shop"] }],
    value: {
      workspace: { repos: ["shop"], gateways: [], source: "request" },
      repositorySnapshots: [{ repo: "shop", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) } }],
      sections: { shop: section },
      candidates: [],
      unserved: names.map((name) => ({ ...name, evidence: name.evidence.map((place) => ({ ...place, repo: "shop" })) })),
      repositories: [],
    },
  };
}

const OUTLINE: OutlineValue = {
  files: [
    {
      file: "src/Order.java",
      declarations: [
        { kind: "class", name: "Order", line: 3, endLine: 40 },
        { kind: "method", name: "total", line: 20, endLine: 24 },
      ],
      imports: ["src/Money.java"],
    },
    { file: "src/Empty.java", declarations: [], imports: [] },
  ],
  unheld: ["src/Gone.swift"],
};

const IMPORTERS: ImportersValue = {
  files: [{ file: "src/OrderService.java", importers: ["src/OrderController.java"], users: ["src/OrderController.java", "src/Billing.java"], unresolvedNamers: ["src/Legacy.java"] }],
};

const fakeRedaction: Redaction = {
  redact: (text) => text.replaceAll(SECRET, REDACTED),
  redactValue: (value) => JSON.parse(JSON.stringify(value).replaceAll(SECRET, REDACTED)) as unknown,
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: (error) => String(error instanceof Error ? error.message : error).replaceAll(SECRET, REDACTED),
  containsSecret: (text) => text.includes(SECRET),
};

interface Calls {
  workspaceCallers: WorkspaceCallersRequest[];
  workspaceOfChange: WorkspaceOfChangeRequest[];
  workspaceReads: WorkspaceRequest[];
  map: MapRequest[];
  ofChange: ImpactOfChangeRequest[];
  callers: ImpactCallersRequest[];
  importers: ImpactImportersRequest[];
  outline: OutlineRequest[];
  decisions: DecisionsRequest[];
}

interface Answers {
  map: (request: MapRequest) => Promise<Result<EntrypointMapFact, VcsFault | LiveFault>>;
  ofChange: (request: ImpactOfChangeRequest) => Promise<Result<Fact<ImpactValue>, OfChangeFault>>;
  callers: (request: ImpactCallersRequest) => Promise<Result<Fact<ImpactValue>, ImpactFault>>;
  importers: (request: ImpactImportersRequest) => Promise<Result<Fact<ImportersValue>, VcsFault | LiveFault>>;
  outline: (request: OutlineRequest) => Promise<Result<Fact<OutlineValue>, VcsFault | LiveFault>>;
  outwardNames: (request: WorkspaceRequest) => Promise<Result<FactRead<WorkspaceValue>, WorkspaceFault>>;
  decisions: (request: DecisionsRequest) => Promise<Result<FactRead<DecisionValue>, WorkspaceFault>>;
  workspaceCallers: (request: WorkspaceCallersRequest) => Promise<Result<FactRead<WorkspaceImpactValue>, WorkspaceFault>>;
  workspaceOfChange: (request: WorkspaceOfChangeRequest) => Promise<Result<FactRead<WorkspaceImpactValue>, WorkspaceFault>>;
}

async function setup(answers: Partial<Answers> = {}, refresh?: WorkspaceRefresh, repositories?: readonly { path: string; repoId: string }[], repository = REPOSITORY, redaction: Redaction = fakeRedaction): Promise<{ session: Session; calls: Calls }> {
  const calls: Calls = { map: [], ofChange: [], callers: [], importers: [], outline: [], workspaceCallers: [], workspaceOfChange: [], workspaceReads: [], decisions: [] };
  /** A fact with the sidecar a read that refreshed something carries, and without one when it refreshed nothing. */
  const read = <T>(fact: Fact<T>): FactRead<T> => (refresh === undefined ? { fact } : { fact, refresh });
  const forRepo = <T>(fact: Fact<T>, repoId: string): Fact<T> => ({ ...fact, snapshot: { ...fact.snapshot, repo: repoId } });
  const entrypoints: EntrypointQueries = {
    map: (request) => {
      calls.map.push(request);
      return (answers.map ?? (async (r) => ({ ok: true, value: mapFact({}, r.repoId) })))(request);
    },
  };
  const impact: ImpactQueries = {
    ofChange: (request) => {
      calls.ofChange.push(request);
      return (answers.ofChange ?? (async (r) => ({ ok: true, value: forRepo(impactFact(), r.repoId) })))(request);
    },
    callers: (request) => {
      calls.callers.push(request);
      return (answers.callers ?? (async (r) => ({ ok: true, value: forRepo(impactFact(), r.repoId) })))(request);
    },
    importers: (request) => {
      calls.importers.push(request);
      return (answers.importers ?? (async (r) => ({ ok: true, value: forRepo({ ...base(), status: "complete", value: IMPORTERS }, r.repoId) })))(request);
    },
  };
  const workspace = {
    outwardNames: async (request: WorkspaceRequest) => {
      calls.workspaceReads.push(request);
      return (answers.outwardNames ?? (async () => ({ ok: true, value: read({ ...base({ snapshot: { ...base().snapshot, repo: request.repo.id! } }), status: "complete", value: { workspace: { repos: [], gateways: [], source: "none" }, repositorySnapshots: [], sections: {}, candidates: [], unserved: [], repositories: [{ repo: "shop", snapshot: base().snapshot, entrypoints: [], callSites: [] }] } }) })))(request);
    },
  } as unknown as WorkspaceQueries;
  const workspaceImpact: WorkspaceImpactQueries = {
    callers: async (request) => {
      calls.workspaceCallers.push(request);
      return (answers.workspaceCallers ?? (async (r) => ({ ok: true as const, value: read(forRepo(workspaceImpactFact(), r.repo.id!)) })))(request);
    },
    ofChange: async (request) => {
      calls.workspaceOfChange.push(request);
      return (answers.workspaceOfChange ?? (async (r) => ({ ok: true as const, value: read(forRepo(workspaceImpactFact(), r.repo.id!)) })))(request);
    },
  };
  const outline: OutlineQueries = {
    outline: (request) => {
      calls.outline.push(request);
      return (answers.outline ?? (async (r) => ({ ok: true, value: forRepo({ ...base(), status: "complete", value: OUTLINE }, r.repoId) })))(request);
    },
  };
  const decisions: DecisionQueries = {
    decisions: (request) => {
      calls.decisions.push(request);
      return (answers.decisions ?? (async (r) => ({ ok: true, value: read(forRepo(decisionFact(), r.repo.id!)) })))(request);
    },
  };
  const server = createMcpServer({ version: "0.0.0", entrypoints, impact, outline, workspace, workspaceImpact, decisions, digest: { of: (value) => createHash("sha256").update(value).digest("hex") }, redaction, repository, ...(repositories === undefined ? {} : { repositories }) });
  return { session: await openSession(server), calls };
}

const textOf = (result: { content: { text: string }[] }): string => result.content.map((block) => block.text).join("\n");

test("entrypoint evidence selection returns the selected finding's evidence through MCP", async () => {
  const { session, calls } = await setup();
  try {
    const result = await session.callTool("ye_ast_entrypoints", {
      mode: "full",
      select: { kind: "entrypoint-evidence", findingIndex: 0 },
      page: { limit: 1 },
    });
    assert.equal(result.isError, undefined);
    const projection = result.structuredContent as { kind: string; items: unknown[]; page: { total: number } };
    assert.equal(projection.kind, "projection");
    assert.deepEqual(projection.items, [{ evidenceIndex: 0, evidence: { path: "src/OrderController.java", line: 17 } }]);
    assert.equal(projection.page.total, 1);
    assert.equal(calls.map.length, 1);
  } finally {
    await session.close();
  }
});

test("entrypoints exposes a pinned recovery recipe across response modes", async () => {
  const { session } = await setup();
  try {
    const results = await Promise.all((["summary", "details", "full"] as const).map((mode) => session.callTool("ye_ast_entrypoints", { mode })));
    const recovery = results.map((result) => (result.structuredContent as Record<string, unknown>).recovery);
    assert.deepEqual(recovery[0], {
      version: 1,
      status: "available",
      resultIdentity: (recovery[0] as { resultIdentity: string } | undefined)?.resultIdentity,
      query: { name: "ye_ast_entrypoints", arguments: { repo: "shop", revision: "a".repeat(40) } },
    });
    assert.match((recovery[0] as { resultIdentity: string }).resultIdentity, /^mcp-r1:[0-9a-f]{64}$/);
    assert.deepEqual(recovery[1], recovery[0]);
    assert.deepEqual(recovery[2], recovery[0]);
    const recipe = (recovery[0] as { query: { name: string; arguments: unknown } }).query;
    const replay = await session.callTool(recipe.name, recipe.arguments);
    assert.deepEqual((replay.structuredContent as Record<string, unknown>).recovery, recovery[0]);
  } finally {
    await session.close();
  }
});

test("entrypoint recovery preserves opaque declared repository IDs", async () => {
  const bindings = [{ path: "/clones/project", repoId: "/opaque/id" }, { path: "/clones/proto", repoId: "__proto__" }, { path: "/clones/constructor", repoId: "constructor" }];
  const { session, calls } = await setup({}, undefined, bindings);
  try {
    for (const [index, binding] of bindings.entries()) {
      const result = await session.callTool("ye_ast_entrypoints", { repo: binding.repoId, revision: "release" });
      const recovery = (result.structuredContent as { recovery: { status: string; query: { arguments: unknown } } }).recovery;
      assert.equal(recovery.status, "available");
      assert.deepEqual(recovery.query.arguments, { repo: binding.repoId, revision: "a".repeat(40) });
      assert.equal(calls.map[index]?.repo, binding.path);
      assert.equal(calls.map[index]?.revision, "release");
    }
  } finally { await session.close(); }
});

test("entrypoint recovery identity covers the complete source and recorded inputs", async () => {
  const first = { status: "complete" as const, value: ROUTE, evidence: [{ path: "src/A.java", line: 1 }] };
  const second = { status: "complete" as const, value: { ...ROUTE, name: "other" }, evidence: [{ path: "src/B.java", line: 2 }] };
  const section = { ...base(), status: "complete" as const, value: [first, second] };
  const original: EntrypointMapFact = { ...base(), status: "complete", value: { entrypoints: section } };
  let current: EntrypointMapFact = original;
  const { session } = await setup({ map: async () => ({ ok: true, value: current }) });
  const identity = async () => {
    const result = await session.callTool("ye_ast_entrypoints", {});
    const recovery = (result.structuredContent as { recovery: { status: string; resultIdentity: string } }).recovery;
    assert.equal(recovery.status, "available");
    return recovery.resultIdentity;
  };
  try {
    const baseline = await identity();
    const variants: [string, EntrypointMapFact][] = [
      ["schema", { ...original, schema: "9.0.0" }],
      ["producer", { ...original, producer: { ...original.producer, version: "9" } }],
      ["inputs", { ...original, inputs: { ...original.inputs, content: "different" } }],
      ["config", { ...original, inputs: { ...original.inputs, declaredConfig: { exportBudget: { maxEntries: 7, maxBytes: 8 } } } }],
      ["engine", { ...original, inputs: { ...original.inputs, engines: { parser: "2" } } }],
      ["scope", { ...original, inputs: { ...original.inputs, declaredScope: { ...original.inputs.declaredScope, include: ["src/**"] } } }],
      ["evidence", { ...original, evidence: [{ path: "src/top.java", line: 3 }] }],
      ["nested value", { ...original, value: { entrypoints: { ...section, value: [{ ...first, value: { ...ROUTE, name: "different" } }, second] } } }],
      ["nested evidence", { ...original, value: { entrypoints: { ...section, value: [{ ...first, evidence: [{ path: "src/A.java", line: 9 }] }, second] } } }],
      ["finding order", { ...original, value: { entrypoints: { ...section, value: [second, first] } } }],
      ["status", { ...original, status: "partial", cuts: [{ kind: "section", at: ["entrypoints"] }] }],
      ["nested unknown", { ...original, value: { entrypoints: { ...section, value: [{ status: "unknown", reason: "unresolved", evidence: first.evidence }, second] } } }],
    ];
    for (const [label, variant] of variants) {
      current = variant;
      assert.notEqual(await identity(), baseline, label);
    }
    current = variants.at(-1)![1];
    const unknown = await identity();
    current = { ...original, value: { entrypoints: { ...section, value: [{ status: "unknown", reason: "no-extractor", evidence: first.evidence }, second] } } };
    assert.notEqual(await identity(), unknown, "unknown reason");
  } finally { await session.close(); }
});

test("entrypoint recovery ignores reference labels and clone location while pinning the selected foreign snapshot", async () => {
  const selected = "foreign";
  const one = await setup({}, undefined, [{ repoId: selected, path: "/clones/one" }]);
  const two = await setup({}, undefined, [{ repoId: selected, path: "/clones/two" }]);
  try {
    const a = await one.session.callTool("ye_ast_entrypoints", { repo: selected, revision: "main", mode: "summary" });
    const b = await two.session.callTool("ye_ast_entrypoints", { repo: selected, revision: "release", mode: "full" });
    const recovery = (a.structuredContent as { recovery: { query: { arguments: unknown } } }).recovery;
    assert.deepEqual((b.structuredContent as { recovery: unknown }).recovery, recovery);
    assert.deepEqual(recovery.query.arguments, { repo: selected, revision: "a".repeat(40) });
    assert.equal(one.calls.map[0]?.repo, "/clones/one");
    assert.equal(two.calls.map[0]?.repo, "/clones/two");
    assert.equal(one.calls.map[0]?.revision, "main");
    assert.equal(two.calls.map[0]?.revision, "release");
    assert.doesNotMatch(JSON.stringify(recovery), /\/clones\//);
  } finally { await one.session.close(); await two.session.close(); }
});

test("entrypoint recovery uses recorded normalized scope in a replayable recipe", async () => {
  const scoped = mapFact({ inputs: { ...base().inputs, declaredScope: { ...base().inputs.declaredScope, include: ["src/**", "web/**"], exclude: ["src/test/**"] } } });
  const { session, calls } = await setup({ map: async () => ({ ok: true, value: scoped }) });
  try {
    const response = await session.callTool("ye_ast_entrypoints", { scope: { include: ["web/**", "src/**"], exclude: ["src/test/**"] }, mode: "details" });
    const recovery = (response.structuredContent as { recovery: { query: { name: string; arguments: unknown } } }).recovery;
    assert.deepEqual(recovery.query.arguments, { repo: "shop", revision: "a".repeat(40), scope: { include: ["src/**", "web/**"], exclude: ["src/test/**"] } });
    assert.equal(textOf(response).includes(JSON.stringify(recovery)), false);
    assert.match(textOf(response), /structuredContent\.recovery/);
    const replay = await session.callTool(recovery.query.name, recovery.query.arguments);
    assert.deepEqual((replay.structuredContent as { recovery: unknown }).recovery, recovery);
    assert.deepEqual(calls.map[1]?.scope, { include: ["src/**", "web/**"], exclude: ["src/test/**"] });
  } finally { await session.close(); }
});

test("entrypoint recovery handles nested deadlines, unknown findings and unresolved snapshots", async () => {
  const nested = (reason: "deadline" | "unresolved"): EntrypointMapFact => ({
    ...base(), status: "complete", value: { entrypoints: { ...base(), status: "complete", value: [{ status: "unknown", reason, evidence: [] }] } },
  });
  const cut: EntrypointMapFact = {
    ...base(), status: "partial", cuts: [{ kind: "section", at: ["entrypoints"] }],
    value: { entrypoints: { ...base(), status: "partial", cuts: [{ kind: "deadline", at: ["src/A.java"] }], value: [] } },
  };
  let current = nested("deadline");
  const { session } = await setup({ map: async () => ({ ok: true, value: current }) });
  try {
    for (const fact of [current, cut]) {
      current = fact;
      const response = await session.callTool("ye_ast_entrypoints", {});
      assert.deepEqual((response.structuredContent as { recovery: unknown }).recovery, { version: 1, status: "unavailable", reason: "deadline" });
    }
    current = nested("unresolved");
    const unknown = await session.callTool("ye_ast_entrypoints", {});
    assert.equal((unknown.structuredContent as { recovery: { status: string } }).recovery.status, "available");
    for (const sha of ["main", ""]) {
      current = mapFact({ snapshot: { repo: "shop", kind: "sha", sha } });
      const missingPin = await session.callTool("ye_ast_entrypoints", {});
      assert.deepEqual((missingPin.structuredContent as { recovery: unknown }).recovery, { version: 1, status: "unavailable", reason: "unresolved-context" });
    }
  } finally { await session.close(); }
});

test("entrypoint recovery refuses redacted semantic IDs and scopes without leaking them", async () => {
  const scopeFact = mapFact({ inputs: { ...base().inputs, declaredScope: { ...base().inputs.declaredScope, include: [`src/${SECRET}/**`] } } });
  const scoped = await setup({ map: async () => ({ ok: true, value: scopeFact }) });
  const selected = await setup({}, undefined, [{ path: "/clones/private", repoId: SECRET }]);
  try {
    for (const mode of ["summary", "details", "full"] as const) {
      for (const result of [
        await scoped.session.callTool("ye_ast_entrypoints", { scope: { include: [`src/${SECRET}/**`] }, mode }),
        await selected.session.callTool("ye_ast_entrypoints", { repo: SECRET, mode }),
      ]) {
        assert.equal(result.isError, undefined);
        assert.deepEqual((result.structuredContent as { recovery: unknown }).recovery, { version: 1, status: "unavailable", reason: "redacted-context" });
        assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
      }
    }
  } finally { await scoped.session.close(); await selected.session.close(); }
});

test("live entrypoint recovery tracks its snapshot but ignores stale notices", async () => {
  let snapshot = { repo: "shop", kind: "live" as const, head: "a".repeat(40), stateId: "state-1" };
  let stale = false;
  const { session } = await setup({ map: async (request) => {
    if (stale && request.live) request.onStale?.({ stateId: "moved", changed: ["src/A.java"] });
    return { ok: true, value: mapFact({ snapshot }) };
  } });
  try {
    const call = async () => (await session.callTool("ye_ast_entrypoints", { live: true })).structuredContent as { recovery: { resultIdentity: string; query: { arguments: unknown } } };
    const initial = await call();
    assert.deepEqual(initial.recovery.query.arguments, { repo: "shop", live: true });
    stale = true;
    assert.deepEqual((await call()).recovery, initial.recovery);
    snapshot = { ...snapshot, stateId: "state-2" };
    assert.notEqual((await call()).recovery.resultIdentity, initial.recovery.resultIdentity);
    snapshot = { ...snapshot, stateId: "state-1", head: "b".repeat(40) };
    assert.notEqual((await call()).recovery.resultIdentity, initial.recovery.resultIdentity);
  } finally { await session.close(); }
});

test("entrypoint recovery schema rejects malformed variants in runtime and full JSON Schema", async () => {
  const { session } = await setup();
  try {
    const advertised = (await session.listTools()).find((tool) => tool.name === "ye_ast_entrypoints")!.outputSchema!;
    const validate = new AjvJsonSchemaValidator().getValidator(ENTRYPOINTS_OUTPUT['~standard'].jsonSchema.output({target:'draft-07'}));
    const receipt = (await session.callTool("ye_ast_entrypoints", {})).structuredContent as Record<string, unknown>;
    const recovery = receipt.recovery as Record<string, unknown>;
    const query = recovery.query as Record<string, unknown>;
    const args = query.arguments as Record<string, unknown>;
    const cases: [unknown, boolean][] = [
      [receipt, true],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, scope: { include: ["src/**/*.ts"] } } } } }, true],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, revision: "A".repeat(40), scope: { exclude: ["test/**", "src/*.ts"] } } } } }, true],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, revision: "f".repeat(64) } } } }, true],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { repo: "shop", live: true } } } }, true],
      [{ ...receipt, recovery: { version: 1, status: "unavailable", reason: "deadline" } }, true],
      [{ ...receipt, recovery: undefined }, false],
      [{ ...receipt, recovery: { ...recovery, version: 2 } }, false],
      [{ ...receipt, recovery: { ...recovery, resultIdentity: "bad" } }, false],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, name: "ye_ast_impact" } } }, false],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, revision: "HEAD" } } } }, false],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, mode: "full" } } } }, false],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, live: true } } } }, false],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, revision: "g".repeat(40) } } } }, false],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, scope: { include: ["../secret"] } } } } }, false],
      [{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, scope: { include: ["src//bad"] } } } } }, false],
      [{ ...receipt, recovery: { version: 1, status: "unavailable", reason: "deadline", query } }, false],
      [{ ...receipt, recovery: { version: 1, status: "unavailable", reason: "other" } }, false],
      [{ ...receipt, recovery: { version: 1, status: "available", resultIdentity: recovery.resultIdentity } }, false],
      [{ ...receipt, value: {} }, false],
    ];
    for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
      for (const [glob, valid] of [
        [`ok${separator}foo/../secret`, false],
        [`ok${separator}foo//secret`, false],
        [`ok${separator}foo/.`, false],
        [`ok${separator}foo/..`, false],
        [`ok${separator}foo/file.ts`, true],
        [`src/.${separator}`, true],
        [`src/..${separator}`, true],
      ] as const) {
        cases.push([{ ...receipt, recovery: { ...recovery, query: { ...query, arguments: { ...args, scope: { include: [glob] } } } } }, valid]);
      }
    }
    for (const [value, valid] of cases) {
      assert.equal(ENTRYPOINTS_OUTPUT.safeParse(value).success, valid, JSON.stringify(value));
      assert.equal(validate(value).valid, valid, JSON.stringify(value));
    }
  } finally { await session.close(); }
});

/** Text modes expose only a receipt; unknown results include their reason. */
function envelopeOf(fact: Fact<unknown>, mode: "summary" | "details" = "summary"): Record<string, unknown> {
  return { mode, status: fact.status, snapshot: fact.snapshot, ...(fact.status === "unknown" ? { reason: fact.reason } : {}) };
}

function withoutRecovery(value: unknown): Record<string, unknown> {
  const { recovery, ...rest } = value as Record<string, unknown>;
  assert.ok(recovery);
  return rest;
}

const TOOL_CALLS: [string, Record<string, unknown>][] = [
  ["ye_ast_entrypoints", {}],
  ["ye_ast_impact", { base: "main" }],
  ["ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.f" }] }],
  ["ye_ast_importers", { files: ["src/a.ts"] }],
  ["ye_ast_outline", { files: ["src/Order.java"] }],
  ["ye_ast_workspace", {}],
  ["ye_ast_decisions", {}],
];

test("every tool delivers mode receipts and a full fact", async () => {
  const { session } = await setup();
  try {
    for (const [name, args] of TOOL_CALLS) {
      for (const mode of ["summary", "details"] as const) {
        const result = await session.callTool(name, { ...args, mode });
        assert.notEqual(result.isError, true, name);
        const receipt = result.structuredContent as Record<string, unknown>;
        assert.equal(receipt["mode"], mode, name);
        assert.deepEqual(Object.keys(receipt).toSorted(), ["ye_ast_entrypoints", "ye_ast_callers", "ye_ast_impact"].includes(name) ? ["mode", "recovery", "snapshot", "status"] : ["mode", "snapshot", "status"], name);
        assert.ok(textOf(result).startsWith(`status: ${receipt["status"]}`), name);
        assert.ok(textOf(result).includes("snapshot:"), name);
        if (!["ye_ast_entrypoints", "ye_ast_callers", "ye_ast_impact"].includes(name)) {
          assert.equal("recovery" in receipt, false, name);
          assert.ok(!textOf(result).includes("lookup example:"), name);
        }
      }
      assert.deepEqual(await session.callTool(name, args), await session.callTool(name, { ...args, mode: "summary" }), name);
      const whole = await session.callTool(name, { ...args, mode: "full" });
      const full = whole.structuredContent as Record<string, unknown>;
      assert.equal(full["mode"], "full", name);
      assert.equal("value" in full, true, name);
      assert.ok(textOf(whole).startsWith(`status: ${full["status"]}\nfull structured result: structuredContent\n`), name);
    }
  } finally {
    await session.close();
  }
});

test("workspace repository roots accompany the answer without entering the fact", async () => {
  const repositoryRoots = [{ repo: "shop", path: REPOSITORY.path }, { repo: "shop-web", path: "/clones/frontend" }];
  const fact = workspaceFact();
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact, repositoryRoots } }) });

  for (const mode of ["summary", "details", "full"] as const) {
    const result = await session.callTool("ye_ast_workspace", { mode });
    const structured = result.structuredContent as Record<string, unknown>;
    if (mode === "full") {
      assert.deepEqual(structured["repositoryRoots"], repositoryRoots);
      assert.match(textOf(result), /repositoryRoots\[\]\.repo/);
      if (fact.status === "unknown") throw new Error("expected workspace value");
      const { repositories: _repositories, ...value } = fact.value;
      const { mode: deliveredMode, repositoryRoots: _roots, ...delivered } = structured;
      assert.equal(deliveredMode, "full");
      assert.deepEqual(delivered, { ...fact, value });
    } else {
      assert.deepEqual(structured, envelopeOf(fact, mode));
      assert.equal("repositoryRoots" in structured, false);
      assert.match(textOf(result), /repository root: shop-web -> \/clones\/frontend/);
    }
    assert.equal(JSON.stringify(structured["inputs"])?.includes("/clones/frontend") ?? false, false);
    assert.equal(JSON.stringify(structured["value"])?.includes("/clones/frontend") ?? false, false);
  }
  await session.close();
  const plain = await setup();
  try {
    const result = await plain.session.callTool("ye_ast_workspace", { mode: "full" });
    assert.equal("repositoryRoots" in (result.structuredContent as Record<string, unknown>), false);
    assert.doesNotMatch(textOf(result), /Repository locations:/);
  } finally { await plain.session.close(); }
});

test("full preserves the partial fact and presentation does not enter the query", async () => {
  const cuts = [{ kind: "depth", at: ["src/A.java::f"], limit: 1 }] as const;
  const partial = impactFact({ status: "partial", cuts } as Partial<Fact<ImpactValue>>);
  const { session, calls } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
  try {
    const whole = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
    assert.notEqual(whole.isError, true);
    const { mode, repositoryRoots, recovery: _recovery, ...fact } = whole.structuredContent as Record<string, unknown>;
    assert.deepEqual(repositoryRoots, [{ repo: "shop", path: REPOSITORY.path }]);
    assert.equal(mode, "full");
    assert.deepEqual(fact, JSON.parse(JSON.stringify(partial)));
    assert.ok(textOf(whole).startsWith("status: partial\nfull structured result: structuredContent\n"));
    await session.callTool("ye_ast_impact", { base: "main", mode: "details" });
    assert.deepEqual(calls.ofChange[0], calls.ofChange[1]);
    assert.equal("mode" in (calls.ofChange[0] ?? {}), false);
  } finally {
    await session.close();
  }
});

test("the outline lists each declaration with its span and the files it imports, and a file it cannot tell is a cut", async () => {
  const { session } = await setup({
    outline: async (request) => ({
      ok: true,
      value: {
        ...base(),
        status: "partial",
        value: OUTLINE,
        cuts: [{ kind: "not-exported", at: ["src/Gone.swift"] }],
        inputs: { ...base().inputs, declaredConfig: { files: request.files } },
      } as Fact<OutlineValue>,
    }),
  });
  const text = textOf(await session.callTool("ye_ast_outline", { files: ["src/Order.java", "src/Empty.java", "src/Gone.swift"] }));

  assert.match(text, /^ {2}src\/Order\.java$/m);
  assert.match(text, /^ {4}3-40 Order \[class\]$/m);
  assert.match(text, /^ {4}20-24 total \[method\]$/m);
  assert.match(text, /^ {4}imports: src\/Money\.java$/m);
  assert.match(text, /^ {2}src\/Empty\.java\n {4}declares nothing$/m);
  assert.match(text, /not-exported \(1\): src\/Gone\.swift/);
  await session.close();
});

test("lists seven read tools with an optional repository selector", async () => {
  const { session } = await setup();
  const tools = await session.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ye_ast_callers", "ye_ast_decisions", "ye_ast_entrypoints", "ye_ast_impact", "ye_ast_importers", "ye_ast_outline", "ye_ast_workspace"]);
  for (const tool of tools) {
    assert.ok((tool.description ?? "").length > 0, tool.name);
    assert.ok(tool.inputSchema.properties?.["repo"], tool.name);
    for (const forbidden of ["repoId", "path", "repository"]) assert.equal(tool.inputSchema.properties?.[forbidden], undefined, `${tool.name}.${forbidden}`);
  }
  const required = (name: string): readonly string[] => tools.find((tool) => tool.name === name)?.inputSchema.required ?? [];
  assert.deepEqual(required("ye_ast_impact"), ["base"]);
  assert.deepEqual(required("ye_ast_importers"), ["files"]);
  assert.deepEqual(required("ye_ast_outline"), ["files"]);
  assert.deepEqual(required("ye_ast_callers"), ["targets"]);
  assert.deepEqual(required("ye_ast_entrypoints"), []);
  assert.deepEqual(required("ye_ast_workspace"), []);
  assert.deepEqual(required("ye_ast_decisions"), []);
  for (const name of ["ye_ast_workspace", "ye_ast_decisions"]) {
    const repos = tools.find((tool) => tool.name === name)?.inputSchema.properties?.["repos"] as { items?: { properties?: Record<string, unknown> } } | undefined;
    assert.ok(repos?.items?.properties?.["path"] !== undefined, `a passed repository is named by a nested path, in ${name}`);
    assert.equal(repos?.items?.properties?.["remote"], undefined, `a query cannot declare a refresh destination, in ${name}`);
  }
  await session.close();
});

test("the server instructions tell the agent when to call every tool", async () => {
  const { session } = await setup();
  const tools = await session.listTools();
  for (const tool of tools) assert.ok(session.instructions?.includes(tool.name), tool.name);
  assert.match(session.instructions ?? "", /Summary\/details:[^\n]*content[^\n]*structuredContent[^\n]*status[^\n]*snapshot/);
  assert.match(session.instructions ?? "", /Full:[^\n]*structuredContent[^\n]*complete data[^\n]*content[^\n]*navigation/);
  assert.match(session.instructions ?? "", /Recovery[^\n]*structuredContent\.recovery/);
  await session.close();
});

test("input guides leave live combination exclusions to runtime validation", async () => {
  const { session, calls } = await setup();
  try {
    const tools = await session.listTools();
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["ye_ast_impact", { base: "main" }, ["head"]],
      ["ye_ast_callers", { targets: [{ file: "a", symbol: "f" }] }, ["revision"]],
      ["ye_ast_entrypoints", {}, ["revision"]],
      ["ye_ast_importers", { files: ["a"] }, ["revision"]],
      ["ye_ast_outline", { files: ["a"] }, ["revision"]],
    ];
    for (const [name, args, fields] of cases) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      assert.ok(schema, name);
      const validate = new AjvJsonSchemaValidator().getValidator(schema);
      for (const field of fields) {
        const value = field === "offline" ? false : field === "workspace" ? {} : "main";
        assert.equal(validate({ ...args, live: true, [field]: value }).valid, true, name);
        assert.equal(validate({ ...args, live: false, [field]: value }).valid, true, name);
        const result = await session.callTool(name, { ...args, live: true, [field]: value });
        assert.equal(result.isError, true, `${name}: live excludes the presence of ${field}`);
      }
      assert.equal(validate({ ...args, live: true }).valid, true, name);
      assert.equal(validate(args).valid, true, name);
    }
    assert.equal(calls.ofChange.length + calls.callers.length + calls.map.length + calls.importers.length + calls.outline.length + calls.workspaceOfChange.length + calls.workspaceCallers.length, 0);
    const allowed = await session.callTool("ye_ast_impact", { base: "main", live: false, head: "feature", offline: false });
    assert.notEqual(allowed.isError, true);
    assert.equal(calls.ofChange[0]?.head, "feature");
  } finally {
    await session.close();
  }
});

test("the server instructions name the bound repository root", async () => {
  const { session } = await setup();
  assert.ok(session.instructions?.includes(`${REPOSITORY.path} (id ${REPOSITORY.repoId})`), session.instructions);
  await session.close();
});

test("a workspace answer says where its repositories came from, so one repository is never read as all of them", async () => {
  const { session } = await setup();
  const text = textOf(await session.callTool("ye_ast_workspace", {}));
  assert.match(text, /^repositories declared by: nothing: this answer covers the bound repository alone/m);
  await session.close();
});

test("workspace membership advice uses the publishing tool's accepted argument shape", async () => {
  const recorded = workspaceImpactFact();
  if (recorded.status === "unknown") throw new Error("expected workspace impact value");
  const noMembers = { ...recorded, value: { ...recorded.value, workspace: { ...recorded.value.workspace, source: "none" as const } } };
  const { session } = await setup({
    decisions: async () => ({ ok: true, value: { fact: decisionFact({ ...DECISIONS, source: "none" }) } }),
    workspaceOfChange: async () => ({ ok: true, value: { fact: noMembers } }),
    workspaceCallers: async () => ({ ok: true, value: { fact: noMembers } }),
  });
  try {
    const tools = await session.listTools();
    const cases = [
      { name: "ye_ast_workspace", args: {} },
      { name: "ye_ast_decisions", args: {} },
      { name: "ye_ast_impact", args: { base: "main", workspace: {} } },
      { name: "ye_ast_callers", args: { targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }], workspace: {} } },
    ];
    for (const { name, args } of cases) {
      const validate = new AjvJsonSchemaValidator().getValidator(tools.find(tool => tool.name === name)!.inputSchema);
      for (const mode of ["summary", "details"] as const) {
        const response = await session.callTool(name, { ...args, mode });
        assert.notEqual(response.isError, true, name);
        const parameter = textOf(response).match(/\(pass ([a-z.]+),/)?.[1];
        assert.ok(parameter, name);
        const declared = [{ path: "/work/shop-web", id: "shop-web" }];
        const fields = parameter.split(".");
        let suggested: Record<string, unknown> = { [fields.pop()!]: declared };
        for (const field of fields.toReversed()) suggested = { [field]: suggested };
        assert.equal(validate({ ...args, ...suggested, mode }).valid, true, `${name}: ${parameter}`);
      }
    }
  } finally { await session.close(); }
});

test("cut lookup categories share context while every coordinate reconstructs a usable selector", async () => {
  const cut = (index: number): Cut => ({
    kind: "unresolved-link",
    at: [`src/consumer-${index}.ts::load`, `src/consumer-${index}.ts:${index + 3} unresolved`],
  });
  const cuts: [Cut, ...Cut[]] = [cut(0), ...Array.from({ length: 11 }, (_, index) => cut(index + 1))];
  const fact = impactFact({ status: "partial", cuts, inputs: { ...base().inputs, declaredConfig: { targets: ["src/OrderService.java:OrderService.find"] } } });
  const { session } = await setup({
    callers: async () => ({ ok: true, value: fact }),
    ofChange: async () => ({ ok: true, value: fact }),
  });
  try {
    const tools = await session.listTools();
    for (const { name, args } of [
      { name: "ye_ast_callers", args: { targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }] } },
      { name: "ye_ast_impact", args: { base: "main" } },
    ]) {
      const response = await session.callTool(name, { ...args, mode: "details" });
      assert.notEqual(response.isError, true);
      const text = textOf(response);
      assert.equal(text.split('"kind":"cut-places"').length - 1, 1);
      const example = text.match(/Cut lookup:.*select example: (\{[^\n]+\})/)?.[1];
      assert.ok(example, name);
      const context = JSON.parse(example) as Record<string, unknown>;
      const selectors = [...text.matchAll(/^\s+cut: (\{"cutIndex":\d+\})/gm)].map(match => ({ ...context, ...JSON.parse(match[1]!) }));
      assert.deepEqual(selectors, cuts.map((_, cutIndex) => ({ kind: "cut-places", owner: { kind: "fact" }, cutIndex })));
      const schema = new AjvJsonSchemaValidator().getValidator(tools.find(tool => tool.name === name)!.inputSchema);
      for (const select of selectors) assert.equal(schema({ ...args, select, page: { limit: 1 }, mode: "full" }).valid, true);
      const selected = await session.callTool(name, { ...args, select: selectors.at(-1), page: { limit: 1 }, mode: "full" });
      assert.notEqual(selected.isError, true);
      assert.deepEqual((selected.structuredContent as { items: unknown[] }).items, [{ atIndex: 1, place: cuts.at(-1)!.at[1] }]);
    }
  } finally { await session.close(); }
});

test("output schemas validate real receipts and family payloads and reject broken required fields", async () => {
  const { session } = await setup();
  const schemas = [ENTRYPOINTS_OUTPUT, IMPACT_OUTPUT, CALLERS_OUTPUT, IMPORTERS_OUTPUT, OUTLINE_OUTPUT, WORKSPACE_OUTPUT, DECISIONS_OUTPUT];
  const fields = ["entrypoints", "seeds", "seeds", "files", "files", "sections", "decisions"];
  try {
    const tools = await session.listTools();
    assert.deepEqual(TOOL_CALLS.map(([name]) => name).toSorted(), tools.map(({ name }) => name).toSorted());
    for (const [index, [name, args]] of TOOL_CALLS.entries()) {
      const advertised = tools.find((tool) => tool.name === name)?.outputSchema;
      assert.ok(advertised, name);
      assert.equal(advertised.type, "object", name);
      const validate = new AjvJsonSchemaValidator().getValidator(schemas[index]!['~standard'].jsonSchema.output({target:'draft-07'}));
      const runtime = schemas[index]!;
      const check = (payload: unknown, valid: boolean) => {
        assert.equal(runtime.safeParse(payload).success, valid, `${name}: runtime`);
        assert.equal(validate(payload).valid, valid, `${name}: advertised`);
      };
      const receipt = (await session.callTool(name, args)).structuredContent as Record<string, unknown>;
      const full = (await session.callTool(name, { ...args, mode: "full" })).structuredContent as Record<string, unknown>;
      assert.equal(new AjvJsonSchemaValidator().getValidator(advertised)(receipt).valid, true);
      assert.equal(new AjvJsonSchemaValidator().getValidator(advertised)(full).valid, true);
      check(receipt, true);
      check(full, true);
      check({ ...receipt, reason: "unexpected" }, false);
      const withoutSha = structuredClone(receipt) as { snapshot: { sha?: string } };
      delete withoutSha.snapshot.sha;
      check(withoutSha, false);
      const withoutCollection = structuredClone(full) as { value: Record<string, unknown> };
      delete withoutCollection.value[fields[index]!];
      check(withoutCollection, false);
    }
  } finally { await session.close(); }
});

test("runtime and full JSON impact schemas preserve unknown, partial and live identity", async () => {
  const unknown: Fact<ImpactValue> = { ...base(), status: "unknown", reason: "index-unavailable" };
  const partial = impactFact({ status: "partial", cuts: [{ kind: "depth", at: ["src/a.ts::f"], limit: 1 }] } as Partial<Fact<ImpactValue>>);
  for (const fact of [unknown, partial]) {
    const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
    try {
      const schema = (await session.listTools()).find((tool) => tool.name === "ye_ast_impact")!.outputSchema!;
      const validate = new AjvJsonSchemaValidator().getValidator(IMPACT_OUTPUT['~standard'].jsonSchema.output({target:'draft-07'}));
      const check = (value: unknown, expected: boolean) => {
        assert.equal(IMPACT_OUTPUT.safeParse(value).success, expected, "runtime");
        assert.equal(validate(value).valid, expected, "advertised");
      };
      const receipt = (await session.callTool("ye_ast_impact", { base: "main" })).structuredContent as Record<string, unknown>;
      const full = (await session.callTool("ye_ast_impact", { base: "main", mode: "full" })).structuredContent as Record<string, unknown>;
      check(receipt, true); check(full, true);
      if (fact.status === "unknown") {
        const withoutReason = { ...receipt }; delete withoutReason.reason; check(withoutReason, false);
        const badFull = { ...full }; delete badFull.reason; check(badFull, false);
        check({ ...full, value: {} }, false);
      } else {
        const withoutCuts = { ...full }; delete withoutCuts.cuts; check(withoutCuts, false);
      }
      const live = { ...receipt, snapshot: { repo: "shop", kind: "live", head: "abc", stateId: "state" } };
      check(live, true);
      check({ ...live, snapshot: { repo: "shop", kind: "live", head: "abc" } }, false);
      check({ ...live, snapshot: { repo: "shop", kind: "live", stateId: "state" } }, false);
    } finally { await session.close(); }
  }
});

test("workspace impact full accepts nested unknowns and rejects incomplete contributing provenance", async () => {
  const original = workspaceImpactFact();
  assert.notEqual(original.status, "unknown");
  if (original.status === "unknown") return;
  const value = { ...original.value, sections: {
    ...original.value.sections,
    missing: { ...base(), status: "unknown" as const, reason: "index-unavailable" as const },
    shop: { ...base(), status: "complete" as const, value: { reads: [{ kind: "trigger" as const, fact: { ...base(), status: "unknown" as const, reason: "index-unavailable" as const } }], callSites: [], unmatched: [], external: [] } },
  } };
  const fact: Fact<WorkspaceImpactValue> = { ...original, value };
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact } }) });
  try {
    const schema = (await session.listTools()).find((tool) => tool.name === "ye_ast_impact")!.outputSchema!;
    const validate = new AjvJsonSchemaValidator().getValidator(IMPACT_OUTPUT['~standard'].jsonSchema.output({target:'draft-07'}));
    const result = await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, mode: "full" });
    assert.notEqual(result.isError, true);
    const content = result.structuredContent as Record<string, unknown>;
    assert.equal(IMPACT_OUTPUT.safeParse(content).success, true);
    assert.equal(validate(content).valid, true);
    const missingLinks = structuredClone(content) as { value: { links?: unknown } };
    delete missingLinks.value.links;
    assert.equal(IMPACT_OUTPUT.safeParse(missingLinks).success, false);
    assert.equal(validate(missingLinks).valid, false);
    const mutated = structuredClone(content) as { value: { sections: { shop: { value: { reads: { fact: { reason?: string } }[] } } } } };
    delete mutated.value.sections.shop.value.reads[0]!.fact.reason;
    assert.equal(IMPACT_OUTPUT.safeParse(mutated).success, false);
    assert.equal(validate(mutated).valid, false);
  } finally { await session.close(); }
});

test("entrypoint full accepts an unknown nested section and finding", async () => {
  const sectionUnknown = { ...base(), status: "unknown" as const, reason: "index-unavailable" as const };
  const itemUnknown = { status: "unknown" as const, reason: "unresolved" as const, evidence: [{ path: "src/route.ts", line: 2 }] };
  const sectionKnown = { ...base(), status: "complete" as const, value: [itemUnknown] };
  for (const entrypoints of [sectionUnknown, sectionKnown]) {
    const fact = { ...base(), status: "complete" as const, value: { entrypoints } };
    const { session } = await setup({ map: async () => ({ ok: true, value: fact }) });
    try {
      const schema = (await session.listTools()).find((tool) => tool.name === "ye_ast_entrypoints")!.outputSchema!;
      const validate = new AjvJsonSchemaValidator().getValidator(schema);
      const result = await session.callTool("ye_ast_entrypoints", { mode: "full" });
      assert.notEqual(result.isError, true);
      assert.equal(ENTRYPOINTS_OUTPUT.safeParse(result.structuredContent).success, true);
      assert.equal(validate(result.structuredContent).valid, true);
    } finally { await session.close(); }
  }
});

for (const validation of ["runtime", "full JSON"] as const) {
  test(`entrypoint coordinates are required in ${validation} output schema`, async () => {
    const { session } = await setup();
    try {
      const schema = (await session.listTools()).find((tool) => tool.name === "ye_ast_entrypoints")!.outputSchema!;
      const validate = new AjvJsonSchemaValidator().getValidator(ENTRYPOINTS_OUTPUT['~standard'].jsonSchema.output({target:'draft-07'}));
      const result = await session.callTool("ye_ast_entrypoints", { mode: "full" });
      assert.notEqual(result.isError, true);
      const content = result.structuredContent as Record<string, unknown>;
      const check = (value: unknown, expected: boolean) => assert.equal(validation === "runtime" ? ENTRYPOINTS_OUTPUT.safeParse(value).success : validate(value).valid, expected);
      check(content, true);
      for (const field of ["handler", "path", "symbol", "line"] as const) {
        const broken = structuredClone(content) as { value: { entrypoints: { value: { value: { handler?: { path?: string; symbol?: string; line?: number } } }[] } } };
        const entry = broken.value.entrypoints.value[0]!.value;
        if (field === "handler") delete entry.handler;
        else delete entry.handler![field];
        check(broken, false);
      }
    } finally { await session.close(); }
  });

  test(`workspace call sites require interpretable identity and targets in ${validation} output schema`, async () => {
    const { session } = await setup();
    try {
      const schema = (await session.listTools()).find((tool) => tool.name === "ye_ast_impact")!.outputSchema!;
      const validate = new AjvJsonSchemaValidator().getValidator(IMPACT_OUTPUT['~standard'].jsonSchema.output({target:'draft-07'}));
      const result = await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, mode: "full" });
      assert.notEqual(result.isError, true);
      const content = result.structuredContent as Record<string, unknown>;
      const check = (value: unknown, expected: boolean) => assert.equal(validation === "runtime" ? IMPACT_OUTPUT.safeParse(value).success : validate(value).valid, expected);
      check(content, true);
      for (const field of ["callSites", "unmatched", "external"] as const) {
        const broken = structuredClone(content) as { value: { sections: Record<string, { value: Record<string, unknown[]> }> } };
        broken.value.sections["shop-web"]!.value[field]![0] = null;
        check(broken, false);
      }
      for (const field of ["repo", "file", "line", "symbol", "transport", "target"] as const) {
        const broken = structuredClone(content) as { value: { sections: Record<string, { value: { callSites: Record<string, unknown>[] } }> } };
        delete broken.value.sections["shop-web"]!.value.callSites[0]![field];
        check(broken, false);
      }
      for (const field of ["status", "value", "evidence"] as const) {
        const broken = structuredClone(content) as { value: { sections: Record<string, { value: { callSites: { target: Record<string, unknown> }[] } }> } };
        delete broken.value.sections["shop-web"]!.value.callSites[0]!.target[field];
        check(broken, false);
      }
      for (const field of ["method", "path"] as const) {
        const broken = structuredClone(content) as { value: { sections: Record<string, { value: { callSites: { target: { value: Record<string, unknown> } }[] } }> } };
        delete broken.value.sections["shop-web"]!.value.callSites[0]!.target.value[field];
        check(broken, false);
      }
      const brokenTransport = structuredClone(content) as { value: { sections: Record<string, { value: { callSites: { transport: string }[] } }> } };
      brokenTransport.value.sections["shop-web"]!.value.callSites[0]!.transport = "other";
      check(brokenTransport, false);
    } finally { await session.close(); }
  });
}

test("full schemas accept UI component and unknown and additive workspace target variants", async () => {
  const ui: Entrypoint[] = [
    { kind: "ui-route", name: "/one", path: "/one", component: { path: "src/page.ts", symbol: "Page", line: 5 }, guards: [] },
    { kind: "ui-route", name: "/two", path: "/two", component: "unknown", guards: [] },
  ];
  const section = { ...base(), status: "complete" as const, value: ui.map((value) => ({ status: "complete" as const, value, evidence: [] })) };
  const map: EntrypointMapFact = { ...base(), status: "complete", value: { entrypoints: section } };
  const built = workspaceImpactFact();
  assert.notEqual(built.status, "unknown");
  if (built.status === "unknown") return;
  const siteSection = built.value.sections["shop-web"]!;
  assert.notEqual(siteSection.status, "unknown");
  if (siteSection.status === "unknown") return;
  const eventSite = { ...SITE, transport: "event" as const, target: { status: "complete" as const, value: { protocol: "kafka" as const, destination: "events", role: "publish" as const }, evidence: [] }, extraSite: true };
  const unknownSite = { ...SITE, target: { status: "unknown" as const, reason: "unresolved" as const, evidence: [] }, extraSite: true };
  const workspaceFactWithVariants: Fact<WorkspaceImpactValue> = { ...built, value: { ...built.value, sections: { ...built.value.sections, "shop-web": { ...siteSection, value: { ...siteSection.value, unmatched: [eventSite], external: [unknownSite] } } } } };
  const { session } = await setup({ map: async () => ({ ok: true, value: map }), workspaceOfChange: async () => ({ ok: true, value: { fact: workspaceFactWithVariants } }) });
  try {
    const cases: [string, Record<string, unknown>, { safeParse(value: unknown): { success: boolean } }][] = [["ye_ast_entrypoints", {}, ENTRYPOINTS_OUTPUT], ["ye_ast_impact", { base: "main", workspace: WORKSPACE }, IMPACT_OUTPUT]];
    for (const [name, args, runtime] of cases) {
      const schema = (await session.listTools()).find((tool) => tool.name === name)!.outputSchema!;
      const validate = new AjvJsonSchemaValidator().getValidator((name === "ye_ast_entrypoints" ? ENTRYPOINTS_OUTPUT : IMPACT_OUTPUT)['~standard'].jsonSchema.output({target:'draft-07'}));
      const result = await session.callTool(name, { ...args, mode: "full" });
      assert.notEqual(result.isError, true, name);
      assert.equal(runtime.safeParse(result.structuredContent).success, true, name);
      assert.equal(validate(result.structuredContent).valid, true, name);
      if (name === "ye_ast_entrypoints") {
        for (const coordinate of ["path", "symbol", "line"] as const) {
          const bad = structuredClone(result.structuredContent) as { value: { entrypoints: { value: { value: { component: Record<string, unknown> } }[] } } };
          delete bad.value.entrypoints.value[0]!.value.component[coordinate];
          assert.equal(runtime.safeParse(bad).success, false, coordinate);
          assert.equal(validate(bad).valid, false, coordinate);
        }
        const missingComponent = structuredClone(result.structuredContent) as { value: { entrypoints: { value: { value: { component?: unknown } }[] } } };
        delete missingComponent.value.entrypoints.value[0]!.value.component;
        assert.equal(runtime.safeParse(missingComponent).success, false, "UI component");
        assert.equal(validate(missingComponent).valid, false, "UI component");
      } else {
        const badEvent = structuredClone(result.structuredContent) as { value: { sections: Record<string, { value: { unmatched: { target: { value: { destination?: string } } }[]; external: { target: { reason?: string } }[] } }> } };
        delete badEvent.value.sections["shop-web"]!.value.unmatched[0]!.target.value.destination;
        assert.equal(runtime.safeParse(badEvent).success, false, "event destination");
        assert.equal(validate(badEvent).valid, false, "event destination");
        const badUnknown = structuredClone(result.structuredContent) as typeof badEvent;
        delete badUnknown.value.sections["shop-web"]!.value.external[0]!.target.reason;
        assert.equal(runtime.safeParse(badUnknown).success, false, "unknown reason");
        assert.equal(validate(badUnknown).valid, false, "unknown reason");
        const unknownWithValue = structuredClone(result.structuredContent) as { value: { sections: Record<string, { value: { external: { target: Record<string, unknown> }[] } }> } };
        unknownWithValue.value.sections["shop-web"]!.value.external[0]!.target.value = { method: "GET", path: "/" };
        assert.equal(runtime.safeParse(unknownWithValue).success, false, "unknown value");
        assert.equal(validate(unknownWithValue).valid, false, "unknown value");
      }
    }
  } finally { await session.close(); }
});

test("direct full impact provides navigation without rendering the family listing", async () => {
  const { session } = await setup();
  try {
    const result = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /value\.entrypoints/);
    assert.match(text, /value\.seeds/);
    assert.doesNotMatch(text, /reached entrypoints \(1\):|seeds \(1\):/);
  } finally { await session.close(); }
});

test("removed presentation inputs fail without executing a query", async () => {
  const { session, calls } = await setup();
  try {
    for (const args of [{ detail: "full" }, { full: true }, { full: false }, { mode: "invalid" }, { format: "json" }, { focus: "x" }]) {
      const result = await session.callTool("ye_ast_impact", { base: "main", ...args });
      assert.equal(result.isError, true);
    }
    assert.equal(calls.ofChange.length, 0);
  } finally { await session.close(); }
});

test("entrypoints reads the bound repository at HEAD by default and answers the fact with its rendering", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_entrypoints", {});
  assert.equal(calls.map.length, 1);
  assert.equal(calls.map[0]?.repo, REPOSITORY.path);
  assert.equal(calls.map[0]?.repoId, REPOSITORY.repoId);
  assert.equal(calls.map[0]?.revision, "HEAD");
  assert.deepEqual(withoutRecovery(result.structuredContent), envelopeOf(mapFact()));
  const text = textOf(result);
  assert.match(text, /status: complete/);
  assert.match(text, /GET \/orders\/\{id\}/);
  assert.match(text, /src\/OrderController\.java:17/);
  await session.close();
});

test("the header names the declared scope a complete status is relative to", async () => {
  const { session } = await setup();
  const text = textOf(await session.callTool("ye_ast_entrypoints", {}));
  assert.match(text, /^declared scope: languages java; frameworks spring$/m);
  await session.close();
});

test("entrypoints forwards the revision asked for", async () => {
  const { session, calls } = await setup();
  await session.callTool("ye_ast_entrypoints", { revision: "v1.2" });
  assert.equal(calls.map[0]?.revision, "v1.2");
  await session.close();
});

test("module dependencies have separate provenance and summary never masquerades as symbol impact", async () => {
  const value: ImpactValue = {
    seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 },
    modules: {
      origins: [{ file: "src/index.ts", change: "modified" }],
      modules: [
        { file: "src/index.ts", snapshot: "head", depth: 0, origins: [0] },
        ...Array.from({ length: 10 }, (_, index) => ({ file: `src/consumer-${index}.ts`, snapshot: "head" as const, depth: index + 1, origins: [0], via: { file: "src/index.ts", line: 4, specifier: "@public", kind: "import" as const, typeOnly: true } })),
      ], cost: { expansionsUsed: 11 },
    },
  };
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: { ...base(), status: "complete", value } }) });
  try {
    const summary = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
    assert.match(summary, /module dependencies/);
    assert.match(summary, /not symbol or entrypoint impact/);
    assert.doesNotMatch(summary, /src\/consumer-9.ts/);
    const result = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
    assert.deepEqual(((result.structuredContent as { value: ImpactValue }).value).modules, value.modules);
    assert.match(textOf(result), /value\.modules/);
    assert.doesNotMatch(textOf(result), /src\/consumer-9.ts/);
  } finally { await session.close(); }
});

test("impact reads a change of the bound repository, head defaulting to HEAD, and renders seeds, reached symbols and entrypoints", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_impact", { base: "main", mode: "details" });
  assert.deepEqual(calls.ofChange.map(({ repo, repoId, base: from, head, budget }) => ({ repo, repoId, from, head, budget })), [
    { repo: REPOSITORY.path, repoId: REPOSITORY.repoId, from: "main", head: "HEAD", budget: undefined },
  ]);
  assert.deepEqual(withoutRecovery(result.structuredContent), envelopeOf(impactFact(), "details"));
  const text = textOf(result);
  assert.match(text, /status: complete/);
  assert.match(text, /^seeds \(1\):\n {2}src\/OrderService\.java \(lines\)\n {4}31 OrderService\.find$/m);
  assert.match(text, /src\/OrderController\.java\n {4}17 OrderController\.one \[method\] \(depth 2, confidence 0\.75, fan-in 3, via src\/OrderService\.java:OrderService\.find at 44\)/);
  assert.match(text, /added http-route POST \/orders.*src\/OrderController\.java:40/);
  assert.match(text, /GET \/orders\/\{id\}.*depth 2.*"path":"src\/OrderController\.java","symbol":"OrderController\.one","line":17/);
  await session.close();
});

test("impact forwards head and the budget bounds the caller sets", async () => {
  const { session, calls } = await setup();
  await session.callTool("ye_ast_impact", { base: "main", head: "topic", budget: { depth: 3, hubFanIn: 50, expansions: 9 } });
  assert.equal(calls.ofChange[0]?.head, "topic");
  assert.deepEqual(calls.ofChange[0]?.budget, { depth: 3, hubFanIn: 50, expansions: 9 });
  await session.close();
});

test("impact forwards the changed selection", async () => {
  const { session, calls } = await setup();
  await session.callTool("ye_ast_impact", { base: "main", changed: ["src/a/**", "src/b/**"] });
  assert.deepEqual(calls.ofChange[0]?.changed, ["src/a/**", "src/b/**"]);
  await session.close();
});

test("a changed selection keeps callers eligible only within scope and recorded limits", async () => {
  const fact = impactFact({
    inputs: { ...base().inputs, declaredScope: { ...base().inputs.declaredScope, include: ["src/allowed/**"] }, declaredConfig: { changed: ["src/allowed/a/**"] } },
    status: "partial",
    cuts: [{ kind: "depth", at: ["src/allowed/b.ts::B.user"], limit: 1 }],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  try {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
    const change = text.split("\n").find((line) => line.startsWith("change:")) ?? "";
    assert.match(change, /src\/allowed\/a\/\*\*/);
    assert.match(change, /callers outside.*eligible.*scope/i);
    assert.match(change, /cuts|limits/i);
    assert.doesNotMatch(change, /indexed whole|callers outside.*are known/i);
    assert.match(text, /scope: include src\/allowed\/\*\*/);
    assert.match(text, /status: partial.*depth/);
  } finally { await session.close(); }
});

test("callers forwards symbol and line-range targets at a revision", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_callers", {
    revision: "topic",
    targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }, { file: "src/OrderService.java", start: 10, end: 20 }],
    budget: { depth: 2 },
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.callers[0]?.repo, REPOSITORY.path);
  assert.equal(calls.callers[0]?.revision, "topic");
  assert.deepEqual(calls.callers[0]?.targets, [{ file: "src/OrderService.java", symbol: "OrderService.find" }, { file: "src/OrderService.java", start: 10, end: 20 }]);
  assert.deepEqual(calls.callers[0]?.budget, { depth: 2 });
  assert.match(textOf(result), /status: complete/);
  await session.close();
});

test("importers forwards the files and identifies related file memberships", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], revision: "topic", mode: "details" });
  assert.deepEqual(calls.importers[0]?.files, ["src/OrderService.java"]);
  assert.equal(calls.importers[0]?.revision, "topic");
  const text = textOf(result);
  assert.match(text, /src\/OrderService\.java/);
  assert.match(text, /"src\/OrderController\.java": importers\[0\], users\[0\]/);
  assert.match(text, /"src\/Billing\.java": additional users\[1\]/);
  assert.match(text, /"src\/Legacy\.java": unresolved name matches\[0\]/);
  await session.close();
});

const OVERLAPPING_IMPORTERS: ImportersValue = {
  files: [{
    file: "src/OrderService.java",
    importers: ["src/Imported.java", "src/Shared.java"],
    users: ["src/Imported.java", "src/Shared.java", "src/Used.java", "src/UsedPending.java"],
    unresolvedNamers: ["src/Candidate.java", "src/Shared.java", "src/UsedPending.java"],
  }],
};

test("importers detail lists each related file once and preserves pending matches on resolved links", async () => {
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...base(), status: "complete", value: OVERLAPPING_IMPORTERS } }) });
  const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], mode: "details" });
  const text = textOf(result);
  for (const path of ["src/Imported.java", "src/Shared.java", "src/Used.java", "src/UsedPending.java", "src/Candidate.java"]) {
    assert.equal(text.split(path).length - 1, 1, path);
  }
  assert.match(text, /related files \(5 distinct\)/);
  assert.match(text, /"src\/Shared\.java": importers\[1\], users\[1\], unresolved name matches\[1\]/);
  assert.match(text, /"src\/UsedPending\.java": additional users\[3\], unresolved name matches\[2\]/);
  assert.match(text, /"src\/Candidate\.java": unresolved name matches\[0\]/);
  assert.match(text, /not establish additional dependencies/);
  await session.close();
});

test("importers summary counts every category without double-counting distinct files", async () => {
  const paths = Array.from({ length: 18 }, (_, i) => `src/app/core/auth/consumers/consumer-${String(i).padStart(2, "0")}.ts`);
  const value: ImportersValue = { files: [{ file: "src/auth.service.ts", importers: paths, users: paths, unresolvedNamers: paths.slice(1) }] };
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...base(), status: "complete", value } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/auth.service.ts"] }));
  assert.match(text, /related files \(18 distinct\)/);
  assert.match(text, /importers \(18\)/);
  assert.match(text, /users \(18; 0 additional\)/);
  assert.match(text, /unresolved name matches \(17\)/);
  for (const path of paths) assert.equal(text.includes(path), false, path);
  assert.match(text, /mode: "details"/);
  assert.match(text, /mode: "full"/);
  const detail = textOf(await session.callTool("ye_ast_importers", { files: ["src/auth.service.ts"], mode: "details" }));
  assert.ok(Buffer.byteLength(text) <= Buffer.byteLength(detail));
  await session.close();
});

test("importers full keeps the original overlapping fact and cuts without repeating file lists in text", async () => {
  const fact: Fact<ImportersValue> = { ...base(), status: "partial", value: OVERLAPPING_IMPORTERS, cuts: [{ kind: "no-extractor", at: ["src/Unread.java"] }] };
  const { session } = await setup({ importers: async () => ({ ok: true, value: fact }) });
  for (const mode of ["full"] as const) {
    const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], mode });
    assert.deepEqual(result.structuredContent, { ...fact, mode: "full", repositoryRoots: [{ repo: "shop", path: REPOSITORY.path }] });
    const text = textOf(result);
    assert.match(text, /status: partial/);
    assert.match(text, /structuredContent/);
    assert.equal(text.includes("src/Shared.java"), false);
    assert.equal(text.includes("src/Unread.java"), false);
  }
  await session.close();
});

test("importers summary keeps a shorter listing rather than a longer counted omission", async () => {
  const value: ImportersValue = { files: [{ file: "a.ts", importers: ["b.ts"], users: ["b.ts"], unresolvedNamers: [] }] };
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...base(), status: "complete", value } }) });
  const summary = textOf(await session.callTool("ye_ast_importers", { files: ["a.ts"] }));
  const detail = textOf(await session.callTool("ye_ast_importers", { files: ["a.ts"], mode: "details" }));
  assert.equal(summary, detail);
  assert.equal(summary.split("b.ts").length - 1, 1);
  await session.close();
});

test("importers distinguishes a complete empty result from an unknown result in every presentation", async () => {
  const empty: Fact<ImportersValue> = { ...base(), status: "complete", value: { files: [{ file: "a.ts", importers: [], users: [], unresolvedNamers: [] }] } };
  const unknown: Fact<ImportersValue> = { ...base(), status: "unknown", reason: "index-unavailable" };
  for (const fact of [empty, unknown]) {
    const { session } = await setup({ importers: async () => ({ ok: true, value: fact }) });
    for (const presentation of [{}, { mode: "details" }, { mode: "full" }]) {
      const result = await session.callTool("ye_ast_importers", { files: ["a.ts"], ...presentation });
      assert.equal((result.structuredContent as Fact<ImportersValue>).status, fact.status);
      const text = textOf(result);
      if (fact.status === "unknown") {
        if (!("mode" in presentation) || presentation.mode !== "full") assert.match(text, /index-unavailable/);
        assert.equal(text.includes("related files"), false);
      } else if (!("mode" in presentation) || presentation.mode !== "full") {
        assert.match(text, /related files \(0 distinct\)/);
        assert.equal(text.includes("omitted"), false);
      }
    }
    await session.close();
  }
});

test("a partial answer counts its cuts in the status line and keeps applicable limits under a closing heading", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [{ kind: "depth", at: ["src/A.java:A.f", "src/B.java:B.g"], limit: 3 }, { kind: "hub", at: ["src/C.java:C.h"] }],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  const lines = text.split("\n");
  assert.equal(lines[0], "status: partial (cuts: 1 depth, 1 hub)");
  assert.match(text, /depth \(1\); limit 3/);
  assert.match(text, /hub \(1\)/);
  assert.ok(text.indexOf("\ncuts:") > text.indexOf("impacted symbols"), "the cut list closes the answer");
  await session.close();
});

test("an impact summary counts every cut kind and keeps its bound regardless of symbol depth", async () => {
  const deep = impactFact({
    status: "partial",
    value: {
      ...IMPACT,
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/a.ts", symbol: "A.other", kind: "method", line: 4, depth: 1, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.one", kind: "function", line: 9, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.two", kind: "function", line: 19, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.three", kind: "function", line: 29, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.four", kind: "function", line: 39, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.five", kind: "function", line: 49, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.six", kind: "function", line: 59, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.seven", kind: "function", line: 69, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.eight", kind: "function", line: 79, depth: 2, confidence: 1, fanIn: 0 },
      ],
      entrypoints: [],
    },
    cuts: [
      { kind: "unresolved-link", at: ["src/a.ts::A.seed", "src/x.ts:5"] },
      { kind: "hub", at: ["src/a.ts::A.other"] },
      { kind: "depth", at: ["src/b.ts::B.one"], limit: 5 },
      { kind: "depth", at: ["src/b.ts::B.two"], limit: 5 },
      { kind: "depth", at: ["src/b.ts::B.three"], limit: 5 },
      { kind: "depth", at: ["src/b.ts::B.four"], limit: 5 },
      { kind: "depth", at: ["src/b.ts::B.five"], limit: 5 },
      { kind: "depth", at: ["src/b.ts::B.six"], limit: 5 },
      { kind: "depth", at: ["src/b.ts::B.seven"], limit: 5 },
      { kind: "depth", at: ["src/b.ts::B.eight"], limit: 5 },
      { kind: "no-extractor", at: ["src/z.swift"] },
    ],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: deep }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /^status: partial \(cuts: 8 depth, 1 hub, 1 no-extractor, 1 unresolved-link\)$/m);
  assert.match(text, /depth \(8\); limit 5/);
  assert.match(text, /hub \(1\)/);
  assert.match(text, /no-extractor \(1\)/);
  assert.match(text, /unresolved-link \(1\)/);
  assert.doesNotMatch(text, /B\.one|src\/x\.ts/);
  await session.close();
});

test("impact detail localizes every cut anchor while full JSON retains every reference place", async () => {
  const deep = impactFact({
    status: "partial",
    value: {
      ...IMPACT,
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/b.ts", symbol: "B.user", kind: "function", line: 9, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/c.ts", symbol: "C.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
      ],
      entrypoints: [],
    },
    cuts: [
      { kind: "unresolved-link", at: ["src/b.ts::B.user", "src/y.ts:7", "src/y.ts:9"] },
      { kind: "depth", at: ["src/c.ts::C.top"], limit: 5 },
    ],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: deep }) });
  const result = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" }));
  assert.deepEqual(withoutRecovery(result.structuredContent), { ...deep, mode: "full", repositoryRoots: [{ repo: "shop", path: REPOSITORY.path }] });
  assert.match(text, /anchor "src\/b\.ts::B\.user":\n\s+cut: \{"cutIndex":0\}; 2 reference places/);
  assert.doesNotMatch(text, /src\/y\.ts/);
  assert.match(text, /depth:\n\s+cut: \{"cutIndex":1\}; src\/c\.ts::C\.top \(limit 5\)/);
  assert.doesNotMatch(text, /summarized/);
  await session.close();
});

test("a workspace summary attributes counted cuts to their repository", async () => {
  const built = workspaceImpactFact();
  const value = (built as { value: WorkspaceImpactValue }).value;
  const section: Fact<RepoImpact> = {
    ...base(),
    status: "partial",
    value: { reads: [], impact: IMPACT, callSites: [], unmatched: [], external: [] },
    cuts: [{ kind: "unresolved-link", at: ["src/OrderController.java::OrderController.one", "src/app/page.ts:9"] }],
  };
  const fact = { ...built, value: { ...value, sections: { ...value.sections, shop: section } } } as Fact<WorkspaceImpactValue>;
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact } }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE }));
  assert.match(text, /cuts for repository shop:[\s\S]*unresolved-link \(1\)/);
  assert.doesNotMatch(text, /src\/app\/page\.ts/);
  await session.close();
});

test("cuts that name a single path are one line per kind listing every path", async () => {
  const partial = {
    ...base(),
    status: "partial",
    value: IMPORTERS,
    cuts: [{ kind: "no-extractor", at: ["src/C.swift"] }, { kind: "no-extractor", at: ["src/A.swift"] }, { kind: "no-extractor", at: ["src/B.swift"] }],
  } as Fact<ImportersValue>;
  const { session } = await setup({ importers: async () => ({ ok: true, value: partial }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"] }));
  assert.equal(text.split("\n")[0], "status: partial (cuts: 3 no-extractor)");
  assert.match(text, /no-extractor \(3\): src\/A\.swift, src\/B\.swift, src\/C\.swift/);
  await session.close();
});

test("with detail full, an unresolved-link cut renders the places in its anchor's file as line numbers and other files as path:line", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [{ kind: "unresolved-link", at: ["src/a.ts::A.f", "src/a.ts:18", "src/a.ts:123 no-extractor", "src/b.ts:7"] }],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], mode: "details" }));
  assert.match(text, /unresolved-link at src\/a\.ts::A\.f: lines 18, 123 \(no-extractor\), src\/b\.ts:7/);
  await session.close();
});

test("with detail full, the places of a cut are grouped under their file, every place kept and the path printed once", async () => {
  const places = ["src/a.ts::A.f", ...["10", "11", "12", "40"].map((line) => `src/x.ts:${line}`), ...["7", "9"].map((line) => `src/y.ts:${line}`), "src/z.ts:3 no-extractor"];
  const partial = impactFact({ status: "partial", cuts: [{ kind: "unresolved-link", at: places }] } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], mode: "details" }));
  assert.match(text, /unresolved-link at src\/a\.ts::A\.f: src\/x\.ts: 10, 11, 12, 40, src\/y\.ts: 7, 9, src\/z\.ts \(no-extractor\):3$/m);
  assert.equal(text.split("src/x.ts").length - 1, 1, "the path of a grouped file is printed once");
  for (const line of ["10", "11", "12", "40"]) assert.match(text, new RegExp(`\\b${line}\\b`), `line ${line} survives the grouping`);
  await session.close();
});

test("by default a cut names the declarations it could not settle to and the files their references sit in, never a line", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [
      { kind: "unresolved-link", at: ["src/a.ts::A.f", "src/x.ts:10", "src/x.ts:11", "src/y.ts:7"] },
      { kind: "unresolved-link", at: ["src/a.ts::A.g", "src/x.ts:10"] },
      { kind: "unresolved-link", at: ["src/z.ts", "src/z.ts:4"] },
    ],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"] }));
  assert.match(
    text,
    /unresolved-link \(1 file, 2 declarations, 5 references; mode "details" lists every place\):\n {4}src\/a\.ts\n {6}A\.f: src\/x\.ts, src\/y\.ts\n {6}A\.g: src\/x\.ts\n {4}src\/z\.ts\n {6}\(the file itself\)$/m,
  );
  assert.doesNotMatch(text, /src\/x\.ts:\d/, "a summary prints no line of a place");
  assert.equal(text.split("src/a.ts").length - 1, 1, "the file of the declarations is printed once");
  await session.close();
});

test("a summary names the references of a cut the file leads, so the reader settles it without a line", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [{ kind: "unresolved-link", at: ["src/z.ts", "src/z.ts:4 Promise.resolve", "src/z.ts:9 req.context.get"] }],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"] }));
  assert.match(text, /^ {4}src\/z\.ts: Promise\.resolve, req\.context\.get$/m);
  assert.doesNotMatch(text, /the file itself/);
  const full = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], mode: "details" }));
  assert.match(full, /unresolved-link at src\/z\.ts: lines 4 \(Promise\.resolve\), 9 \(req\.context\.get\)/);
  await session.close();
});

test("two cuts led by the same file keep every reference they name", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [
      { kind: "unresolved-link", at: ["src/z.ts", "src/z.ts:4 Promise.resolve"] },
      { kind: "unresolved-link", at: ["src/z.ts", "src/z.ts:9 req.context.get"] },
    ],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"] }));
  assert.match(text, /^ {4}src\/z\.ts: Promise\.resolve, req\.context\.get$/m);
  await session.close();
});

test("a declaration whose places are exactly another's points at it instead of printing them again", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [
      { kind: "unresolved-link", at: ["src/a.ts::A.h", "src/x.ts:1", "src/y.ts:2"] },
      { kind: "unresolved-link", at: ["src/b.ts::B.g", "src/x.ts:1", "src/y.ts:2"] },
      { kind: "unresolved-link", at: ["src/a.ts::A.f", "src/x.ts:1", "src/y.ts:2"] },
    ],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"] }));
  assert.match(
    text,
    /unresolved-link \(3 declarations, 6 references; mode "details" lists every place\):\n {4}src\/a\.ts\n {6}A\.f: src\/x\.ts, src\/y\.ts\n {6}A\.h \(same places as A\.f\)\n {4}src\/b\.ts\n {6}B\.g \(same places as src\/a\.ts::A\.f\)$/m,
  );
  assert.equal(text.split("src/x.ts").length - 1, 1, "a list shared by three declarations is printed once");
  await session.close();
});

test("unresolved declarations at different lines in one file do not claim the same places", async () => {
  const partial = impactFact({ status: "partial", cuts: [
    { kind: "unresolved-link", at: ["src/a.ts::A", "src/use.ts:10"] },
    { kind: "unresolved-link", at: ["src/a.ts::B", "src/use.ts:90"] },
  ] } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"] }));
  assert.doesNotMatch(text, /same places as/);
  await session.close();
});

test("workspace unknown repository reason is visible in summary and full text", async () => {
  const fact = workspaceFact();
  if (fact.status === "unknown") throw new Error("fixture");
  const unknown: Fact<WorkspaceSection> = { ...base(), status: "unknown", reason: "revision-unavailable", evidence: [] };
  const value = { ...fact.value, sections: { shop: unknown } };
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact: { ...fact, value } } }) });
  for (const detail of ["summary", "details"] as const) {
    const text = textOf(await session.callTool("ye_ast_workspace", { mode: detail }));
    assert.match(text, /shop: unknown \(revision-unavailable\)/);
  }
  await session.close();
});

test("both impact text levels count unselected change origins while full JSON preserves them", async () => {
  const seeds = Array.from({ length: 12 }, (_, index) => ({ file: `src/feature-${index}.ts`, symbol: `a${index}`, line: index + 1, basis: index % 2 === 0 ? "lines" as const : "top-level" as const }));
  const fact = impactFact({ value: { ...IMPACT, seeds, symbols: [], entrypoints: [], changedEntrypoints: [] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const summary = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(summary, /^seeds \(12\):\n {2}change origins: 12 declarations across 12 files \(lines 6, top-level 6\); mode: "full" includes every seed$/m);
  assert.doesNotMatch(summary, /src\/feature-/);
  const full = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
  assert.deepEqual(withoutRecovery(full.structuredContent), { ...fact, mode: "full", repositoryRoots: [{ repo: "shop", path: REPOSITORY.path }] });
  assert.doesNotMatch(textOf(full), /src\/feature-/);
  assert.match(textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" })), /change origins: 12 declarations across 12 files/);
  await session.close();
});

test("a summary lists the seeds a caller asked for and counts the change seeds beside them", async () => {
  const seeds = [
    { file: "src/a.ts", symbol: "asked", line: 1, basis: "requested" as const },
    ...Array.from({ length: 10 }, (_, index) => ({ file: "src/a.ts", symbol: `a${index}`, line: index + 2, basis: "lines" as const })),
  ];
  const fact = impactFact({ value: { ...IMPACT, seeds, symbols: [], entrypoints: [], changedEntrypoints: [] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const summary = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(summary, /^seeds \(11\):\n {2}src\/a\.ts \(requested\)\n {4}1 asked\n {2}change origins: 10 declarations across 1 file \(lines 10\); mode: "full" includes every seed$/m);
  await session.close();
});

test("the seeds of an impact answer are grouped under their file, with the basis printed once when the file shares it", async () => {
  const seeds = [
    { file: "src/a.ts", symbol: "a", line: 3, basis: "lines" as const },
    { file: "src/a.ts", symbol: "b", line: 9, basis: "top-level" as const },
    { file: "src/b.ts", symbol: "c", line: 2, basis: "requested" as const },
  ];
  const fact = impactFact({ value: { ...IMPACT, seeds, entrypoints: [] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" }));
  assert.match(text, /^seeds \(3\):\n {2}src\/a\.ts\n {4}3 a \(lines\)\n {4}9 b \(top-level\)\n {2}src\/b\.ts \(requested\)\n {4}2 c$/m);
  assert.equal(text.split("src/a.ts").length - 1, 1, "the path of a grouped file is printed once");
  await session.close();
});

test("a symbol prints the span it covers and the place inside itself where it depends on the one that reached it", async () => {
  const value: ImpactValue = {
    seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 3, endLine: 9, basis: "requested" }],
    symbols: [
      { file: "src/b.ts", symbol: "B.user", kind: "function", line: 40, endLine: 58, depth: 1, confidence: 1, fanIn: 0, via: { file: "src/a.ts", symbol: "A.seed", lines: [44, 51, 63], basis: "call" } },
      { file: "src/c.ts", symbol: "C.one", kind: "constant", line: 7, depth: 2, confidence: 1, fanIn: 0, via: { file: "src/b.ts", symbol: "B.user", basis: "dispatch" } },
      { file: "src/d.ts", symbol: "D.type", kind: "class", line: 9, depth: 2, confidence: 1, fanIn: 0, via: { file: "src/b.ts", symbol: "B.user", lines: [12], basis: "reference" } },
    ],
    entrypoints: [{ kind: "http-route", name: "GET /one", handler: { path: "src/c.ts", symbol: "C.one", line: 7 }, depth: 2, confidence: 1, seeds: [0] }, { kind: "http-route", name: "GET /type", handler: { path: "src/d.ts", symbol: "D.type", line: 9 }, depth: 2, confidence: 1, seeds: [0] }],
    cost: { expansionsUsed: 0 },
  };
  const fact = impactFact({ value } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" }));
  assert.match(text, /^seeds \(1\):\n {2}src\/a\.ts \(requested\)\n {4}3-9 A\.seed$/m);
  assert.match(text, /^ {2}src\/b\.ts\n {4}40-58 B\.user \[function\] \(depth 1, via src\/a\.ts:A\.seed at 44, 51, 63\)$/m);
  assert.match(text, /^ {4}7 C\.one \[constant\] \(depth 2, via src\/b\.ts:B\.user \(dispatch\)\)$/m);
  assert.match(text, /^ {4}9 D\.type \[class\] \(depth 2, via src\/b\.ts:B\.user at 12 \(reference\)\)$/m);
  await session.close();
});

test("a one-line declaration prints one line and a handler prints its span", async () => {
  const value: ImpactValue = {
    seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 3, basis: "requested" }],
    symbols: [],
    entrypoints: [{ kind: "http-route", name: "GET /orders/{id}", handler: { path: "src/OrderController.java", symbol: "OrderController.one", line: 17, endLine: 31 }, depth: 1, confidence: 1, seeds: [0] }],
    cost: { expansionsUsed: 0 },
  };
  const fact = impactFact({ value } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /^ {4}3 A\.seed$/m);
  assert.match(text, /\(depth 1, endLine 31\); handler: \{"path":"src\/OrderController\.java","symbol":"OrderController\.one","line":17\}/m);
  assert.doesNotMatch(text, /3-3/);
  await session.close();
});

test("impacted symbols are grouped under their file, a seed at depth 0 is not printed twice and only a confidence below 1 or a fan-in above 0 is printed", async () => {
  const grouped = impactFact({
    value: {
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/a.ts", symbol: "A.seed", kind: "method", line: 1, depth: 0, confidence: 1, fanIn: 0 },
        { file: "src/a.ts", symbol: "A.other", kind: "method", line: 4, depth: 1, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.user", kind: "function", line: 9, depth: 2, confidence: 0.5, fanIn: 2, via: { file: "src/a.ts", symbol: "A.other", lines: [44], basis: "call" } },
        { file: "src/b.ts", symbol: "B.helper", kind: "function", line: 2, depth: 2, confidence: 0.5, fanIn: 1, via: { file: "src/b.ts", symbol: "B.user", lines: [7], basis: "call" } },
      ],
      entrypoints: [{ kind: "http-route", name: "GET /user", handler: { path: "src/b.ts", symbol: "B.user", line: 9 }, depth: 2, confidence: 0.5, seeds: [0] }, { kind: "http-route", name: "GET /helper", handler: { path: "src/b.ts", symbol: "B.helper", line: 2 }, depth: 2, confidence: 0.5, seeds: [0] }],
      cost: { expansionsUsed: 1 },
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: grouped }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" }));
  assert.match(text, /impacted symbols \(3\):\n {2}src\/a\.ts\n {4}4 A\.other \[method\] \(depth 1\)\n {2}src\/b\.ts\n {4}9 B\.user \[function\] \(depth 2, confidence 0\.5, fan-in 2, via src\/a\.ts:A\.other at 44\)\n {4}2 B\.helper \[function\] \(depth 2, confidence 0\.5, fan-in 1, via B\.user at 7\)/);
  assert.doesNotMatch(text, /A\.seed \[method\]/);
  await session.close();
});

test("callers summary counts dependency depths and detail identifies the nearest evidence frontier", async () => {
  const deep = impactFact({
    value: {
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/a.ts", symbol: "A.other", kind: "method", line: 4, depth: 1, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.user", kind: "function", line: 9, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.helper", kind: "function", line: 2, depth: 3, confidence: 1, fanIn: 0 },
        { file: "src/c.ts", symbol: "C.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/d.ts", symbol: "D.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/e.ts", symbol: "E.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/f.ts", symbol: "F.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/g.ts", symbol: "G.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/h.ts", symbol: "H.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
      ],
      entrypoints: [],
      cost: { expansionsUsed: 1 },
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ callers: async () => ({ ok: true, value: deep }) });
  const result = await session.callTool("ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.seed" }] });
  const text = textOf(result);
  assert.match(text, /by depth: 1: 1, 2: 7, 3: 1/);
  assert.doesNotMatch(text, /B\.user|C\.top/);
  const { recovery: _recovery, ...receipt } = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(receipt, envelopeOf(deep));
  const full = textOf(await session.callTool("ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.seed" }], mode: "details" }));
  assert.match(full, /4 A\.other/);
  assert.match(full, /8 other symbols; mode: "full"/);
  assert.doesNotMatch(full, /B\.user|C\.top/);
  await session.close();
});

test("callers summary retains requested targets while counting deeper consequences", async () => {
  const deep = impactFact({
    value: {
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/b.ts", symbol: "B.user", kind: "function", line: 9, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/c.ts", symbol: "C.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/d.ts", symbol: "D.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/e.ts", symbol: "E.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/f.ts", symbol: "F.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/g.ts", symbol: "G.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/h.ts", symbol: "H.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
      ],
      entrypoints: [],
      cost: { expansionsUsed: 1 },
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ callers: async () => ({ ok: true, value: deep }) });
  const text = textOf(await session.callTool("ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.seed" }] }));
  assert.match(text, /by depth: 2: 7/);
  assert.match(text, /1 A\.seed/);
  await session.close();
});

test("reached entrypoints print their confidence only when it is below 1", async () => {
  const entrypoints = impactFact({
    value: {
      ...IMPACT,
      entrypoints: [
        { kind: "http-route", name: "GET /sure", handler: { path: "src/OrderController.java", symbol: "OrderController.one", line: 17 }, depth: 1, confidence: 1, seeds: [0] },
        { kind: "http-route", name: "GET /maybe", handler: { path: "src/OrderController.java", symbol: "OrderController.one", line: 17 }, depth: 2, confidence: 0.4, seeds: [0] },
      ],
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: entrypoints }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /GET \/sure \(depth 1\); lookup example:.*"path":"src\/OrderController\.java","symbol":"OrderController\.one","line":17/);
  assert.match(text, /GET \/maybe \(depth 2, confidence 0\.4\).*"path":"src\/OrderController\.java","symbol":"OrderController\.one","line":17/);
  await session.close();
});

test("entrypoints closes with the cut list of the map and of its section", async () => {
  const section = {
    ...base(),
    status: "partial",
    value: [{ ...base(), status: "complete", value: ROUTE }],
    cuts: [{ kind: "no-extractor", at: ["src/scripts/build.js"] }],
  } as Fact<readonly Fact<Entrypoint>[]>;
  const fact = { ...base(), status: "partial", value: { entrypoints: section }, cuts: [{ kind: "section", at: ["entrypoints"] }] } as EntrypointMapFact;
  const { session } = await setup({ map: async () => ({ ok: true, value: fact }) });
  const text = textOf(await session.callTool("ye_ast_entrypoints", {}));
  const lines = text.split("\n");
  assert.equal(lines[0], "status: partial (cuts: 1 section: entrypoints)");
  assert.match(text, / {2}status: partial \(cuts: 1 no-extractor\)/);
  assert.match(text, /\ncuts:\n {2}no-extractor \(1\): src\/scripts\/build\.js\n {2}section \(1\): entrypoints\n(?: {2}lookup example: [^\n]+\n)+Recovery recipe and resultIdentity: structuredContent\.recovery\.\nrepository root: shop -> \/work\/shop$/);
  await session.close();
});

test("an unknown answer says unknown with its reason and its evidence, never an empty list", async () => {
  const unknown = { ...base({ evidence: [{ path: "src/Broken.java", line: 4 }] }), status: "unknown", reason: "index-unavailable" } as Fact<ImpactValue>;
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: unknown }) });
  const result = await session.callTool("ye_ast_impact", { base: "main" });
  const text = textOf(result);
  assert.match(text, /status: unknown \(index-unavailable\)/);
  assert.match(text, /src\/Broken\.java:4/);
  assert.deepEqual(withoutRecovery(result.structuredContent), envelopeOf(unknown));
  assert.doesNotMatch(text, /\(none\)/);
  const details = await session.callTool("ye_ast_impact", { base: "main", mode: "details" });
  assert.deepEqual(withoutRecovery(details.structuredContent), envelopeOf(unknown, "details"));
  assert.match(textOf(details), /index-unavailable/);
  assert.match(textOf(details), /src\/Broken\.java:4/);
  const full = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
  assert.deepEqual(withoutRecovery(full.structuredContent), { ...unknown, mode: "full", repositoryRoots: [{ repo: "shop", path: REPOSITORY.path }] });
  assert.equal("value" in (full.structuredContent as Record<string, unknown>), false);
  await session.close();
});

test("an unknown entrypoint item is rendered unknown next to the routes found", async () => {
  const item = { ...base({ evidence: [{ path: "src/Weird.java", line: 9 }] }), status: "unknown", reason: "unresolved" } as Fact<Entrypoint>;
  const section = { ...base(), status: "complete", value: [item] } as Fact<readonly Fact<Entrypoint>[]>;
  const fact = { ...base(), status: "complete", value: { entrypoints: section } } as EntrypointMapFact;
  const { session } = await setup({ map: async () => ({ ok: true, value: fact }) });
  const text = textOf(await session.callTool("ye_ast_entrypoints", {}));
  assert.match(text, /unknown \(unresolved\).*src\/Weird\.java:9/);
  await session.close();
});

test("a verified-empty complete answer counts its empty lists instead of spelling none", async () => {
  const empty = impactFact({ value: { seeds: [], symbols: [], entrypoints: [] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: empty }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /status: complete/);
  assert.match(text, /^seeds \(0\):$/m);
  assert.match(text, /^reached entrypoints \(0\):$/m);
  assert.match(text, /^impacted symbols \(0\):$/m);
  assert.doesNotMatch(text, /\(none\)/);
  await session.close();
});

test("a fault is a tool error carrying its kind and a redacted detail, with no fact", async () => {
  const { session } = await setup({ ofChange: async () => ({ ok: false, fault: { kind: "unknown-revision", detail: `bad ref ${SECRET}` } }) });
  const result = await session.callTool("ye_ast_impact", { base: "nope" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const text = textOf(result);
  assert.match(text, /unknown-revision/);
  assert.match(text, new RegExp(`bad ref ${REDACTED.replace(/[[\]]/g, "\\$&")}`));
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.deepEqual(result._meta?.["ye-ast/fault"], { kind: "unknown-revision", detail: `bad ref ${REDACTED}` });
  assert.doesNotMatch(JSON.stringify(result._meta), new RegExp(SECRET));
  await session.close();
});

test("duplicate workspace source renders typed recovery", async () => {
  const { session } = await setup({ outwardNames: async () => ({ ok: false, fault: { kind: "duplicate-workspace-source", detail: "a, b" } }) });
  try {
    const result = await session.callTool("ye_ast_workspace", {});
    assert.equal(result.isError, true);
    assert.deepEqual(result._meta?.["ye-ast/fault"], { kind: "duplicate-workspace-source", detail: "a, b" });
    assert.match(textOf(result), /Remove the duplicate workspace source/);
  } finally { await session.close(); }
});

test("workspace capture failure retains its redacted typed cause without absolute paths", async () => {
  for (const path of ["/private/live/repository", "C:\\private\\live\\repository", ""]) {
    const fault = { kind: "workspace-capture-unavailable" as const, detail: `capture failed at ${path}`, repo: "../lib", cause: { kind: "git-failed" as const, detail: `bad ${path} ${SECRET}` } };
    const { session } = await setup({ outwardNames: async () => ({ ok: false, fault }) });
    try {
      const result = await session.callTool("ye_ast_workspace", {});
      assert.equal(result.isError, true);
      assert.deepEqual(result._meta?.["ye-ast/fault"], { ...fault, detail: path ? "[path omitted]" : fault.detail, cause: { kind: "git-failed", detail: path ? "[path omitted]" : `bad  ${REDACTED}` } });
      assert.match(textOf(result), /Inspect the capture cause/);
      if (path) assert.ok(!JSON.stringify(result).includes(path));
      assert.ok(!JSON.stringify(result).includes(SECRET));
    } finally { await session.close(); }
  }
});

test("an unknown-symbol fault lists every entry that names no node and what its file declares", async () => {
  const fault: ImpactFault = {
    kind: "unknown-symbol",
    detail: "no such symbol",
    entries: [
      { file: "src/A.java", symbol: "A.gone", candidates: ["A.other", "A.used"] },
      { file: "src/B.java", symbol: "B.gone", candidates: [] },
    ],
  };
  const { session } = await setup({ callers: async () => ({ ok: false, fault }) });
  const result = await session.callTool("ye_ast_callers", { targets: [{ file: "src/A.java", symbol: "A.gone" }] });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /src\/A\.java:A\.gone: declared in src\/A\.java: A\.other, A\.used/);
  assert.match(text, /src\/B\.java:B\.gone: src\/B\.java declares no symbol/);
  assert.ok(text.includes("targets") && text.includes("ye_ast_outline"));
  assert.deepEqual(result._meta?.["ye-ast/fault"], fault);
  await session.close();
});

test("an unknown-change-path fault names the globs that selected no changed path", async () => {
  const fault: ImpactFault = { kind: "unknown-change-path", detail: "no changed path matches src/z/**", globs: ["src/z/**"] };
  const { session } = await setup({ ofChange: async () => ({ ok: false, fault }) });
  const result = await session.callTool("ye_ast_impact", { base: "main" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^fault: unknown-change-path$/m);
  assert.match(textOf(result), /src\/z\/\*\*/);
  assert.ok(textOf(result).includes("Remove changed") && textOf(result).includes("within the declared scope"));
  assert.deepEqual(result._meta?.["ye-ast/fault"], fault);
  await session.close();
});

test("a query that throws is a tool error with a redacted message", async () => {
  const { session } = await setup({
    map: async () => {
      throw new Error(`boom ${SECRET}`);
    },
  });
  const result = await session.callTool("ye_ast_entrypoints", {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /internal-fault/);
  assert.doesNotMatch(textOf(result), new RegExp(SECRET));
  await session.close();
});

test("redaction is applied to the structured content and so to the text rendered from it", async () => {
  const leaking = impactFact({ value: { ...IMPACT, seeds: [{ file: `src/${SECRET}.java`, symbol: "S.f", line: 1, basis: "requested" }] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: leaking }) });
  const result = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
  assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(SECRET));
  assert.match(JSON.stringify(result.structuredContent), new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  assert.doesNotMatch(textOf(result), new RegExp(SECRET));
  for (const mode of ["summary", "details"] as const) {
    const answer = await session.callTool("ye_ast_impact", { base: "main", mode });
    assert.deepEqual(withoutRecovery(answer.structuredContent), envelopeOf(leaking, mode));
    assert.ok(textOf(answer).includes(`src/${REDACTED}.java`));
    assert.doesNotMatch(textOf(answer), new RegExp(SECRET));
  }
  await session.close();
});

test("every tool forwards the scope the caller sets and sends none it was not given", async () => {
  const { session, calls } = await setup();
  const scope = { include: ["src/app/**"], exclude: ["**/*.spec.ts"] };
  await session.callTool("ye_ast_entrypoints", { scope });
  await session.callTool("ye_ast_impact", { base: "main", scope });
  await session.callTool("ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.f" }], scope: { exclude: ["**/*.spec.ts"] } });
  await session.callTool("ye_ast_importers", { files: ["src/a.ts"], scope });
  await session.callTool("ye_ast_importers", { files: ["src/a.ts"] });
  assert.deepEqual([calls.map[0]?.scope, calls.ofChange[0]?.scope, calls.callers[0]?.scope, calls.importers[0]?.scope], [scope, scope, { exclude: ["**/*.spec.ts"] }, scope]);
  assert.equal("scope" in (calls.importers[1] ?? {}), false);
  await session.close();
});

test("an answer read within a caller's scope says so under its status, and one without a scope does not", async () => {
  const declaredScope = { languages: ["java"], frameworks: ["spring"], include: ["src/app/**"], exclude: ["**/*.spec.ts", "src/legacy/**"] };
  const scoped = impactFact({ inputs: { ...base().inputs, declaredScope } });
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: scoped }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /^status: complete\ndeclared scope: languages java; frameworks spring\nscope: include src\/app\/\*\*; exclude \*\*\/\*\.spec\.ts, src\/legacy\/\*\* \(the content it selects; the configuration that interprets it is read too\)\nsnapshot: /);
  const plain = textOf(await session.callTool("ye_ast_importers", { files: ["src/a.ts"] }));
  assert.doesNotMatch(plain, /^scope:/m);
  await session.close();
});

test("the server instructions say what to do at every kind of cut", async () => {
  const { session } = await setup();
  assert.match(session.instructions ?? "", /cuts/);
  assert.ok((session.instructions?.length ?? 0) <= 4000);
  await session.close();
});

test("arguments that break the schema are refused before any query runs", async () => {
  const { session, calls } = await setup();
  const refused = [
    await session.callTool("ye_ast_impact", {}),
    await session.callTool("ye_ast_impact", { base: "main", budget: { depth: 0 } }),
    await session.callTool("ye_ast_impact", { base: "main", repo: "/elsewhere" }),
    await session.callTool("ye_ast_importers", { files: [] }),
    await session.callTool("ye_ast_callers", { targets: [{ file: "a.java" }] }),
    await session.callTool("ye_ast_callers", { targets: [{ file: "a.java", start: 9, end: 3 }] }),
    await session.callTool("ye_ast_entrypoints", { scope: { include: ["../outside/**"] } }),
    await session.callTool("ye_ast_importers", { files: ["a.java"], scope: { exclude: ["src\\a.java"] } }),
    await session.callTool("ye_ast_impact", { base: "main", scope: { include: [] } }),
    await session.callTool("ye_ast_impact", { base: "main", changed: ["./x/**"] }),
  ];
  assert.deepEqual(refused.map((result) => result.isError), [true, true, true, true, true, true, true, true, true, true]);
  assert.deepEqual([calls.map.length, calls.ofChange.length, calls.importers.length, calls.callers.length], [0, 0, 0, 0]);
  await session.close();
});

test("cancelling a selected call aborts the signal the query received", async () => {
  let aborted: (signal: AbortSignal) => void = () => {};
  let running: (signal: AbortSignal) => void = () => {};
  const seenAbort = new Promise<AbortSignal>((resolve) => (aborted = resolve));
  const queryRunning = new Promise<AbortSignal>((resolve) => (running = resolve));
  const { session } = await setup({
    map: (request) =>
      new Promise((resolve) => {
        const signal = request.signal!;
        running(signal);
        signal.addEventListener("abort", () => {
          aborted(signal);
          resolve({ ok: false, fault: { kind: "aborted", detail: "stopped" } });
        });
      }),
  });
  const call = session.startCall("ye_ast_entrypoints", { select: { kind: "entrypoint-evidence", findingIndex: 0 }, page: { limit: 1 } });
  assert.equal((await queryRunning).aborted, false);
  await session.cancel(call.id);
  assert.equal((await seenAbort).aborted, true);
  await session.close();
});

test("live on each tool asks for the working tree with no revision, and the fact is answered unchanged", async () => {
  const liveSnapshot = { repo: "shop", kind: "live" as const, head: "a".repeat(40), stateId: "state-123" };
  const liveFact = mapFact({ snapshot: liveSnapshot });
  const { session, calls } = await setup({ map: async () => ({ ok: true, value: liveFact }) });

  const results = [
    await session.callTool("ye_ast_entrypoints", { live: true }),
    await session.callTool("ye_ast_impact", { base: "main", live: true }),
    await session.callTool("ye_ast_callers", { live: true, targets: [{ file: "src/A.java", symbol: "f" }] }),
    await session.callTool("ye_ast_importers", { live: true, files: ["src/A.java"] }),
  ];

  const requests: Record<string, unknown>[] = [calls.map[0], calls.ofChange[0], calls.callers[0], calls.importers[0]].map((request) => ({ ...request }));
  assert.deepEqual(requests.map((request) => [request.live, request.revision, request.head]), [[true, undefined, undefined], [true, undefined, undefined], [true, undefined, undefined], [true, undefined, undefined]]);
  assert.equal(calls.ofChange[0]?.base, "main");
  assert.deepEqual(withoutRecovery(results[0]?.structuredContent), envelopeOf(liveFact));
  const details = await session.callTool("ye_ast_entrypoints", { live: true, mode: "details" });
  assert.deepEqual(withoutRecovery(details.structuredContent), envelopeOf(liveFact, "details"));
  assert.equal(results.every((result) => result._meta === undefined && !textOf(result).startsWith("stale:")), true);
  await session.close();
});

test("live with a revision or a head is refused by the schema before any query runs", async () => {
  const { session, calls } = await setup();

  const results = [
    await session.callTool("ye_ast_entrypoints", { live: true, revision: "main" }).catch((error: Error) => error),
    await session.callTool("ye_ast_impact", { base: "main", live: true, head: "feature" }).catch((error: Error) => error),
    await session.callTool("ye_ast_callers", { live: true, revision: "main", targets: [{ file: "a", symbol: "f" }] }).catch((error: Error) => error),
    await session.callTool("ye_ast_importers", { live: true, revision: "main", files: ["a"] }).catch((error: Error) => error),
  ];

  for (const result of results) assert.equal(result instanceof Error || (result as { isError?: boolean }).isError === true, true);
  assert.deepEqual([calls.map, calls.ofChange, calls.callers, calls.importers], [[], [], [], []]);
  await session.close();
});

test("an answer the working tree moved past opens its text with a stale line and carries the notice in _meta and beside the fact, with the fact untouched", async () => {
  const { session } = await setup({
    map: async (request) => {
      request.live === true && request.onStale?.({ stateId: "s1", changed: ["src/A.java", `src/${SECRET}.java`] });
      return { ok: true, value: mapFact() };
    },
  });

  const result = await session.callTool("ye_ast_entrypoints", { live: true });

  const notice = { stateId: "s1", changed: ["src/A.java", `src/${REDACTED}.java`] };
  assert.match(textOf(result), /^stale: .*state s1: src\/A\.java, src\/\[REDACTED\]\.java\nstatus: complete/);
  assert.deepEqual(result._meta, { "ye-ast/live": notice });
  assert.deepEqual(withoutRecovery(result.structuredContent), envelopeOf(mapFact()));
  const details = await session.callTool("ye_ast_entrypoints", { live: true, mode: "details" });
  assert.match(textOf(details), /^stale: .*state s1: src\/A\.java, src\/\[REDACTED\]\.java\nstatus: complete/);
  assert.deepEqual(details._meta, { "ye-ast/live": notice });
  assert.deepEqual(withoutRecovery(details.structuredContent), envelopeOf(mapFact(), "details"));
  const full = await session.callTool("ye_ast_entrypoints", { live: true, mode: "full" });
  assert.deepEqual(full._meta, { "ye-ast/live": notice });
  assert.deepEqual(withoutRecovery(full.structuredContent), { ...mapFact(), mode: "full", live: notice, repositoryRoots: [{ repo: "shop", path: REPOSITORY.path }] });
  assert.match(textOf(full), /live\.stateId and live\.changed/);
  await session.close();
});

test("a live query refused under untrusted is an error result naming the command that trusts the repository", async () => {
  const { session } = await setup({ map: async () => ({ ok: false, fault: { kind: "live-requires-trusted", detail: "run `ye-ast init --trust trusted`" } }) });

  const result = await session.callTool("ye_ast_entrypoints", { live: true });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /live-requires-trusted[\s\S]*ye-ast init --trust trusted/);
  await session.close();
});

test("callers and impact with a workspace ask the workspace family with the repositories and gateways given, and never the single-repository one", async () => {
  const { session, calls } = await setup();

  await session.callTool("ye_ast_callers", { revision: "topic", targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }], workspace: WORKSPACE, budget: { depth: 2 }, scope: { include: ["src/**"] } });
  await session.callTool("ye_ast_impact", { base: "main", head: "topic", workspace: WORKSPACE, changed: ["src/**"] });

  assert.deepEqual([calls.callers, calls.ofChange], [[], []]);
  assert.deepEqual(calls.workspaceCallers[0], {
    repo: { path: REPOSITORY.path, id: REPOSITORY.repoId, revision: "topic" },
    repos: [{ path: "/work/shop-web", id: "shop-web" }],
    gateways: WORKSPACE.gateways,
    targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }],
    scope: { include: ["src/**"] },
    budget: { depth: 2 },
    signal: calls.workspaceCallers[0]?.signal,
  });
  assert.equal(calls.workspaceOfChange[0]?.base, "main");
  assert.equal(calls.workspaceOfChange[0]?.repo.revision, "topic");
  assert.deepEqual(calls.workspaceOfChange[0]?.repos, WORKSPACE.repos);
  assert.deepEqual(calls.workspaceOfChange[0]?.changed, ["src/**"]);
  await session.close();
});

test("a workspace with no repositories is accepted and asks the workspace family, which works over the persisted one", async () => {
  const { session, calls } = await setup();

  await session.callTool("ye_ast_callers", { targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }], workspace: {} });

  assert.deepEqual(calls.callers, []);
  assert.equal(calls.workspaceCallers.length, 1);
  assert.equal(calls.workspaceCallers[0]?.repos, undefined);
  await session.close();
});

test("callers and impact without a workspace never reach the workspace family", async () => {
  const { session, calls } = await setup();

  await session.callTool("ye_ast_callers", { targets: [{ file: "a", symbol: "f" }] });
  await session.callTool("ye_ast_impact", { base: "main" });

  assert.deepEqual([calls.workspaceCallers, calls.workspaceOfChange], [[], []]);
  assert.equal(calls.callers.length + calls.ofChange.length, 2);
  await session.close();
});

test("offline reaches every workspace-bearing request, and live is refused beside it before any query runs", async () => {
  const { session, calls } = await setup();

  await session.callTool("ye_ast_workspace", { offline: true });
  await session.callTool("ye_ast_decisions", { offline: true });
  await session.callTool("ye_ast_callers", { targets: [{ file: "a", symbol: "f" }], workspace: WORKSPACE, offline: true });
  await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, offline: true });

  assert.deepEqual(calls.workspaceReads.map(({ offline: stated }) => stated), [true]);
  assert.deepEqual(calls.decisions.map(({ offline: stated }) => stated), [true]);
  assert.deepEqual(calls.workspaceCallers.map(({ offline: stated }) => stated), [true]);
  assert.deepEqual(calls.workspaceOfChange.map(({ offline: stated }) => stated), [true]);

  const refused = [
    await session.callTool("ye_ast_callers", { live: true, offline: true, targets: [{ file: "a", symbol: "f" }] }).catch((error: Error) => error),
    await session.callTool("ye_ast_impact", { base: "main", live: true, offline: true }).catch((error: Error) => error),
  ];
  for (const result of refused) assert.equal(result instanceof Error || (result as { isError?: boolean }).isError === true, true);
  assert.deepEqual([calls.workspaceCallers.length, calls.workspaceOfChange.length], [1, 1]);
  await session.close();
});

test("a workspace answer lists the links across repositories with their basis, the gateways in force, the declared ones that matched nothing, the unmatched and the external call sites", async () => {
  const { session } = await setup();

  const result = await session.callTool("ye_ast_callers", { targets: [{ file: "a", symbol: "f" }], workspace: WORKSPACE });

  const text = textOf(result);
  assert.match(text, /^repositories declared by: the request$/m);
  assert.match(text, /orders-api -> shop \(route-overlap\)/);
  assert.match(text, /shop-web:src\/app\/order\.api\.ts:7 OrderApi\.create -> shop GET \/orders\/\{id\} -> src\/OrderController\.java:17 OrderController\.one \(route-overlap, upstream; reach: 1\)/);
  assert.match(text, /unmatched \(1\):\n\s+- src\/app\/order\.api\.ts:9 .* GET orders-api\/missing/);
  assert.match(text, /external \(1\):\n\s+- src\/app\/order\.api\.ts:11 .* GET geo-api\/provinces/);
  assert.match(text, /no local repository serves \(1\): geo-api/);
  assert.match(text, /declared gateways that matched nothing \(1\):\n\s+- legacy -> shop/);
  assert.equal(text.match(/reached entrypoints \(/g)?.length, 1, "the bound repository's walk is printed once");
  await session.close();
});

test("the workspace parameter names its repositories by a nested path, accepts gateways, and refuses what it does not define", async () => {
  const { session, calls } = await setup();
  const tools = await session.listTools();
  for (const name of ["ye_ast_callers", "ye_ast_impact"]) {
    const workspace = tools.find((tool) => tool.name === name)?.inputSchema.properties?.["workspace"] as { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> } | undefined;
    assert.ok(workspace?.properties?.["repos"]?.items?.properties?.["path"] !== undefined, name);
    assert.ok(workspace?.properties?.["gateways"] !== undefined, name);
  }

  const refused = await session.callTool("ye_ast_impact", { base: "main", workspace: { repos: [{ path: "/work/shop-web" }], remote: "https://example.test/x.git" } }).catch((error: Error) => error);

  assert.equal(refused instanceof Error || (refused as { isError?: boolean }).isError === true, true);
  assert.deepEqual(calls.workspaceOfChange, []);
  await session.close();
});

test("the server instructions tell the agent to pass the other clones as the workspace of callers and impact", async () => {
  const { session } = await setup();

  assert.match(session.instructions ?? "", /workspace/);
  assert.match(session.instructions ?? "", /ye_ast_callers[^\n]*workspace|workspace[^\n]*ye_ast_impact/);
  await session.close();
});

test("the workspace tool answers the outward names without the repositories it read: no absolute path, no entrypoint list", async () => {
  const internalPath = "/internal/mirror/private";
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact(), repositorySources: [{ repo: "shop", path: internalPath }] } }) });

  const result = await session.callTool("ye_ast_workspace", { mode: "full" });
  assert.equal("repositorySources" in (result.structuredContent as Record<string, unknown>), false);
  assert.equal(JSON.stringify(result).includes(internalPath), false);
  const value = (result.structuredContent as { value: Record<string, unknown> }).value;
  assert.equal("repositories" in value, false);
  assert.deepEqual(Object.keys(value).sort(), ["candidates", "repositorySnapshots", "sections", "unserved", "workspace"]);
  await session.close();
});

test("an agent-selected remote is refused before any workspace query runs", async () => {
  const { session, calls } = await setup();
  const remote = "https://git.example.com/shop/web.git";
  const repos = [{ path: "/work/shop-web", id: "shop-web", remote }];
  const requests = [
    ["ye_ast_workspace", { repos }],
    ["ye_ast_decisions", { repos }],
    ["ye_ast_callers", { targets: [{ file: "src/Order.java", symbol: "Order" }], workspace: { repos } }],
    ["ye_ast_impact", { base: "main", workspace: { repos } }],
  ] as const;
  for (const [name, args] of requests) {
    const refused = await session.callTool(name, args).catch((error: Error) => error);
    assert.equal(refused instanceof Error || (refused as { isError?: boolean }).isError === true, true, name);
  }
  assert.deepEqual([calls.workspaceReads, calls.decisions, calls.workspaceCallers, calls.workspaceOfChange], [[], [], [], []]);
  await session.close();
});

test("the decisions tool asks the decision family with the repositories and gateways given, and renders every decision with its options, the recommended one and the free text", async () => {
  const { session, calls } = await setup();

  const result = await session.callTool("ye_ast_decisions", { revision: "topic", repos: [{ path: "/work/shop-web", id: "shop-web" }], gateways: [{ prefix: "edge", repo: "shop" }], scope: { include: ["src/**"] } });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.decisions.map(({ repo, repos, gateways, scope }) => ({ repo, repos, gateways, scope })), [
    { repo: { path: REPOSITORY.path, id: REPOSITORY.repoId, revision: "topic" }, repos: [{ path: "/work/shop-web", id: "shop-web" }], gateways: [{ prefix: "edge", repo: "shop" }], scope: { include: ["src/**"] } },
  ]);
  assert.deepEqual(result.structuredContent, envelopeOf(decisionFact()));
  const text = textOf(result);
  assert.match(text, /^status: complete\n/);
  assert.match(text, /repositories \(1\): shop@a{40}/);
  assert.match(text, /decisions \(2\):/);
  assert.match(text, /\n {2}membership \(1\):\n {4}orders-api\n {6}evidence: shop-web:src\/app\/order\.api\.ts:7\n {6}- orders \(exact-name, recommended, shop-web:src\/app\/order\.api\.ts:7\)\n {6}- orders-core \(artifact\)\n {6}free text/);
  assert.match(text, /\n {2}repository \(1\):\n {4}geo\.example\.com\n {6}evidence: shop-web:src\/app\/geo\.api\.ts:11\n {6}free text/);
  await session.close();
});

test("the decisions tool reads the bound repository alone when no clones are passed, and a workspace with no gap says none", async () => {
  const { session, calls } = await setup({ decisions: async (request) => {
    calls.decisions.push(request);
    return { ok: true, value: { fact: decisionFact({ decisions: [], repositories: [], source: "none" }) } };
  } });

  const result = await session.callTool("ye_ast_decisions", {});

  assert.equal(calls.decisions[0]?.repos, undefined);
  assert.equal("gateways" in (calls.decisions[0] ?? {}), false);
  const text = textOf(result);
  assert.match(text, /status: complete/);
  assert.match(text, /^repositories declared by: nothing: this answer covers the bound repository alone/m);
  assert.match(text, /^decisions \(0\):$/m);
  assert.doesNotMatch(text, /\(none\)/);
  await session.close();
});

const DEPENDENCY_GAP: DecisionValue = {
  ...DECISIONS,
  decisions: [
    ...DECISIONS.decisions,
    { id: "repository:@angular/core", kind: "repository", subject: "@angular/core", evidence: [{ path: "package.json", line: 36, repo: "shop" }], outwardKinds: ["dependency"], options: [], allowsFreeText: true, required: false },
  ],
};

test("a workspace summary groups the outward names by kind and counts the dependency coordinates no repository serves", async () => {
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact() } }) });

  const text = textOf(await session.callTool("ye_ast_workspace", {}));

  assert.match(text, /^outward names \(4\):$/m);
  assert.match(text, / {2}shop:\n {4}path-prefix \(1\):\n {6}- orders-api \(src\/app\/order\.api\.ts:7\)\n {4}dependency \(3\): no repository given serves them; mode "details" lists them/);
  assert.match(text, /^no local repository serves \(4\): 3 dependency counted; mode "details" lists them/m);
  const namesLine = text.split("\n").find((line) => line.includes("dependency (3): no repository given serves")) ?? "";
  const unservedLine = text.split("\n").find((line) => line.startsWith("no local repository serves (4):")) ?? "";
  for (const line of [namesLine, unservedLine]) {
    assert.match(line, /mode "details"/);
    assert.match(line, /mode: "full"/);
  }
  assert.doesNotMatch(text, /- dependency @angular\/core/);
  await session.close();
});

test("a workspace full answer lists the dependency coordinates its summary counts", async () => {
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact() } }) });

  const text = textOf(await session.callTool("ye_ast_workspace", { mode: "details" }));

  assert.match(text, / {4}dependency \(3\):\n {6}- @angular\/core \(package\.json:36\)\n {6}- @capacitor\/core \(package\.json:49\)\n {6}- rxjs \(package\.json:74\)/);
  assert.match(text, /^no local repository serves \(4\): all recorded outward names are unserved; see shop above\.$/m);
  await session.close();
});

test("a workspace answer names each unresolved call site with its declaration, its transport and the request it writes", async () => {
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact() } }) });

  const text = textOf(await session.callTool("ye_ast_workspace", {}));

  assert.match(text, /^unresolved call sites \(1\):$/m);
  assert.match(text, / {2}shop:\n {4}src\/app\/order\.api\.ts\n {6}9-12 OrderApi\.create \(http\) GET \/orders/);
  assert.doesNotMatch(text, /\(the file itself\)/);
  assert.match(text, /cuts for repository shop:[\s\S]*unresolved-link \(1\)/);
  await session.close();
});

test("a decisions summary groups the gaps by kind and counts the free-text-only dependency gaps", async () => {
  const { session } = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact(DEPENDENCY_GAP) } }) });

  const text = textOf(await session.callTool("ye_ast_decisions", {}));

  assert.match(text, /^decisions \(3\):$/m);
  assert.match(text, / {2}repository \(2\): 1 dependency counted \(free text only\); mode "details" lists them/);
  assert.match(text, / {4}geo\.example\.com/);
  assert.doesNotMatch(text, /@angular\/core/);
  await session.close();
});

test("a decisions full answer lists the dependency gaps its summary counts", async () => {
  const { session } = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact(DEPENDENCY_GAP) } }) });

  const text = textOf(await session.callTool("ye_ast_decisions", { mode: "details" }));

  assert.match(text, / {4}@angular\/core\n {6}evidence: shop:package\.json:36\n {6}free text/);
  await session.close();
});

const REFRESH: WorkspaceRefresh = {
  resolution: [{ repo: "orders", asked: "main", step: "explicit", consulted: [{ branch: "main", sha: "c".repeat(40) }], sha: "c".repeat(40) }],
  freshness: [{ repo: "orders", url: "https://git.example.com/orders.git", freshness: { status: "verified" } }],
};

test("every workspace-bearing tool carries the freshness and the resolution beside the fact exactly when the read refreshed something", async () => {
  const plain = await setup();
  const refreshed = await setup(undefined, REFRESH);
  const tools: [string, Record<string, unknown>][] = [
    ["ye_ast_workspace", {}],
    ["ye_ast_decisions", {}],
    ["ye_ast_callers", { targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }], workspace: WORKSPACE }],
    ["ye_ast_impact", { base: "main", workspace: WORKSPACE }],
  ];

  for (const [name, args] of tools) {
    const before = (await plain.session.callTool(name, { ...args, mode: "full" })).structuredContent as Record<string, unknown>;
    const after = (await refreshed.session.callTool(name, { ...args, mode: "full" })).structuredContent as Record<string, unknown>;
    assert.equal("freshness" in before, false, `${name}: a read that refreshed nothing carries no freshness`);
    assert.equal("resolution" in before, false, `${name}: a read that refreshed nothing carries no resolution`);
    assert.deepEqual(after["freshness"], REFRESH.freshness, name);
    assert.deepEqual(after["resolution"], REFRESH.resolution, name);
    const { mode: afterMode, freshness: _freshness, resolution: _resolution, ...fact } = after;
    const { mode: beforeMode, ...plainFact } = before;
    assert.equal(afterMode, "full", name);
    assert.equal(beforeMode, "full", name);
    assert.deepEqual(fact, plainFact, `${name}: the fact is unchanged by the refresh`);
    for (const mode of ["summary", "details"] as const) {
      const response = await refreshed.session.callTool(name, { ...args, mode });
      const receipt = response.structuredContent as Record<string, unknown>;
      const { recovery: _recovery, ...plainReceipt } = receipt;
      assert.deepEqual(plainReceipt, { mode, status: after["status"], snapshot: after["snapshot"] }, name);
      assert.match(textOf(response), /remote: orders https:\/\/git\.example\.com\/orders\.git verified/, name);
      assert.match(textOf(response), /pinned: orders asked main by explicit/, name);
    }
  }

  await plain.session.close();
  await refreshed.session.close();
});

test("a refreshed answer opens its text with the remote it verified and the sha it pinned", async () => {
  const { session } = await setup(undefined, REFRESH);
  const text = textOf(await session.callTool("ye_ast_workspace", {}));
  assert.match(text, /^remote: orders https:\/\/git\.example\.com\/orders\.git verified$/m);
  assert.match(text, new RegExp(`^pinned: orders asked main by explicit -> ${"c".repeat(40)} \\(consulted main ${"c".repeat(40)}\\)$`, "m"));
  await session.close();
});

test("an unverified remote names why in the text, and a repository no step pinned says so", async () => {
  const refresh: WorkspaceRefresh = {
    resolution: [{ repo: "orders", asked: "release", step: "revision-unavailable", consulted: [{ branch: "release" }] }],
    freshness: [{ repo: "orders", url: "https://git.example.com/orders.git", freshness: { status: "unverified", reason: "deadline", detail: "listing exceeded the deadline" } }],
  };
  const { session } = await setup(undefined, refresh);
  const text = textOf(await session.callTool("ye_ast_workspace", {}));
  assert.match(text, /^remote: orders https:\/\/git\.example\.com\/orders\.git unverified \(deadline\): listing exceeded the deadline$/m);
  assert.match(text, /^pinned: orders asked release by revision-unavailable -> unpinned \(consulted release\)$/m);
  await session.close();
});

test("the sidecar is redacted with the composed redaction like every other value", async () => {
  const leaking: WorkspaceRefresh = {
    ...REFRESH,
    freshness: [{ repo: "orders", url: `https://user:${SECRET}@git.example.com/orders.git`, freshness: { status: "unverified", reason: "failed", detail: `fatal: ${SECRET}` } }],
  };
  const { session } = await setup({ outwardNames: async () => ({
    ok: true,
    value: { fact: workspaceFact(), refresh: leaking, repositoryRoots: [{ repo: "orders", path: `/clones/${SECRET}` }] },
  }) });

  const result = await session.callTool("ye_ast_workspace", { mode: "full" });

  const structured = JSON.stringify(result.structuredContent);
  assert.doesNotMatch(structured, new RegExp(SECRET));
  assert.match(structured, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  assert.doesNotMatch(textOf(result), new RegExp(SECRET));
  for (const mode of ["summary", "details"] as const) {
    const answer = await session.callTool("ye_ast_workspace", { mode });
    assert.deepEqual(answer.structuredContent, envelopeOf(workspaceFact(), mode));
    assert.ok(textOf(answer).includes(`https://user:${REDACTED}@git.example.com/orders.git`));
    assert.ok(textOf(answer).includes(`fatal: ${REDACTED}`));
    assert.ok(textOf(answer).includes(`/clones/${REDACTED}`));
    assert.doesNotMatch(textOf(answer), new RegExp(SECRET));
  }
  await session.close();
});

/** A counted summary is only a summary when counting costs no more than listing what it hides. Every renderer with a
 * counted block asserts through this, so the rule is inherited rather than re-argued. */
function assertCountedSummaryShorter(summary: string, full: string): void {
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
  assert.ok(bytes(summary) <= bytes(full), `summary is ${bytes(summary)} bytes against ${bytes(full)} for the full answer`);
}

test("the counted elision of a summary never renders longer than listing what it hides", async () => {
  const one = impactFact({
    value: {
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/a.ts", symbol: "A.seed", kind: "method", line: 1, depth: 0, confidence: 1, fanIn: 0 },
        { file: "src/a.ts", symbol: "A.other", kind: "method", line: 4, depth: 1, confidence: 1, fanIn: 0 },
        { file: "src/a.ts", symbol: "A.deep", kind: "method", line: 40, depth: 4, confidence: 1, fanIn: 0 },
      ],
      entrypoints: [],
      cost: { expansionsUsed: 1 },
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: one }) });
  const summary = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  const full = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" }));
  assertCountedSummaryShorter(summary, full);
  await session.close();
});

test("workspace summary retains its counted elision and decisions summary remains shorter", async () => {
  const workspace = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact() } }) });
  assert.match(textOf(await workspace.session.callTool("ye_ast_workspace", {})), /dependency \(3\): no repository given serves/);
  await workspace.session.close();

  const decisions = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact(DEPENDENCY_GAP) } }) });
  assertCountedSummaryShorter(textOf(await decisions.session.callTool("ye_ast_decisions", {})), textOf(await decisions.session.callTool("ye_ast_decisions", { mode: "details" })));
  await decisions.session.close();
});

test("decision text and structured full retain each evidence repository", async () => {
  const evidence = [{ repo: "caller", path: "src/app.ts", line: 7 }, { repo: "server", path: "src/app.ts", line: 7 }];
  const decision = { ...DECISIONS.decisions[0]!, evidence, options: [{ value: "server", evidence, recommended: true }] };
  const { session } = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact({ ...DECISIONS, decisions: [decision] }) } }) });
  const result = await session.callTool("ye_ast_decisions", { mode: "full" });
  const text = textOf(await session.callTool("ye_ast_decisions", { mode: "details" }));
  assert.match(text, /caller:src\/app\.ts:7/);
  assert.match(text, /server:src\/app\.ts:7/);
  const structured = result.structuredContent as { value: DecisionValue };
  assert.deepEqual(structured.value.decisions[0]?.evidence, evidence);
  await session.close();
});

test("impact text presents consequences before seeds", async () => {
  const { session } = await setup();
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" }));
  const positions = ["changed entrypoints (", "reached entrypoints (", "impacted symbols (", "seeds ("].map((label) => text.indexOf(label));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, positions.toSorted((a, b) => a - b));
  await session.close();
});

test("workspace impact text presents every repository's consequences before any walk's seeds", async () => {
  const built = workspaceImpactFact();
  assert.notEqual(built.status, "unknown");
  if (built.status === "unknown") return;
  const consumer = (repo: string): Fact<RepoImpact> => ({
    ...base({ snapshot: { repo, kind: "sha", sha: "c".repeat(40) } }),
    status: "complete",
    value: {
      reads: [],
      impact: { ...IMPACT, seeds: [{ file: "src/api.ts", symbol: `${repo}.send`, line: 5, basis: "requested" }] },
      callSites: [{ ...SITE, repo }],
      unmatched: [],
      external: [],
    },
  });
  const fact: Fact<WorkspaceImpactValue> = {
    ...built,
    status: "partial",
    value: {
      ...built.value,
      workspace: { ...built.value.workspace, repos: ["shop", "shop-mobile", "shop-web"] },
      sections: { ...built.value.sections, "shop-mobile": consumer("shop-mobile"), "shop-web": consumer("shop-web") },
    },
    cuts: [{ kind: "no-extractor", at: ["src/unknown.swift"] }],
  };
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact } }) });
  for (const detail of ["summary", "details"] as const) {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, mode: detail }));
    const consequences = [...text.matchAll(/^\s*(?:changed entrypoints|reached entrypoints|impacted symbols|call sites that land in what the walk reached|links across repositories) \(/gm)].map((match) => match.index);
    const seeds = [...text.matchAll(/^\s*seeds \(/gm)].map((match) => match.index);
    assert.equal(seeds.length, 3);
    assert.ok(Math.max(...consequences) < Math.min(...seeds), text);
    assert.ok(text.indexOf("per repository:") < Math.min(...seeds));
    assert.ok(text.lastIndexOf("no-extractor (") > Math.max(...seeds));
    assert.match(text, /shop-mobile/);
    assert.match(text, /shop-web/);
  }
  await session.close();
});

test("workspace impact text names an unknown contributing read beside independent discovery cuts", async () => {
  const built = workspaceImpactFact();
  assert.notEqual(built.status, "unknown");
  if (built.status === "unknown") return;
  const cuts: [Cut] = [{ kind: "not-exported", at: ["src/omitted.ts"] }];
  const section: Fact<RepoImpact> = {
    ...base(),
    status: "partial",
    cuts,
    value: {
      reads: [
        { kind: "discovery", fact: { ...base(), status: "partial", cuts: [cuts[0]!] } },
        { kind: "trigger", fact: { ...base(), status: "unknown", reason: "index-unavailable" } },
      ],
      callSites: [], unmatched: [], external: [],
    },
  };
  const fact: Fact<WorkspaceImpactValue> = { ...built, status: "partial", cuts: [{ kind: "section", at: ["shop"] }], value: { ...built.value, sections: { shop: section } } };
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact } }) });
  for (const detail of ["summary", "details"] as const) {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, mode: detail }));
    assert.match(text, /shop: partial[\s\S]*trigger: unknown \(index-unavailable\)/);
    assert.match(text, /not-exported/);
    if (detail === "details") assert.match(text, /src\/omitted\.ts/);
  }
  await session.close();
});


test("impact detail retains a selected origin association while both text modes preserve the full structured fact", async () => {
  const seeds: ImpactValue["seeds"] = [
    { file: "src/unrelated/unrelated.service.ts", symbol: "Unrelated", line: 3, basis: "top-level" },
    { file: "src/services/checkout.service.ts", symbol: "checkout", line: 12, endLine: 20, basis: "lines" },
    { file: "src/pages/checkout.component.ts", symbol: "Checkout", line: 30, endLine: 45, basis: "resource" },
  ];
  const fact = impactFact({ value: {
    ...IMPACT,
    seeds,
    entrypoints: [{ ...IMPACT.entrypoints[0]!, seeds: [2, 1] }],
  } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const summary = await session.callTool("ye_ast_impact", { base: "main" });
  const full = await session.callTool("ye_ast_impact", { base: "main", mode: "details" });
  const structured = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
  assert.deepEqual(withoutRecovery(structured.structuredContent), { ...fact, mode: "full", repositoryRoots: [{ repo: "shop", path: REPOSITORY.path }] });
  assert.doesNotMatch(textOf(summary), /one verified origin/);
  assert.match(textOf(full), /one verified origin: src\/pages\/checkout\.component\.ts:30-45 Checkout \(resource\)/);
  assert.match(textOf(full), /1 other origin/);
  assert.match(textOf(full), /mode: "full" (?:includes|has) all.*origin/);
  assert.doesNotMatch(textOf(summary), /src\/unrelated\/unrelated\.service\.ts/);
  assert.doesNotMatch(textOf(full), /src\/unrelated\/unrelated\.service\.ts/);
  await session.close();
});

test("impact revision errors explain which selectors to correct without inventing a successful result", async () => {
  const fault = { kind: "unknown-revision" as const, detail: "base does not resolve to a commit" };
  const { session } = await setup({ ofChange: async () => ({ ok: false, fault }) });
  try {
    const result = await session.callTool("ye_ast_impact", { base: "missing" });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("base/head") && textOf(result).includes("workspace") && textOf(result).includes("local commit"));
    assert.deepEqual(result._meta?.["ye-ast/fault"], fault);
    assert.equal(result.structuredContent, undefined);
  } finally { await session.close(); }
});

test("impact live trust errors offer a committed alternative and leave trust to the user", async () => {
  const fault = { kind: "live-requires-trusted" as const, detail: "live snapshot unavailable without declared trust" };
  const { session } = await setup({ ofChange: async () => ({ ok: false, fault }) });
  try {
    const result = await session.callTool("ye_ast_impact", { base: "main", live: true });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("Omit live") && textOf(result).includes("committed") && textOf(result).includes("user"));
    assert.deepEqual(result._meta?.["ye-ast/fault"], fault);
  } finally { await session.close(); }
});

test("full family guides locate recorded data without repeating listings", async () => {
  const { session } = await setup();
  try {
    const cases: [string, Record<string, unknown>, RegExp[], RegExp][] = [
      ["ye_ast_entrypoints", {}, [/value\.entrypoints\.status/, /value\.entrypoints\.value/, /handler|component/], /GET \/orders\/\{id\}/],
      ["ye_ast_importers", { files: ["src/OrderService.java"] }, [/value\.files/, /importers/, /unresolvedNamers/, /line/], /src\/OrderController\.java/],
      ["ye_ast_outline", { files: ["src/Order.java"] }, [/value\.files/, /declarations/, /line/, /value\.unheld/], /Order\.java.*total/s],
      ["ye_ast_workspace", {}, [/value\.sections/, /value\.repositorySnapshots/, /value\.candidates/, /basis/], /orders-api ->/],
      ["ye_ast_decisions", {}, [/value\.decisions/, /subject/, /options/, /evidence/], /geo\.example\.com/],
    ];
    for (const [name, args, expected, listing] of cases) {
      const result = await session.callTool(name, { ...args, mode: "full" });
      assert.notEqual(result.isError, true, name);
      const text = textOf(result);
      for (const pattern of expected) assert.match(text, pattern, name);
      assert.doesNotMatch(text, listing, name);
      assert.doesNotMatch(text, /request.*mode: "full"/i, name);
    }
  } finally { await session.close(); }
});

test("direct details for path-only importers keeps associations without invented line locations", async () => {
  const { session } = await setup();
  try {
    const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], mode: "details" });
    const text = textOf(result);
    assert.match(text, /src\/OrderService\.java/);
    assert.match(text, /src\/OrderController\.java/);
    assert.match(text, /path-only|paths only/i);
    assert.doesNotMatch(text, /src\/OrderController\.java:\d/);
  } finally { await session.close(); }
});

test("small resolved impact details identify association without forcing JSON navigation", async () => {
  const small = impactFact({ value: { ...IMPACT, changedEntrypoints: [], symbols: [], seeds: [IMPACT.seeds[0]!], entrypoints: [{ ...IMPACT.entrypoints[0]!, seeds: [0] }] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: small }) });
  try {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "details" }));
    assert.match(text, /one verified origin/);
    assert.match(text, /association.*not.*(?:call chain|dependency chain)/i);
    assert.doesNotMatch(text, /Investigation guide:|Full JSON navigation|ye_ast_callers/);
  } finally { await session.close(); }
});

test("workspace downstream links identify invoked destinations without calling them affected consumers", async () => {
  const fact = workspaceImpactFact();
  if (fact.status === "unknown") throw new Error("expected workspace fact");
  const link = fact.value.links[0]!;
  const withDownstream: Fact<WorkspaceImpactValue> = { ...fact, value: { ...fact.value, links: [{ ...link, direction: "downstream" }] } };
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact: withDownstream } }) });
  try {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, mode: "details" }));
    assert.match(text, /downstream/);
    assert.match(text, /destination.*not.*(?:affected|change)/i);
    assert.match(text, /route-overlap/);
  } finally { await session.close(); }
});

test("entrypoint summary distinguishes known and unknown findings while preserving coordinates", async () => {
  const section = { ...base(), status: "complete" as const, value: [
    { status: "complete" as const, value: ROUTE, evidence: [{ path: "src/OrderController.java", line: 17 }] },
    { status: "unknown" as const, reason: "unresolved" as const, evidence: [{ path: "src/other.java", line: 5 }] },
  ] };
  const fact: EntrypointMapFact = { ...base(), status: "complete", value: { entrypoints: section } };
  const { session } = await setup({ map: async () => ({ ok: true, value: fact }) });
  try {
    const text = textOf(await session.callTool("ye_ast_entrypoints", {}));
    assert.match(text, /1 known.*1 unknown/);
    assert.match(text, /src\/OrderController\.java:17/);
    assert.match(text, /unknown \(unresolved\).*src\/other\.java:5/);
  } finally { await session.close(); }
});

test("workspace details preserve same-path ownership and snapshots without unsupported foreign targeting", async () => {
  const original = workspaceImpactFact();
  if (original.status === "unknown") throw new Error("expected workspace fact");
  const section = (repo: string, sha: string): Fact<RepoImpact> => ({
    ...base({ snapshot: { repo, kind: "sha", sha } }), status: "complete",
    value: { reads: [], impact: { ...IMPACT, seeds: [{ file: "src/shared.ts", symbol: `${repo}.seed`, line: 3, basis: "requested" }], symbols: [], entrypoints: [] }, callSites: [], unmatched: [], external: [] },
  });
  const fact: Fact<WorkspaceImpactValue> = { ...original, value: { ...original.value, repositorySnapshots: [
    { repo: "shop", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) } },
    { repo: "shop-web", snapshot: { repo: "shop-web", kind: "sha", sha: "c".repeat(40) } },
  ], sections: { shop: section("shop", "a".repeat(40)), "shop-web": section("shop-web", "c".repeat(40)) }, links: [] } };
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact } }) });
  try {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, mode: "details" }));
    assert.match(text, /shop@a{40}/);
    assert.match(text, /shop-web@c{40}/);
    assert.match(text, /shop:[\s\S]*src\/shared\.ts[\s\S]*shop\.seed/);
    assert.match(text, /shop-web:[\s\S]*src\/shared\.ts[\s\S]*shop-web\.seed/);
    assert.match(text, /choose the recorded owner with repo/);
    assert.match(text, /instance bound to that clone/);
  } finally { await session.close(); }
});

test("entrypoint details group identical recorded evidence while retaining each handler", async () => {
  const evidence = [{ path: "src/router.ts", line: 18, via: "declared-route", confidence: 0.7 }];
  const routes = Array.from({ length: 8 }, (_, i) => ({ status: "complete" as const, value: { ...ROUTE, name: `GET /route-${i}` }, evidence }));
  const section = { ...base(), status: "complete" as const, value: routes };
  const map: EntrypointMapFact = { ...base(), status: "complete", value: { entrypoints: section } };
  const { session } = await setup({ map: async () => ({ ok: true, value: map }) });
  try {
    const text = textOf(await session.callTool("ye_ast_entrypoints", { mode: "details" }));
    assert.match(text, /src\/router\.ts:18/);
    assert.match(text, /declared-route/);
    assert.match(text, /confidence 0\.7/);
    assert.equal(text.split("src/router.ts:18").length - 1, 1);
    assert.match(text, /GET \/route-0/);
    assert.match(text, /GET \/route-7/);
    assert.match(text, /src\/OrderController\.java:17/);
  } finally { await session.close(); }
});

test("entrypoint summary groups repeated handler coordinates without dropping routes", async () => {
  const routes = Array.from({ length: 8 }, (_, i) => ({ status: "complete" as const, value: { ...ROUTE, name: `GET /route-${i}` }, evidence: [] }));
  const section = { ...base(), status: "complete" as const, value: routes };
  const map: EntrypointMapFact = { ...base(), status: "complete", value: { entrypoints: section } };
  const { session } = await setup({ map: async () => ({ ok: true, value: map }) });
  try {
    const text = textOf(await session.callTool("ye_ast_entrypoints", {}));
    assert.match(text, /GET \/route-0/);
    assert.match(text, /GET \/route-7/);
    assert.equal(text.split("src/OrderController.java:17").length - 1, 1);
  } finally { await session.close(); }
});

test("entrypoint modes expose unknown base path and retain recorded context for a route", async () => {
  const { session } = await setup();
  try {
    const summary = textOf(await session.callTool("ye_ast_entrypoints", {}));
    const detail = textOf(await session.callTool("ye_ast_entrypoints", { mode: "details" }));
    assert.match(summary, /base path.*unknown/i);
    assert.match(detail, /base path.*unknown.*unresolved/i);
    const full = textOf(await session.callTool("ye_ast_entrypoints", { mode: "full" }));
    assert.match(full, /basePath/);
  } finally { await session.close(); }
});

test("workspace details attribute repository-local cuts to the owning snapshot", async () => {
  const original = workspaceFact();
  if (original.status === "unknown") throw new Error("expected workspace fact");
  const section = original.value.sections.shop!;
  if (section.status === "unknown") throw new Error("expected section");
  const copy = { ...section, snapshot: { repo: "other", kind: "sha" as const, sha: "c".repeat(40) }, cuts: [{ kind: "no-extractor" as const, at: ["src/same.ts"] }] as const, status: "partial" as const };
  const fact: Fact<WorkspaceValue> = { ...original, value: { ...original.value, workspace: { ...original.value.workspace, repos: ["shop", "other"] }, repositorySnapshots: [...original.value.repositorySnapshots, { repo: "other", snapshot: copy.snapshot }], sections: { shop: section, other: copy } } };
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact } }) });
  try {
    const text = textOf(await session.callTool("ye_ast_workspace", { mode: "details" }));
    assert.match(text, /other@c{40}/);
    assert.match(text, /cuts for repository other:[\s\S]*no-extractor.*src\/same\.ts/);
  } finally { await session.close(); }
});

test("callers direct details and full retain requested target and explain dependency navigation", async () => {
  const resultFact = impactFact({ value: { ...IMPACT,
    seeds: [{ file: "src/OrderService.java", symbol: "OrderService.find", line: 31, basis: "requested" }],
    symbols: [{ file: "src/OrderController.java", symbol: "OrderController.one", kind: "method", line: 17, depth: 1, confidence: 0.75, fanIn: 1, via: { file: "src/OrderService.java", symbol: "OrderService.find", lines: [44], basis: "call" } }],
  } } as Partial<Fact<ImpactValue>>);
  const { session, calls } = await setup({ callers: async () => ({ ok: true, value: resultFact }) });
  const args = { targets: [{ file: "src/OrderService.java", symbol: "OrderService.find" }] };
  try {
    const detail = textOf(await session.callTool("ye_ast_callers", { ...args, mode: "details" }));
    assert.match(detail, /OrderService\.find/);
    assert.match(detail, /OrderController\.one[^\n]*via.*OrderService\.find at 44/);
    const full = await session.callTool("ye_ast_callers", { ...args, mode: "full" });
    assert.match(textOf(full), /value\.symbols/);
    assert.match(textOf(full), /via\.lines/);
    assert.doesNotMatch(textOf(full), /impacted symbols \(1\):/);
    assert.deepEqual(calls.callers[0], calls.callers[1]);
    assert.equal("mode" in (calls.callers[0] ?? {}), false);
  } finally { await session.close(); }
});

test("UI route guard details preserve each route's own guards and summary offers exact recovery", async () => {
  const component = { path: "src/Page.ts", symbol: "Page", line: 12 };
  const uiRoutes: Entrypoint[] = [
    { kind: "ui-route", name: "/private", path: "/private", component, guards: [{ name: "SessionGuard", path: "src/SessionGuard.ts" }] },
    { kind: "ui-route", name: "/partner", path: "/partner", component, guards: [{ name: "PartnerGuard", external: true }] },
    { kind: "ui-route", name: "/unknown", path: "/unknown", component: "unknown", guards: [{ name: "(inline)" }] },
    { kind: "ui-route", name: "/public", path: "/public", component, guards: [] },
  ];
  const evidence = [{ path: "src/router.ts", line: 18 }];
  const section = { ...base(), status: "complete" as const, value: uiRoutes.map((value) => ({ status: "complete" as const, value, evidence })) };
  const map: EntrypointMapFact = { ...base(), status: "complete", value: { entrypoints: section } };
  const { session } = await setup({ map: async () => ({ ok: true, value: map }) });
  try {
    const summary = textOf(await session.callTool("ye_ast_entrypoints", {}));
    assert.match(summary, /3 (?:own |declared )?guards/i);
    assert.match(summary, /mode: "full"/);
    assert.match(summary, /value\.entrypoints\.value\[\]\.value\.guards/);
    assert.match(summary, /kind.*name/i);
    assert.doesNotMatch(summary, /unguarded|unprotected/i);
    const details = textOf(await session.callTool("ye_ast_entrypoints", { mode: "details" }));
    const privateContext = details.split("ui-route /private:")[1]?.split("ui-route /partner:")[0] ?? "";
    const partnerContext = details.split("ui-route /partner:")[1]?.split("ui-route /unknown:")[0] ?? "";
    const unknownContext = details.split("ui-route /unknown:")[1]?.split("ui-route /public:")[0] ?? "";
    const publicContext = details.split("ui-route /public:")[1] ?? "";
    assert.match(privateContext, /SessionGuard[^\n]*src\/SessionGuard\.ts/);
    assert.doesNotMatch(privateContext, /PartnerGuard/);
    assert.match(partnerContext, /PartnerGuard[^\n]*external/);
    assert.doesNotMatch(partnerContext, /SessionGuard/);
    assert.match(unknownContext, /\(inline\)/);
    assert.match(publicContext, /(?:0 own guards|no own guards)/i);
    assert.doesNotMatch(publicContext, /SessionGuard|PartnerGuard/);
    assert.match(details, /component unknown/);
    assert.match(details, /inherited.*(?:not|unknown)/i);
    assert.doesNotMatch(details, /unguarded|unprotected/i);
    const full = textOf(await session.callTool("ye_ast_entrypoints", { mode: "full" }));
    assert.match(full, /value\.entrypoints\.value\[\]\.value\.guards/);
    assert.match(full, /kind.*name/i);
  } finally { await session.close(); }
});

test("full impact guides changed-entrypoint-only result without declaring it empty", async () => {
  const fact = impactFact({ value: { ...IMPACT, seeds: [], symbols: [], entrypoints: [], modules: undefined } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  try {
    const result = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
    assert.notEqual(result.isError, true);
    const value = (result.structuredContent as { value: ImpactValue }).value;
    assert.equal(value.changedEntrypoints?.length, 1);
    assert.deepEqual([value.seeds, value.symbols, value.entrypoints], [[], [], []]);
    assert.equal(value.modules, undefined);
    assert.match(textOf(result), /value\.changedEntrypoints/);
    assert.match(textOf(result), /change.*kind\/name.*handler/i);
    assert.doesNotMatch(textOf(result), /no recorded consequences/);
    assert.doesNotMatch(textOf(result), /changed entrypoints \(1\):/);
  } finally { await session.close(); }
});


test("declared selector routes each local and workspace branch and preserves relative subjects", async () => {
  const foreign = { path: "/work/foreign", repoId: "foreign" };
  const { session, calls } = await setup({}, undefined, [foreign]);
  try {
    const target = [{ file: "src/shared.ts", symbol: "Shared.f" }];
    for (const [name, args] of [
      ["ye_ast_entrypoints", {}], ["ye_ast_impact", { base: "main" }],
      ["ye_ast_callers", { targets: target }], ["ye_ast_importers", { files: ["src/shared.ts"] }],
      ["ye_ast_outline", { files: ["src/shared.ts"] }], ["ye_ast_workspace", {}],
      ["ye_ast_decisions", {}], ["ye_ast_impact", { base: "main", workspace: {} }],
      ["ye_ast_callers", { targets: target, workspace: {} }],
    ] as [string, Record<string, unknown>][]) {
      const result = await session.callTool(name, { ...args, repo: "foreign", mode: "full" });
      assert.notEqual(result.isError, true, name);
      const content = result.structuredContent as { snapshot: { repo: string }; repositoryRoots?: unknown };
      assert.equal(content.snapshot.repo, "foreign", name);
      if (["ye_ast_entrypoints", "ye_ast_importers", "ye_ast_outline"].includes(name) || ((name === "ye_ast_impact" || name === "ye_ast_callers") && !("workspace" in args))) {
        assert.deepEqual(content.repositoryRoots, [{ repo: "foreign", path: foreign.path }], name);
      } else {
        assert.equal(content.repositoryRoots, undefined, name);
      }
    }
    for (const request of [calls.map[0], calls.ofChange[0], calls.callers[0], calls.importers[0], calls.outline[0]]) {
      assert.equal(request?.repo, foreign.path);
      assert.equal(request?.repoId, foreign.repoId);
    }
    for (const request of [calls.workspaceReads[0], calls.decisions[0], calls.workspaceOfChange[0], calls.workspaceCallers[0]]) {
      assert.equal(request?.repo.path, foreign.path);
      assert.equal(request?.repo.id, foreign.repoId);
      assert.equal(request?.repos, undefined);
    }
    assert.deepEqual(calls.callers[0]?.targets, target);
    assert.deepEqual(calls.importers[0]?.files, ["src/shared.ts"]);
    await session.callTool("ye_ast_outline", { files: ["src/shared.ts"] });
    assert.equal(calls.outline[1]?.repo, REPOSITORY.path);
    assert.deepEqual(calls.outline[1]?.files, calls.outline[0]?.files);
  } finally { await session.close(); }
});

test("selector discovery, schema and runtime reject empty and unknown IDs without queries", async () => {
  const { session, calls } = await setup({}, undefined, [{ path: "/work/z", repoId: "z" }, { path: "/work/a", repoId: "constructor" }, { path: "/work/proto", repoId: "__proto__" }]);
  try {
    assert.match(session.instructions!, /__proto__.*constructor.*shop.*z/s);
    for (const [name, args] of TOOL_CALLS) {
      const schema = (await session.listTools()).find((tool) => tool.name === name)!.inputSchema;
      const validate = new AjvJsonSchemaValidator().getValidator(schema);
      assert.equal(validate({ ...args, repo: "" }).valid, false, name);
      assert.equal(validate({ ...args, repo: "constructor" }).valid, true, name);
      for (const id of ["", "missing", "Shop", "/work/z"]) {
        const result = await session.callTool(name, { ...args, repo: id });
        assert.equal(result.isError, true, `${name} ${id}`);
        assert.equal(result.structuredContent, undefined);
      }
    }
    assert.equal(Object.values(calls).flat().length, 0);
    const result = await session.callTool("ye_ast_entrypoints", { repo: "constructor" });
    assert.notEqual(result.isError, true);
    assert.equal(calls.map[0]?.repo, "/work/a");
    const proto = await session.callTool("ye_ast_entrypoints", { repo: "__proto__" });
    assert.notEqual(proto.isError, true);
    assert.equal(calls.map[1]?.repo, "/work/proto");
  } finally { await session.close(); }
});

test("selected local root is redacted and a mismatching primary snapshot fails", async () => {
  const foreign = { path: `/work/${SECRET}`, repoId: "foreign" };
  const { session } = await setup({}, undefined, [foreign, { path: "/work/other", repoId: "other" }]);
  try {
    const result = await session.callTool("ye_ast_outline", { repo: "foreign", files: ["src/shared.ts"], mode: "full" });
    assert.deepEqual((result.structuredContent as { repositoryRoots: unknown }).repositoryRoots, [{ repo: "foreign", path: `/work/${REDACTED}` }]);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes("/work/other"), false);
  } finally { await session.close(); }
  const bad = await setup({ map: async () => ({ ok: true, value: mapFact() }) }, undefined, [foreign]);
  try {
    const result = await bad.session.callTool("ye_ast_entrypoints", { repo: "foreign", mode: "full" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.ok(result._meta?.["ye-ast/fault"]);
  } finally { await bad.session.close(); }
});

test("selected live queries retain trust faults", async () => {
  const { session, calls } = await setup({ map: async () => ({ ok: false, fault: { kind: "live-requires-trusted", detail: "trust required" } }) }, undefined, [{ path: "/work/foreign", repoId: "foreign" }]);
  try {
    const result = await session.callTool("ye_ast_entrypoints", { repo: "foreign", live: true });
    assert.equal(result.isError, true);
    assert.equal((result._meta?.["ye-ast/fault"] as { kind: string }).kind, "live-requires-trusted");
    assert.equal(calls.map[0]?.repo, "/work/foreign");
  } finally { await session.close(); }
});


test("invalid catalogs fail server creation and exact duplicates coalesce", async () => {
  for (const bindings of [
    [{ path: "/work/other", repoId: "shop" }],
    [{ path: REPOSITORY.path, repoId: "other" }],
    [{ path: "", repoId: "other" }],
  ]) await assert.rejects(setup({}, undefined, bindings));
  const { session } = await setup({}, undefined, [REPOSITORY, { ...REPOSITORY }]);
  try {
    const result = await session.callTool("ye_ast_entrypoints", { repo: "shop" });
    assert.notEqual(result.isError, true);
  } finally { await session.close(); }
});

test("unknown selector fault is redacted with sorted IDs and no fact", async () => {
  const { session, calls } = await setup({}, undefined, [{ path: "/work/z", repoId: "z" }, { path: "/work/a", repoId: "a" }]);
  try {
    const result = await session.callTool("ye_ast_entrypoints", { repo: SECRET });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.deepEqual(result._meta?.["ye-ast/fault"], { kind: "unknown-repository", detail: `Repository ID ${REDACTED} is not declared`, repository: REDACTED, available: ["a", "shop", "z"] });
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(calls.map.length, 0);
  } finally { await session.close(); }
});

test("cancellation reaches a selected foreign query", async () => {
  let started!: (signal: AbortSignal) => void;
  let stopped!: () => void;
  const running = new Promise<AbortSignal>((resolve) => { started = resolve; });
  const aborted = new Promise<void>((resolve) => { stopped = resolve; });
  const { session, calls } = await setup({ map: (request) => new Promise((resolve) => {
    started(request.signal!);
    request.signal!.addEventListener("abort", () => { stopped(); resolve({ ok: false, fault: { kind: "aborted", detail: "stopped" } }); });
  }) }, undefined, [{ path: "/work/foreign", repoId: "foreign" }]);
  try {
    const call = session.startCall("ye_ast_entrypoints", { repo: "foreign" });
    assert.equal((await running).aborted, false);
    assert.equal(calls.map[0]?.repo, "/work/foreign");
    await session.cancel(call.id);
    await aborted;
  } finally { await session.close(); }
});


test("initialize redacts secrets in catalog IDs and launch paths", async () => {
  const { session } = await setup({}, undefined, [{ path: `/work/extra`, repoId: SECRET }], { path: `/work/${SECRET}`, repoId: "launch" });
  try {
    assert.equal(session.instructions?.includes(SECRET), false);
    assert.ok(session.instructions?.includes(REDACTED));
  } finally { await session.close(); }
});

test("workspace follow-up guidance uses the destination owner and its recorded snapshot", async () => {
  const fact = workspaceImpactFact();
  if (fact.status === "unknown") throw new Error("expected workspace fact");
  const link = fact.value.links[0]!;
  const foreign = { ...fact, value: { ...fact.value, links: [{ ...link, link: { ...link.link, to: { ...link.link.to, repo: "foreign" } } }], repositorySnapshots: [{ repo: "foreign", snapshot: { repo: "foreign", kind: "sha" as const, sha: "c".repeat(40) } }] } };
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact: foreign } }) }, undefined, [{ path: "/foreign", repoId: "foreign" }]);
  try {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: {}, mode: "full" }));
    assert.match(text, /foreign[^\n]*c{40}[^\n]*src\/OrderController\.java/);
    assert.match(text, /revision/);
  } finally { await session.close(); }
});

test("base module and fresh live guidance retain their own identities", async () => {
  const fact = impactFact({ value: { ...IMPACT, modules: { origins: [], modules: [{ file: "src/old.ts", snapshot: "base", depth: 0, origins: [] }], cost: { expansionsUsed: 0 } } } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  try {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", mode: "full" }));
    assert.match(text, /Base module: repo "shop", the base recorded below, file "src\/old\.ts"/);
    assert.match(text, /head "a{40}" and base "b{40}"/);
  } finally { await session.close(); }
  let stateId = "old-state";
  const second = await setup({ ofChange: async () => ({ ok: true, value: impactFact({ snapshot: { repo: "shop", kind: "live", head: "d".repeat(40), stateId } }) }) });
  try {
    const previous = await second.session.callTool("ye_ast_impact", { base: "main", live: true, mode: "full" });
    stateId = "new-state";
    const fresh = await second.session.callTool("ye_ast_impact", { base: "main", live: true, mode: "full" });
    assert.equal((previous.structuredContent as { snapshot: { stateId: string } }).snapshot.stateId, "old-state");
    assert.equal((fresh.structuredContent as { snapshot: { stateId: string } }).snapshot.stateId, "new-state");
    const text = textOf(fresh);
    assert.match(text, /fresh[^\n]*live/i);
    assert.match(text, /compare.*head and stateId/i);
  } finally { await second.session.close(); }
});

test("workspace base modules navigate to the trigger merge base instead of head", async () => {
  const fact = workspaceImpactFact();
  assert.notEqual(fact.status, "unknown");
  if (fact.status === "unknown") throw new Error("expected workspace fact");
  const trigger = fact.value.sections.shop;
  assert.ok(trigger && trigger.status !== "unknown" && trigger.value.impact);
  trigger.value.impact.modules = {
    origins: [],
    modules: [{ file: "src/removed.ts", snapshot: "base", depth: 0, origins: [] }],
    cost: { expansionsUsed: 0 },
  };
  fact.value.repositorySnapshots = [{ repo: "shop", snapshot: fact.snapshot }];
  const { session } = await setup({ workspaceOfChange: async () => ({ ok: true, value: { fact } }) });
  try {
    for (const mode of ["summary", "details", "full"]) {
      const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: {}, mode }));
      assert.match(text, /Base module: repo "shop", revision "b{40}", file "src\/removed\.ts"/);
      assert.doesNotMatch(text, /Base module:[^\n]*a{40}/);
    }
  } finally { await session.close(); }
});

test("callers recovery returns a pinned recipe in every response mode", async () => {
  const targets = [{ file: "src/A.java", symbol: "A.f" }];
  const { session } = await setup({ callers: async () => ({ ok: true, value: impactFact({ inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } }) }) });
  try {
    const recoveries = [];
    for (const mode of ["summary", "details", "full"]) {
      const answer = await session.callTool("ye_ast_callers", { targets, mode });
      recoveries.push((answer.structuredContent as Record<string, unknown>).recovery);
    }
    assert.deepEqual(recoveries[0], recoveries[1]);
    assert.deepEqual(recoveries[1], recoveries[2]);
    const recovery = recoveries[0] as { status: string; query: { name: string; arguments: Record<string, unknown> } };
    assert.equal(recovery.status, "available");
    assert.deepEqual(recovery.query, { name: "ye_ast_callers", arguments: { repo: "shop", revision: "a".repeat(40), targets } });
    const again = await session.callTool(recovery.query.name, recovery.query.arguments);
    assert.deepEqual((again.structuredContent as Record<string, unknown>).recovery, recovery);
  } finally { await session.close(); }
});

test("workspace callers recovery forwards actual replay and preserves omitted workspace defaults", async () => {
  const targets = [{ file: "src/A.java", symbol: "A.f" }];
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: "a".repeat(40) }, { repo: "shop-web", kind: "sha" as const, sha: "b".repeat(40) }, { repo: "unknown", kind: "sha" as const, sha: "c".repeat(40) }] };
  const fact = workspaceImpactFact();
  if (fact.status === "unknown") throw new Error("expected workspace value");
  const recorded = { ...fact, value: { ...fact.value, workspace: { ...fact.value.workspace, source: "persisted" as const }, sections: { ...fact.value.sections, unknown: { ...base({ snapshot: replay.snapshots[2]! }), status: "unknown" as const, reason: "revision-unavailable" as const } } }, inputs: { ...fact.inputs, declaredConfig: { targets: ["src/A.java:A.f"], walk: { depth: 2 } } } };
  const { session, calls } = await setup({ workspaceCallers: async (request) => {
    if (request.replay && (request.replay.declaration !== replay.declaration || request.repo.revision !== replay.snapshots[0]!.sha)) return { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "mismatch" } };
    return { ok: true, value: { fact: recorded, workspaceReplay: replay, repositorySources: [{ repo: "shop-web", path: "/internal/mirror" }] } };
  } });
  try {
    const response = await session.callTool("ye_ast_callers", { targets, workspace: {}, budget: { depth: 2 }, mode: "full" });
    const recovery = (response.structuredContent as { recovery: { status: string; query: { name: string; arguments: Record<string, unknown> } } }).recovery;
    assert.equal(recovery.status, "available");
    assert.deepEqual(recovery.query.arguments, { repo: "shop", revision: "a".repeat(40), targets, budget: { depth: 2 }, workspace: {}, replay });
    assert.doesNotMatch(JSON.stringify(recovery), /internal\/mirror/);
    assert.equal((response.structuredContent as { value: WorkspaceImpactValue }).value.workspace.source, "persisted");
    const again = await session.callTool(recovery.query.name, recovery.query.arguments);
    assert.deepEqual((again.structuredContent as Record<string, unknown>).recovery, recovery);
    assert.deepEqual(calls.workspaceCallers[1]?.replay, replay);
    assert.equal(calls.workspaceCallers[1]?.repo.revision, "a".repeat(40));
    const explicit = await session.callTool("ye_ast_callers", { targets, workspace: WORKSPACE, offline: true });
    const explicitArgs = (explicit.structuredContent as { recovery: { query: { arguments: Record<string, unknown> } } }).recovery.query.arguments;
    assert.deepEqual(explicitArgs.workspace, WORKSPACE);
    assert.equal(explicitArgs.offline, true);
    const mismatch = await session.callTool("ye_ast_callers", { targets, workspace: {}, replay: { ...replay, declaration: `ws-r1:${"e".repeat(64)}` } });
    assert.equal(mismatch.isError, true);
    assert.equal(mismatch.structuredContent, undefined);
    assert.deepEqual(mismatch._meta?.["ye-ast/fault"], { kind: "result-changed", detail: "mismatch", stage: "workspace-replay" });
  } finally { await session.close(); }
});

test("callers input and full output schemas enforce replay and recovery shapes", async () => {
  const { session } = await setup();
  try {
    const tool = (await session.listTools()).find((item) => item.name === "ye_ast_callers")!;
    const input = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const output = new AjvJsonSchemaValidator().getValidator(CALLERS_OUTPUT['~standard'].jsonSchema.output({target:'draft-07'}));
    const targets = [{ file: "a", symbol: "f" }];
    const replay = { version: 1, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha", sha: "a".repeat(40) }] };
    assert.equal(input({ targets, workspace: {}, replay }).valid, true);
    assert.equal(input({ targets, replay }).valid, true);
    assert.equal(input({ targets, workspace: {}, replay: { ...replay, snapshots: [{ repo: "shop", kind: "live", sha: "a".repeat(40) }] } }).valid, false);
    assert.equal((await session.callTool("ye_ast_callers", { targets, replay })).isError, true);
    const result = await session.callTool("ye_ast_callers", { targets });
    const receipt = result.structuredContent as Record<string, unknown>;
    const valid = { ...receipt, recovery: { version: 1, status: "available", resultIdentity: `mcp-r1:${"f".repeat(64)}`, query: { name: "ye_ast_callers", arguments: { repo: "shop", revision: "a".repeat(40), targets } } } };
    for (const item of [valid, { ...valid, recovery: { ...valid.recovery, query: { ...valid.recovery.query, name: "ye_ast_impact" } } }, { ...valid, recovery: { ...valid.recovery, query: { ...valid.recovery.query, arguments: { ...valid.recovery.query.arguments, base: "main" } } } }]) {
      const expected = item === valid;
      assert.equal(CALLERS_OUTPUT.safeParse(item).success, expected);
      assert.equal(output(item).valid, expected);
    }
  } finally { await session.close(); }
});

test("callers recovery uses the live snapshot and recorded walk bounds", async () => {
  const targets = [{ file: "src/A.java", start: 2, end: 4 }];
  const fact = impactFact({ snapshot: { repo: "shop", kind: "live", head: "c".repeat(40), stateId: "live-state" }, inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:2-4"], walk: { depth: 3 } } } });
  const { session } = await setup({ callers: async () => ({ ok: true, value: fact }) });
  try {
    const response = await session.callTool("ye_ast_callers", { targets, live: true, budget: { depth: 3 } });
    const recovery = (response.structuredContent as { recovery: { query: { arguments: unknown } } }).recovery;
    assert.deepEqual(recovery.query.arguments, { repo: "shop", live: true, targets, budget: { depth: 3 } });
    assert.equal(CALLERS_OUTPUT.safeParse(response.structuredContent).success, true);
  } finally { await session.close(); }
});

test("impact recovery pins the recorded merge base and head in every mode", async () => {
  const { session, calls } = await setup({ ofChange: async (request) => {
    if (request.base !== "main" && (request.base !== "b".repeat(40) || request.head !== "a".repeat(40))) return { ok: false, fault: { kind: "unknown-revision", detail: "wrong pin" } };
    return { ok: true, value: impactFact() };
  } });
  try {
    const results = [];
    for (const mode of ["summary", "details", "full"]) {
      const result = await session.callTool("ye_ast_impact", { base: "main", head: "topic", mode });
      results.push((result.structuredContent as Record<string, unknown>).recovery);
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    const recovery = results[0] as { status: string; query: { name: string; arguments: Record<string, unknown> } };
    assert.equal(recovery.status, "available");
    assert.deepEqual(recovery.query, { name: "ye_ast_impact", arguments: { repo: "shop", base: "b".repeat(40), head: "a".repeat(40) } });
    const replay = await session.callTool(recovery.query.name, recovery.query.arguments);
    assert.deepEqual((replay.structuredContent as Record<string, unknown>).recovery, recovery);
    assert.equal(calls.ofChange[3]?.base, "b".repeat(40));
    assert.equal(calls.ofChange[3]?.head, "a".repeat(40));
  } finally { await session.close(); }
});

test("impact recovery requires a recorded merge base and uses recorded live selection", async () => {
  const unknown: Fact<ImpactValue> = { ...base(), status: "unknown", reason: "revision-unavailable" };
  let current: Fact<ImpactValue> = unknown;
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: current }) });
  try {
    const missing = await session.callTool("ye_ast_impact", { base: "b".repeat(40) });
    assert.deepEqual((missing.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "unresolved-context" });
    const { mergeBase: _mergeBase, ...withoutBase } = IMPACT;
    current = impactFact({ value: withoutBase });
    const noBase = await session.callTool("ye_ast_impact", { base: "b".repeat(40) });
    assert.deepEqual((noBase.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "unresolved-context" });
    current = impactFact({ snapshot: { repo: "shop", kind: "live", head: "c".repeat(40), stateId: "live-state" }, inputs: { ...base().inputs, declaredConfig: { changed: ["src/**"], walk: { depth: 2 } } } });
    const result = await session.callTool("ye_ast_impact", { base: "main", live: true, changed: ["src/**"], budget: { depth: 2 } });
    const recovery = (result.structuredContent as { recovery: { query: { arguments: unknown } } }).recovery;
    assert.deepEqual(recovery.query.arguments, { repo: "shop", base: "b".repeat(40), live: true, changed: ["src/**"], budget: { depth: 2 } });
  } finally { await session.close(); }
});

test("workspace impact recovery forwards actual replay and preserves selectors and pins", async () => {
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: "a".repeat(40) }, { repo: "shop-web", kind: "sha" as const, sha: "c".repeat(40) }, { repo: "unknown", kind: "sha" as const, sha: "e".repeat(40) }] };
  const fact = workspaceImpactFact();
  if (fact.status === "unknown") throw new Error("expected workspace value");
  const recorded = { ...fact, value: { ...fact.value, workspace: { ...fact.value.workspace, source: "persisted" as const }, sections: { ...fact.value.sections, unknown: { ...base({ snapshot: replay.snapshots[2]! }), status: "unknown" as const, reason: "revision-unavailable" as const } } }, inputs: { ...fact.inputs, declaredConfig: { changed: ["src/**"], walk: { depth: 2 } } } };
  const { session, calls } = await setup({ workspaceOfChange: async (request) => {
    if (request.replay && (request.replay.declaration !== replay.declaration || request.repo.revision !== "a".repeat(40) || request.base !== "b".repeat(40))) return { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "mismatch" } };
    return { ok: true, value: { fact: recorded, workspaceReplay: replay, repositorySources: [{ repo: "shop-web", path: "/internal/mirror" }] } };
  } });
  try {
    const first = await session.callTool("ye_ast_impact", { base: "main", workspace: {}, changed: ["src/**"], budget: { depth: 2 }, mode: "full" });
    const recovery = (first.structuredContent as { recovery: { status: string; query: { name: string; arguments: Record<string, unknown> } }; value: WorkspaceImpactValue }).recovery;
    assert.equal(recovery.status, "available");
    assert.deepEqual(recovery.query.arguments, { repo: "shop", base: "b".repeat(40), head: "a".repeat(40), changed: ["src/**"], budget: { depth: 2 }, workspace: {}, replay });
    assert.equal((first.structuredContent as { value: WorkspaceImpactValue }).value.workspace.source, "persisted");
    assert.doesNotMatch(JSON.stringify(recovery), /internal\/mirror/);
    const again = await session.callTool(recovery.query.name, recovery.query.arguments);
    assert.deepEqual((again.structuredContent as Record<string, unknown>).recovery, recovery);
    assert.deepEqual(calls.workspaceOfChange[1]?.replay, replay);
    const explicit = await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, offline: true });
    const args = (explicit.structuredContent as { recovery: { query: { arguments: Record<string, unknown> } } }).recovery.query.arguments;
    assert.deepEqual(args.workspace, WORKSPACE);
    assert.equal(args.offline, true);
    const mismatch = await session.callTool("ye_ast_impact", { base: "main", workspace: {}, replay: { ...replay, declaration: `ws-r1:${"f".repeat(64)}` } });
    assert.equal(mismatch.isError, true);
    assert.equal(mismatch.structuredContent, undefined);
    assert.deepEqual(mismatch._meta?.["ye-ast/fault"], { kind: "result-changed", detail: "mismatch", stage: "workspace-replay" });
  } finally { await session.close(); }
});

test("impact replay input and full recovery output enforce strict matching schemas", async () => {
  const { session } = await setup();
  try {
    const tool = (await session.listTools()).find((item) => item.name === "ye_ast_impact")!;
    const input = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const output = new AjvJsonSchemaValidator().getValidator(IMPACT_OUTPUT['~standard'].jsonSchema.output({target:'draft-07'}));
    const replay = { version: 1, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha", sha: "a".repeat(40) }] };
    assert.equal(input({ base: "main", workspace: {}, replay }).valid, true);
    for (const args of [{ base: "main", replay }, { base: "main", workspace: {}, replay: { ...replay, version: 2 } }]) {
      assert.equal(input(args).valid, "workspace" in args ? false : true);
      assert.equal((await session.callTool("ye_ast_impact", args)).isError, true);
    }
    const receipt = (await session.callTool("ye_ast_impact", { base: "main" })).structuredContent as Record<string, unknown>;
    const valid = receipt.recovery as { query: { arguments: Record<string, unknown> } };
    const invalid = [{ ...receipt, recovery: { ...valid, query: { ...valid.query, name: "ye_ast_callers" } } }, { ...receipt, recovery: { ...valid, query: { ...valid.query, arguments: { ...valid.query.arguments, base: "main" } } } }, { ...receipt, recovery: { version: 1, status: "unavailable", reason: "other" } }];
    for (const [value, expected] of [[receipt, true], ...invalid.map((item) => [item, false] as const)] as const) {
      assert.equal(IMPACT_OUTPUT.safeParse(value).success, expected);
      assert.equal(output(value).valid, expected);
    }
  } finally { await session.close(); }
});

test("impact and callers identities include recorded semantics and complete source", async () => {
  const config = { targets: ["src/A.java:A.f"], changed: ["src/**"], walk: { depth: 2 } };
  const initial = impactFact({ inputs: { ...base().inputs, declaredConfig: config } });
  let current: Fact<ImpactValue> = initial;
  const { session } = await setup({ callers: async () => ({ ok: true, value: current }), ofChange: async () => ({ ok: true, value: current }) });
  const identity = async (name: "ye_ast_callers" | "ye_ast_impact") => {
    const request = name === "ye_ast_callers" ? { targets: [{ file: "src/A.java", symbol: "A.f" }] } : { base: "main" };
    const result = await session.callTool(name, request);
    const recovery = (result.structuredContent as { recovery: { status: string; resultIdentity: string } }).recovery;
    assert.equal(recovery.status, "available");
    return recovery.resultIdentity;
  };
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      current = initial;
      const baseline = await identity(name);
      const variants: [string, Fact<ImpactValue>][] = [
        ["targets", { ...initial, inputs: { ...initial.inputs, declaredConfig: { ...config, targets: ["src/B.java:g", "src/A.java:A.f"] } } }],
        ["scope", { ...initial, inputs: { ...initial.inputs, declaredScope: { ...initial.inputs.declaredScope, include: ["other/**"] } } }],
        ["walk", { ...initial, inputs: { ...initial.inputs, declaredConfig: { ...config, walk: { depth: 3 } } } }],
        ["changed", { ...initial, inputs: { ...initial.inputs, declaredConfig: { ...config, changed: ["other/**"] } } }],
        ["config", { ...initial, inputs: { ...initial.inputs, config: "different" } }],
        ["producer", { ...initial, producer: { ...initial.producer, version: "2" } }],
        ["source value", { ...base(), inputs: initial.inputs, status: "complete", value: { ...IMPACT, seeds: [{ ...IMPACT.seeds[0]!, line: 32 }] } }],
        ["status and cut", { ...initial, status: "partial", value: IMPACT, cuts: [{ kind: "depth", at: ["src/A.java"], limit: 2 }] }],
        ["merge base", { ...base(), inputs: initial.inputs, status: "complete", value: { ...IMPACT, mergeBase: "c".repeat(40) } }],
      ];
      for (const [label, fact] of variants) { current = fact; assert.notEqual(await identity(name), baseline, `${name}: ${label}`); }
    }
  } finally { await session.close(); }
});

for (const dimension of ["schema", "order", "cuts"] as const) {
  test(`recovery identity independently tracks ${dimension}`, async () => {
    const targets = [{ file: "src/A.java", symbol: "A.f" }, { file: "src/B.java", symbol: "B.g" }];
    const initial: PartialFact<ImpactValue> = {
      ...base(),
      inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f", "src/B.java:B.g"], walk: { depth: 2 } } },
      status: "partial",
      value: { ...IMPACT, seeds: [
        { file: "src/A.java", symbol: "f", line: 3, basis: "lines" },
        { file: "src/B.java", symbol: "g", line: 7, basis: "lines" },
      ] },
      cuts: [{ kind: "depth", at: ["src/A.java"], limit: 2 }],
    };
    const variants: Record<typeof dimension, Fact<ImpactValue>> = {
      schema: { ...initial, schema: "0.12.1" },
      order: { ...initial, value: { ...initial.value, seeds: [...initial.value.seeds].reverse() } },
      cuts: { ...initial, cuts: [{ kind: "depth", at: ["src/B.java"], limit: 2 }] },
    };
    let current: Fact<ImpactValue> = initial;
    const { session } = await setup({ callers: async () => ({ ok: true, value: current }), ofChange: async () => ({ ok: true, value: current }) });
    try {
      for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
        const request = name === "ye_ast_callers" ? { targets } : { base: "main" };
        const identity = async () => {
          const result = await session.callTool(name, request);
          const recovery = (result.structuredContent as { recovery: { status: string; resultIdentity: string } }).recovery;
          assert.equal(recovery.status, "available");
          return recovery.resultIdentity;
        };
        current = initial;
        const baseline = await identity();
        current = variants[dimension];
        assert.notEqual(await identity(), baseline, `${name}: ${dimension}`);
      }
    } finally { await session.close(); }
  });
}

test("workspace recovery identity includes declaration, vector and contributing provenance but excludes sidecars", async () => {
  const original = workspaceImpactFact();
  if (original.status === "unknown") throw new Error("expected workspace value");
  const shared = { ...base({ snapshot: { repo: "shop-web", kind: "sha", sha: "c".repeat(40) }, evidence: [{ path: "src/shared.ts", line: 7 }] }), status: "complete" as const };
  const section = original.value.sections["shop-web"]!;
  if (section.status === "unknown") throw new Error("expected section");
  const fact: Fact<WorkspaceImpactValue> = { ...original, inputs: { ...original.inputs, declaredConfig: { targets: ["src/A.java:A.f"] } }, value: { ...original.value, sections: { ...original.value.sections, "shop-web": { ...section, value: { ...section.value, reads: [{ kind: "upstream", fact: shared }, { kind: "trigger", fact: { ...shared, snapshot: { repo: "shop", kind: "sha", sha: "b".repeat(40) } } }] } } } } };
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: "a".repeat(40) }, { repo: "shop-web", kind: "sha" as const, sha: "c".repeat(40) }, { repo: "unavailable", kind: "sha" as const, sha: "e".repeat(40) }] };
  let read: FactRead<WorkspaceImpactValue> = { fact, workspaceReplay: replay, repositoryRoots: [{ repo: "shop-web", path: "/clones/one" }], repositorySources: [{ repo: "shop-web", path: "/mirror/one" }] };
  const { session } = await setup({ workspaceCallers: async () => ({ ok: true, value: read }), workspaceOfChange: async () => ({ ok: true, value: read }) });
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const req = name === "ye_ast_callers" ? { workspace: {}, targets: [{ file: "src/A.java", symbol: "A.f" }] } : { workspace: {}, base: "main" };
      const get = async (mode: string) => (await session.callTool(name, { ...req, mode })).structuredContent as { recovery: { status: string; resultIdentity: string; query: { arguments: Record<string, unknown> } } };
      read = { fact, workspaceReplay: replay, repositoryRoots: [{ repo: "shop-web", path: "/clones/one" }], repositorySources: [{ repo: "shop-web", path: "/mirror/one" }] };
      const baseline = await get("summary");
      assert.equal(baseline.recovery.status, "available");
      assert.deepEqual(baseline.recovery.query.arguments.workspace, {});
      assert.deepEqual(baseline.recovery.query.arguments.replay, replay);
      read = { fact, workspaceReplay: replay, refresh: REFRESH, repositoryRoots: [{ repo: "shop-web", path: "/clones/two" }], repositorySources: [{ repo: "shop-web", path: "/mirror/two" }] };
      const same = await get("full");
      assert.deepEqual(same.recovery, baseline.recovery);
      assert.doesNotMatch(JSON.stringify(same.recovery), /\/clones\/|\/mirror\//);
      assert.doesNotMatch(JSON.stringify(same), /\/mirror\//);
      for (const context of [{ ...replay, declaration: `ws-r1:${"f".repeat(64)}` }, { ...replay, snapshots: [replay.snapshots[0]!, { ...replay.snapshots[1]!, sha: "f".repeat(40) }, replay.snapshots[2]!] }]) {
        read = { fact, workspaceReplay: context };
        assert.notEqual((await get("summary")).recovery.resultIdentity, baseline.recovery.resultIdentity);
      }
      const changedFact: Fact<WorkspaceImpactValue> = { ...original, inputs: fact.inputs, value: { ...original.value, sections: { ...original.value.sections, "shop-web": { ...section, value: { ...section.value, reads: [{ kind: "upstream", fact: shared }, { kind: "trigger", fact: { ...shared, snapshot: { repo: "shop", kind: "sha", sha: "b".repeat(40) }, inputs: { ...shared.inputs, content: "base-side-changed" } } }] } } } } };
      read = { fact: changedFact, workspaceReplay: replay };
      assert.notEqual((await get("summary")).recovery.resultIdentity, baseline.recovery.resultIdentity);
    }
  } finally { await session.close(); }
});

test("recovery handles unknown callers, missing workspace context and nested deadlines", async () => {
  const cfg = { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"] } };
  let local: Fact<ImpactValue> = { ...base({ inputs: cfg }), status: "unknown", reason: "index-unavailable" };
  let workspaceRead: FactRead<WorkspaceImpactValue> = { fact: workspaceImpactFact() };
  const { session } = await setup({ callers: async () => ({ ok: true, value: local }), workspaceCallers: async () => ({ ok: true, value: workspaceRead }), workspaceOfChange: async () => ({ ok: true, value: workspaceRead }) });
  const targets = [{ file: "src/A.java", symbol: "A.f" }];
  try {
    const result = await session.callTool("ye_ast_callers", { targets });
    assert.equal((result.structuredContent as { recovery: { status: string } }).recovery.status, "available");
    local = { ...base({ inputs: cfg }), status: "unknown", reason: "deadline" };
    const deadline = await session.callTool("ye_ast_callers", { targets });
    assert.deepEqual((deadline.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "deadline" });
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const args = name === "ye_ast_callers" ? { targets, workspace: {} } : { base: "main", workspace: {} };
      workspaceRead = { fact: workspaceImpactFact() };
      const absent = await session.callTool(name, args);
      assert.deepEqual((absent.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "unresolved-context" });
      const fact = workspaceImpactFact();
      if (fact.status === "unknown") throw new Error("expected workspace value");
      const nested: Fact<WorkspaceImpactValue> = { ...fact, value: { ...fact.value, sections: { ...fact.value.sections, "shop-web": { ...base(), status: "unknown", reason: "deadline" } } } };
      workspaceRead = { fact: nested };
      const limited = await session.callTool(name, args);
      assert.deepEqual((limited.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "deadline" });
    }
  } finally { await session.close(); }
});

test("local live recovery tracks head and state while excluding stale notices", async () => {
  let snapshot = { repo: "shop", kind: "live" as const, head: "a".repeat(40), stateId: "state-1" };
  let stale = false;
  const current = () => impactFact({ snapshot, inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } });
  const { session } = await setup({
    callers: async (request) => { if (stale && request.live) request.onStale?.({ stateId: "later", changed: ["src/A.java"] }); return { ok: true, value: current() }; },
    ofChange: async (request) => { if (stale && request.live) request.onStale?.({ stateId: "later", changed: ["src/A.java"] }); return { ok: true, value: current() }; },
  });
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const args = name === "ye_ast_callers" ? { targets: [{ file: "src/A.java", symbol: "A.f" }], live: true } : { base: "main", live: true };
      const get = async () => (await session.callTool(name, args)).structuredContent as { recovery: { resultIdentity: string } };
      snapshot = { repo: "shop", kind: "live", head: "a".repeat(40), stateId: "state-1" }; stale = false;
      const initial = await get();
      stale = true;
      assert.deepEqual((await get()).recovery, initial.recovery);
      snapshot = { ...snapshot, stateId: "state-2" };
      assert.notEqual((await get()).recovery.resultIdentity, initial.recovery.resultIdentity);
      snapshot = { ...snapshot, stateId: "state-1", head: "b".repeat(40) };
      assert.notEqual((await get()).recovery.resultIdentity, initial.recovery.resultIdentity);
    }
  } finally { await session.close(); }
});

test("recovery ignores moving aliases and selected root for identical recorded facts", async () => {
  const fact = impactFact({ inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } });
  const handlers = { callers: async () => ({ ok: true as const, value: fact }), ofChange: async () => ({ ok: true as const, value: fact }) };
  const first = await setup(handlers, undefined, undefined, { repoId: "shop", path: "/one" });
  const second = await setup(handlers, undefined, undefined, { repoId: "shop", path: "/two" });
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const a = name === "ye_ast_callers" ? { targets: [{ file: "src/A.java", symbol: "A.f" }], revision: "main" } : { base: "main", head: "branch" };
      const b = name === "ye_ast_callers" ? { targets: [{ file: "src/A.java", symbol: "A.f" }], revision: "release" } : { base: "release", head: "tag" };
      const x = await first.session.callTool(name, { ...a, mode: "summary" });
      const y = await second.session.callTool(name, { ...b, mode: "full" });
      assert.deepEqual((x.structuredContent as Record<string, unknown>).recovery, (y.structuredContent as Record<string, unknown>).recovery);
    }
  } finally { await first.session.close(); await second.session.close(); }
});

test("semantic recipe redaction disables recovery and leaks no secret", async () => {
  const targets = [{ file: "src/A.java", symbol: "A.f" }];
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: "a".repeat(40) }, { repo: "shop-web", kind: "sha" as const, sha: "f".repeat(40) }] };
  const local: Fact<ImpactValue> = impactFact({ inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } });
  const workspaceFact = workspaceImpactFact();
  const composite: Fact<WorkspaceImpactValue> = { ...workspaceFact, inputs: { ...workspaceFact.inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } };
  const handlers = { callers: async () => ({ ok: true as const, value: local }), ofChange: async () => ({ ok: true as const, value: local }), workspaceCallers: async () => ({ ok: true as const, value: { fact: composite, workspaceReplay: replay } }), workspaceOfChange: async () => ({ ok: true as const, value: { fact: composite, workspaceReplay: replay } }) };
  const { session } = await setup(handlers);
  try {
    const cases: [string, Record<string, unknown>][] = [
      ["ye_ast_callers", { targets: [{ file: `src/${SECRET}.java`, symbol: "f" }] }],
      ["ye_ast_callers", { targets, scope: { include: [`src/${SECRET}/**`] } }],
      ["ye_ast_impact", { base: "main", changed: [`src/${SECRET}/**`] }],
      ["ye_ast_callers", { targets, workspace: { repos: [{ path: `/work/${SECRET}`, id: "other", revision: "topic" }] } }],
      ["ye_ast_impact", { base: "main", workspace: { gateways: [{ prefix: SECRET, repo: "shop" }] } }],
    ];
    const tools = await session.listTools();
    for (const [name, args] of cases) for (const mode of ["summary", "details", "full"]) {
      const result = await session.callTool(name, { ...args, mode });
      assert.equal(new AjvJsonSchemaValidator().getValidator(tools.find(tool => tool.name === name)!.outputSchema!)(result.structuredContent).valid, true);
      assert.deepEqual((result.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "redacted-context" }, `${name}: ${JSON.stringify(args)}`);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    }
  } finally { await session.close(); }
  const selectedFact = impactFact({ snapshot: { repo: SECRET, kind: "sha", sha: "a".repeat(40) }, inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } });
  const selected = await setup({ callers: async () => ({ ok: true, value: selectedFact }), ofChange: async () => ({ ok: true, value: selectedFact }) }, undefined, [{ repoId: SECRET, path: "/secret-repo" }]);
  try {
    for (const [name, args] of [["ye_ast_callers", { repo: SECRET, targets }], ["ye_ast_impact", { repo: SECRET, base: "main" }]] as const) {
      const result = await selected.session.callTool(name, args);
      assert.deepEqual((result.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "redacted-context" });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    }
  } finally { await selected.session.close(); }
  const pin = "f".repeat(40);
  const mask = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(pin, REDACTED));
  const pinRedaction: Redaction = { ...fakeRedaction, redact: (text) => text.replaceAll(pin, REDACTED), redactValue: mask };
  const pinned = await setup(handlers, undefined, undefined, REPOSITORY, pinRedaction);
  try {
    const result = await pinned.session.callTool("ye_ast_callers", { targets, workspace: {} });
    assert.deepEqual((result.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "redacted-context" });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(pin));
  } finally { await pinned.session.close(); }
});

test("replay semantic validation rejects unsorted members before core", async () => {
  const fault = { kind: "workspace-replay-mismatch" as const, detail: "core authority" };
  const { session, calls } = await setup({ workspaceCallers: async () => ({ ok: false, fault }), workspaceOfChange: async () => ({ ok: false, fault }) });
  const replay = { version: 1, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "z", kind: "sha", sha: "c".repeat(40) }, { repo: "a", kind: "sha", sha: "a".repeat(40) }] };
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const args = name === "ye_ast_callers" ? { targets: [{ file: "a", symbol: "f" }], workspace: {}, replay } : { base: "main", workspace: {}, replay };
      const tool = (await session.listTools()).find((item) => item.name === name)!;
      assert.equal(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid, true);
      const answer = await session.callTool(name, args);
      assert.equal(answer.isError, true);
      assert.equal(answer.structuredContent, undefined);
    }
    assert.equal(calls.workspaceCallers.length, 0);
    assert.equal(calls.workspaceOfChange.length, 0);
  } finally { await session.close(); }
});

test("impact and callers recovery schemas agree on bounds, globs and hash line endings", async () => {
  const { session } = await setup();
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const tool = (await session.listTools()).find((item) => item.name === name)!;
      const schema = name === "ye_ast_callers" ? CALLERS_OUTPUT : IMPACT_OUTPUT;
      const validate = new AjvJsonSchemaValidator().getValidator(schema['~standard'].jsonSchema.output({target:'draft-07'}));
      const input = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      const baseArgs = name === "ye_ast_callers" ? { targets: [{ file: "a", symbol: "f" }] } : { base: "main" };
      const replay = { version: 1, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha", sha: "a".repeat(40) }] };
      for (const bad of [{ ...baseArgs, replay }, { ...baseArgs, workspace: {}, replay: { ...replay, extra: true } }, { ...baseArgs, workspace: {}, replay: { ...replay, snapshots: [{ repo: "shop", kind: "live", sha: "a".repeat(40) }] } }, ...["\n", "\r", "\u2028", "\u2029"].map((newline) => ({ ...baseArgs, workspace: {}, replay: { ...replay, declaration: replay.declaration + newline } }))]) {
        assert.equal(input(bad).valid, !("workspace" in bad), JSON.stringify(bad));
        assert.equal((await session.callTool(name, bad)).isError, true, JSON.stringify(bad));
      }
      const args = name === "ye_ast_callers" ? { repo: "shop", revision: "a".repeat(40), targets: [{ file: "src/a.ts", symbol: "f" }] } : { repo: "shop", base: "b".repeat(40), head: "a".repeat(40) };
      const receipt = { mode: "summary", status: "complete", snapshot: base().snapshot, recovery: { version: 1, status: "available", resultIdentity: `mcp-r1:${"f".repeat(64)}`, query: { name, arguments: args } } };
      const check = (recovery: unknown, valid: boolean) => {
        const value = { ...receipt, recovery };
        assert.equal(schema.safeParse(value).success, valid, JSON.stringify(value));
        assert.equal(validate(value).valid, valid, JSON.stringify(value));
      };
      const recovery = receipt.recovery;
      const withArgs = (extra: object) => ({ ...recovery, query: { ...recovery.query, arguments: { ...args, ...extra } } });
      check(recovery, true);
      check(withArgs({ budget: { depth: 0 } }), false);
      check(withArgs({ budget: { expansions: 1, extra: 1 } }), false);
      check(withArgs({ scope: { include: ["src//bad"] } }), false);
      check(withArgs({ scope: { include: ["src/../bad"] } }), false);
      check({ version: 1, status: "unavailable", reason: "deadline", extra: true }, false);
      check({ ...recovery, query: { ...recovery.query, name: name === "ye_ast_impact" ? "ye_ast_callers" : "ye_ast_impact" } }, false);
      for (const newline of ["\n", "\r", "\u2028", "\u2029"]) {
        check({ ...recovery, resultIdentity: recovery.resultIdentity + newline }, false);
        check(withArgs(name === "ye_ast_callers" ? { revision: "a".repeat(40) + newline } : { head: "a".repeat(40) + newline }), false);
        check(withArgs({ scope: { include: [`src/a${newline}b/../bad`] } }), false);
        check(withArgs({ scope: { include: [`src/a${newline}b/file`] } }), true);
      }
    }
  } finally { await session.close(); }
});

test("redaction of an actual selected snapshot pin is reported as redacted context", async () => {
  const pin = "a".repeat(40);
  const redact: Redaction = { ...fakeRedaction, redact: (text) => text.replaceAll(pin, REDACTED), redactValue: (value) => JSON.parse(JSON.stringify(value).replaceAll(pin, REDACTED)) as unknown };
  const fact: Fact<ImpactValue> = impactFact({ inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } });
  const { session } = await setup({ callers: async () => ({ ok: true, value: fact }), ofChange: async () => ({ ok: true, value: fact }) }, undefined, undefined, REPOSITORY, redact);
  try {
    for (const [name, args] of [["ye_ast_callers", { targets: [{ file: "src/A.java", symbol: "A.f" }] }], ["ye_ast_impact", { base: "main" }]] as const) {
      const result = await session.callTool(name, args);
      assert.deepEqual((result.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "redacted-context" });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(pin));
    }
  } finally { await session.close(); }
});

test("workspace recipes preserve explicit selectors and effective offline policy", async () => {
  const baseFact: Fact<WorkspaceImpactValue> = workspaceImpactFact();
  const fact: Fact<WorkspaceImpactValue> = { ...baseFact, inputs: { ...baseFact.inputs, trust: "trusted", declaredConfig: { targets: ["src/A.java:A.f"] } } };
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: "a".repeat(40) }, { repo: "shop-web", kind: "sha" as const, sha: "c".repeat(40) }] };
  const { session, calls } = await setup({ workspaceCallers: async () => ({ ok: true, value: { fact, workspaceReplay: replay } }), workspaceOfChange: async () => ({ ok: true, value: { fact, workspaceReplay: replay } }) });
  const workspace = { repos: [{ path: "/clones/frontend", id: "shop-web", revision: "topic" }], gateways: [{ prefix: "edge", repo: "shop-web" }] };
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const args = name === "ye_ast_callers" ? { targets: [{ file: "src/A.java", symbol: "A.f" }], workspace } : { base: "main", workspace };
      const online = (await session.callTool(name, args)).structuredContent as { recovery: { resultIdentity: string; query: { arguments: Record<string, unknown> } } };
      const offline = (await session.callTool(name, { ...args, offline: true })).structuredContent as typeof online;
      assert.deepEqual(offline.recovery.query.arguments.workspace, workspace);
      assert.equal(offline.recovery.query.arguments.offline, true);
      assert.notEqual(offline.recovery.resultIdentity, online.recovery.resultIdentity);
    }
    assert.deepEqual(calls.workspaceCallers[0]?.repos, workspace.repos);
    assert.deepEqual(calls.workspaceOfChange[0]?.gateways, workspace.gateways);
  } finally { await session.close(); }
});

test("nested deadline in contributing read and finding prevents recovery", async () => {
  const source = workspaceImpactFact();
  if (source.status === "unknown") throw new Error("expected workspace value");
  const section = source.value.sections["shop-web"]!;
  if (section.status === "unknown") throw new Error("expected section");
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: "a".repeat(40) }] };
  let fact: Fact<WorkspaceImpactValue> = source;
  const { session } = await setup({ workspaceCallers: async () => ({ ok: true, value: { fact, workspaceReplay: replay } }), workspaceOfChange: async () => ({ ok: true, value: { fact, workspaceReplay: replay } }) });
  try {
    const sections: Fact<RepoImpact>[] = [
      { ...section, value: { ...section.value, reads: [{ kind: "upstream", fact: { ...base(), status: "unknown", reason: "deadline" } }] } },
      { ...section, value: { ...section.value, callSites: [{ ...SITE, target: { status: "unknown", reason: "deadline", evidence: [] } }] } },
    ];
    for (const part of sections) {
      fact = { ...source, inputs: { ...source.inputs, declaredConfig: { targets: ["src/A.java:A.f"] } }, value: { ...source.value, sections: { ...source.value.sections, "shop-web": part } } };
      for (const [name, args] of [["ye_ast_callers", { workspace: {}, targets: [{ file: "src/A.java", symbol: "A.f" }] }], ["ye_ast_impact", { workspace: {}, base: "main" }]] as const) {
        const response = await session.callTool(name, args);
        assert.deepEqual((response.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "deadline" });
      }
    }
  } finally { await session.close(); }
});

test("invalid returned workspace context cannot produce a recipe", async () => {
  const original = workspaceImpactFact();
  const fact: Fact<WorkspaceImpactValue> = { ...original, inputs: { ...original.inputs, declaredConfig: { targets: ["src/A.java:A.f"] } } };
  let replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [{ repo: "shop", kind: "sha" as const, sha: "HEAD" }] };
  const { session } = await setup({ workspaceCallers: async () => ({ ok: true, value: { fact, workspaceReplay: replay } }), workspaceOfChange: async () => ({ ok: true, value: { fact, workspaceReplay: replay } }) });
  try {
    for (const name of ["ye_ast_callers", "ye_ast_impact"] as const) {
      const args = name === "ye_ast_callers" ? { workspace: {}, targets: [{ file: "src/A.java", symbol: "A.f" }] } : { workspace: {}, base: "main" };
      for (const sha of ["HEAD", "b".repeat(40)]) {
        replay = { ...replay, snapshots: [{ repo: "shop", kind: "sha", sha }] };
        const result = await session.callTool(name, args);
        assert.deepEqual((result.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "unresolved-context" });
      }
    }
  } finally { await session.close(); }
});

test("redaction of recorded globs or numeric bounds disables both recipes", async () => {
  let fact: Fact<ImpactValue> = impactFact({ inputs: { ...base().inputs, declaredScope: { ...base().inputs.declaredScope, include: [`src/${SECRET}/**`] }, declaredConfig: { targets: ["src/A.java:A.f"], changed: [`src/${SECRET}/**`] } } });
  const handlers = { callers: async () => ({ ok: true as const, value: fact }), ofChange: async () => ({ ok: true as const, value: fact }) };
  const scoped = await setup(handlers);
  try {
    for (const [name, args] of [["ye_ast_callers", { targets: [{ file: "src/A.java", symbol: "A.f" }] }], ["ye_ast_impact", { base: "main" }]] as const) {
      const response = await scoped.session.callTool(name, args);
      assert.deepEqual((response.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "redacted-context" });
      assert.doesNotMatch(JSON.stringify(response), new RegExp(SECRET));
    }
  } finally { await scoped.session.close(); }
  fact = impactFact({ inputs: { ...base().inputs, declaredConfig: { targets: ["src/A.java:A.f"], walk: { depth: 2 } } } });
  const redact: Redaction = { ...fakeRedaction, redactValue: (value) => JSON.parse(JSON.stringify(value).replaceAll('"depth":2', '"depth":3')) as unknown };
  const bounded = await setup(handlers, undefined, undefined, REPOSITORY, redact);
  try {
    for (const [name, args] of [["ye_ast_callers", { targets: [{ file: "src/A.java", symbol: "A.f" }], budget: { depth: 2 } }], ["ye_ast_impact", { base: "main", budget: { depth: 2 } }]] as const) {
      const response = await bounded.session.callTool(name, args);
      assert.deepEqual((response.structuredContent as Record<string, unknown>).recovery, { version: 1, status: "unavailable", reason: "redacted-context" });
    }
  } finally { await bounded.session.close(); }
});

test("workspace callers accept mixed live selectors and forward them", async () => {
  const { session, calls } = await setup();
  try {
    const result = await session.callTool("ye_ast_callers", { targets: [{ file: "a", symbol: "f" }], live: true, offline: true, workspace: { repos: [{ path: "/work/other", id: "other", revision: "main" }] } });
    assert.notEqual(result.isError, true);
    assert.equal(calls.workspaceCallers[0]?.repo.live, true);
    assert.equal(calls.workspaceCallers[0]?.repos?.[0]?.revision, "main");
  } finally { await session.close(); }
});

test("mixed workspace selector schemas and runtime agree before dispatch", async () => {
  const { session, calls } = await setup();
  try {
    for (const [name, baseArgs, key, memberKey] of [
      ["ye_ast_workspace", {}, "revision", "repos"], ["ye_ast_decisions", {}, "revision", "repos"],
      ["ye_ast_callers", { targets: [{ file: "a", symbol: "f" }] }, "revision", "workspace"],
      ["ye_ast_impact", { base: "main" }, "head", "workspace"],
    ] as const) {
      const schema = (await session.listTools()).find((tool) => tool.name === name)!.inputSchema;
      const validate = new AjvJsonSchemaValidator().getValidator(schema);
      const member = { path: "/work/other", id: "other", live: true };
      const container = memberKey === "repos" ? { repos: [member] } : { workspace: { repos: [member] } };
      const good = { ...baseArgs, ...container, live: true, offline: true };
      assert.equal(validate(good).valid, true, name);
      assert.notEqual((await session.callTool(name, good)).isError, true, name);
      for (const bad of [ { ...baseArgs, ...container, [key]: "  " }, { ...good, [key]: "HEAD" }, { ...good, live: false }, { ...good, extra: 1 }, { ...baseArgs, ...(memberKey === "repos" ? { repos: [{ ...member, revision: "HEAD" }] } : { workspace: { repos: [{ ...member, revision: "HEAD" }] } }) },
        ...[{ ...member, live: false }, { ...member, path: " " }, { ...member, id: " " }].map((badMember) => ({ ...baseArgs, ...(memberKey === "repos" ? { repos: [badMember] } : { workspace: { repos: [badMember] } }) })),
      ]) {
        const before = calls.workspaceReads.length + calls.decisions.length + calls.workspaceCallers.length + calls.workspaceOfChange.length;
        const fields: Record<string, unknown> = bad;
        assert.equal(validate(bad).valid, (fields.live === true && fields[key] === "HEAD") || (memberKey === "workspace" && (fields[key] === "  " || fields.live === false)), JSON.stringify(bad));
        assert.equal((await session.callTool(name, bad)).isError, true);
        assert.equal(calls.workspaceReads.length + calls.decisions.length + calls.workspaceCallers.length + calls.workspaceOfChange.length, before);
      }
    }
    assert.equal(calls.workspaceReads[0]?.repo.live, true);
    assert.equal(calls.decisions[0]?.repos?.[0]?.live, true);
    assert.equal(calls.workspaceOfChange[0]?.repo.live, true);
  } finally { await session.close(); }
});

test("mixed recovery preserves live replay and redacts workspace notices in every mode", async () => {
  const snap = { repo: "shop", kind: "live" as const, head: "a".repeat(40), stateId: "state" };
  const replay = { version: 1 as const, declaration: `ws-r1:${"d".repeat(64)}`, snapshots: [snap, { repo: "team/other", kind: "sha" as const, sha: "b".repeat(40) }] };
  const fact = { ...workspaceImpactFact(), snapshot: snap, inputs: { ...base().inputs, declaredConfig: { targets: ["a:f"] } } };
  let changed = false;
  const notices = [ { kind: "staleness-unavailable" as const, repo: "team/other", snapshot: { ...snap, repo: "team/other" }, cause: { kind: "git-failed" as const, detail: "/host/private" } }, { kind: "stale" as const, repo: "shop", snapshot: snap, notice: { stateId: "state", changed: ["src/a.ts", SECRET] } } ];
  const { session } = await setup({ workspaceCallers: async (request) => changed && request.replay ? { ok: false, fault: { kind: "workspace-replay-mismatch", detail: "changed" } } : { ok: true, value: { fact, workspaceReplay: replay, workspaceLive: notices } } });
  try {
    const tool = (await session.listTools()).find((item) => item.name === "ye_ast_callers")!;
    const validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    let recipe: { name: string; arguments: Record<string, unknown> } | undefined;
    let identity: string | undefined;
    for (const mode of ["summary", "details", "full"]) {
      const response = await session.callTool("ye_ast_callers", { targets: [{ file: "a", symbol: "f" }], workspace: {}, live: true, mode });
      assert.equal(validate(response.structuredContent).valid, true);
      const recovery = (response.structuredContent as { recovery: { status: string; resultIdentity: string; query: typeof recipe } }).recovery;
      assert.equal(recovery.status, "available");
      identity ??= recovery.resultIdentity;
      assert.equal(recovery.resultIdentity, identity);
      recipe = recovery.query;
      assert.equal(recipe?.arguments.live, true);
      const serialized = JSON.stringify(response);
      assert.doesNotMatch(serialized, /hunter2-secret|\/host\/private/);
      assert.match(serialized, /team\/other/);
      assert.match(serialized, /src\/a.ts/);
      const actualNotices = response._meta?.["ye-ast/workspace-live"] as { repo: string }[];
      assert.ok(Array.isArray(actualNotices));
      assert.deepEqual(actualNotices.map((item) => item.repo), ["shop", "team/other"]);
      if (mode === "summary" && notices[1]?.kind === "stale") notices[1].notice.changed.push("src/new.ts");
      assert.equal("workspaceLive" in (response.structuredContent as object), mode === "full");
    }
    assert.ok(recipe);
    assert.notEqual((await session.callTool(recipe.name, recipe.arguments)).isError, true);
    changed = true;
    const old = await session.callTool(recipe.name, recipe.arguments);
    assert.equal(old.isError, true);
    assert.equal(old.structuredContent, undefined);
    assert.equal((old._meta?.["ye-ast/fault"] as { stage: string }).stage, "workspace-replay");
  } finally { await session.close(); }
});

test("replay rejects duplicate snapshots and duplicate repository IDs before dispatch", async () => {
  const { session, calls } = await setup();
  try {
    const input = new AjvJsonSchemaValidator().getValidator((await session.listTools()).find((tool) => tool.name === "ye_ast_callers")!.inputSchema);
    const one = { repo: "team/one", kind: "sha", sha: "a".repeat(40) };
    for (const [snapshots, schemaValid] of [[[one, one], false], [[one, { ...one, sha: "b".repeat(40) }], true]] as const) {
      const args = { targets: [{ file: "a", symbol: "f" }], workspace: {}, replay: { version: 1, declaration: `ws-r1:${"d".repeat(64)}`, snapshots } };
      assert.equal(input(args).valid, schemaValid);
      assert.equal((await session.callTool("ye_ast_callers", args)).isError, true);
      assert.equal(calls.workspaceCallers.length, 0);
    }
  } finally { await session.close(); }
});

test("mixed workspace targets the selected declared foreign repository", async () => {
  const { session, calls } = await setup({}, undefined, [{ path: "/work/foreign", repoId: "team/foreign" }]);
  try {
    const args = { repo: "team/foreign", targets: [{ file: "a", symbol: "f" }], live: true, workspace: {} };
    assert.notEqual((await session.callTool("ye_ast_callers", args)).isError, true);
    assert.equal(calls.workspaceCallers[0]?.repo.id, "team/foreign");
    assert.equal(calls.workspaceCallers[0]?.repo.path, "/work/foreign");
    assert.equal(calls.workspaceCallers[0]?.repo.live, true);
  } finally { await session.close(); }
});

test("selected evidence pages replay the source and reject changed identities before delivery", async () => {
  let changed = false;
  const original = mapFact();
  if (original.status !== "complete" || original.value.entrypoints.status !== "complete") throw new Error("fixture");
  const finding = original.value.entrypoints.value[0]!;
  const fact = { ...original, value: { ...original.value, entrypoints: { ...original.value.entrypoints, value: [{ ...finding, evidence: [{path:"a",line:1},{path:"b",line:2},{path:"c",line:3}] }] } } };
  const {session, calls} = await setup({map: async () => ({ok:true,value: changed ? {...fact, producer:{...fact.producer,version:"changed"}} : fact})});
  try {
    const tool = (await session.listTools()).find((t) => t.name === "ye_ast_entrypoints")!;
    const validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    const select = {kind:"entrypoint-evidence",findingIndex:0};
    const request = {mode:"full",select,page:{limit:1}};
    const first = await session.callTool(tool.name, request);
    assert.equal(first.isError, undefined);
    assert.equal(validate(first.structuredContent).valid, true);
    const a = first.structuredContent as {items: unknown[]; page:{nextCursor:string}; recovery:{resultIdentity:string}};
    const secondArgs = {...request,page:{limit:1,cursor:a.page.nextCursor}};
    const second = await session.callTool(tool.name, secondArgs);
    const repeated = await session.callTool(tool.name, secondArgs);
    assert.deepEqual(second.structuredContent, repeated.structuredContent);
    const b = second.structuredContent as {items: unknown[]; page:{nextCursor:string}};
    const third = await session.callTool(tool.name,{...request,page:{limit:1,cursor:b.page.nextCursor}});
    const c = third.structuredContent as {items: unknown[]; page:{nextCursor?:string}};
    assert.deepEqual([...a.items,...b.items,...c.items], [
      {evidenceIndex:0,evidence:{path:"a",line:1}}, {evidenceIndex:1,evidence:{path:"b",line:2}}, {evidenceIndex:2,evidence:{path:"c",line:3}},
    ]);
    assert.equal(c.page.nextCursor, undefined);
    assert.equal(calls.map.length, 4);
    for (const call of calls.map) {
      assert.equal("select" in call || "page" in call || "expect" in call, false);
    }
    for (const args of [
      { ...request, page: { limit: 2, cursor: a.page.nextCursor } },
      { ...secondArgs, expect: `mcp-r1:${"f".repeat(64)}` },
    ]) {
      const invalid = await session.callTool(tool.name, args);
      assert.equal(invalid.isError, true);
      assert.equal((invalid._meta?.["ye-ast/fault"] as {kind:string}).kind, "invalid-cursor");
    }
    assert.equal(calls.map.length, 4);
    const verified = await session.callTool(tool.name,{expect:a.recovery.resultIdentity});
    assert.equal(verified.isError, undefined);
    assert.equal((verified.structuredContent as {mode:string}).mode, "summary");
    changed = true;
    for (const args of [secondArgs,{expect:a.recovery.resultIdentity}]) {
      const result = await session.callTool(tool.name,args);
      assert.equal(result.isError,true);
      assert.equal(result.structuredContent,undefined);
      const fault = result._meta?.["ye-ast/fault"] as {kind:string;stage:string;expected:string;actual:string};
      assert.equal(fault.kind,"result-changed");
      assert.equal(fault.stage,"source-identity");
      assert.equal(fault.expected,a.recovery.resultIdentity);
      assert.notEqual(fault.actual,fault.expected);
    }
    assert.equal(calls.map.length,7);
  } finally { await session.close(); }
});

test("selected SDK responses bind all categories and modes to actual public schemas", async () => {
  const replay = {version:1 as const,declaration:`ws-r1:${"d".repeat(64)}`,snapshots:[{repo:"shop",kind:"sha" as const,sha:"a".repeat(40)}]};
  const values: ImpactValue = {...IMPACT,modules:{origins:[{file:"old",change:"modified"}],modules:[{file:"old",snapshot:"base",depth:0,origins:[0]}],cost:{expansionsUsed:0}}};
  const local = impactFact({status:"partial",cuts:[{kind:"depth",at:["root","a","b"]}],value:values,inputs:{...base().inputs,declaredConfig:{targets:["src/A.java:A.f"]}}});
  const ws = workspaceImpactFact();
  if (ws.status !== "complete") throw new Error("fixture");
  const composite: Fact<WorkspaceImpactValue> = {...ws,inputs:{...base().inputs,declaredConfig:{targets:["src/A.java:A.f"]}},value:{...ws.value,sections:{...ws.value.sections,shop:{...ws.value.sections.shop!,status:"complete",value:{impact:values,reads:[],callSites:[],unmatched:[],external:[]}},"shop-web":{...ws.value.sections["shop-web"]!,snapshot:{repo:"shop-web",kind:"sha",sha:"f".repeat(40)}}}}};
  const {session} = await setup({ofChange:async()=>({ok:true,value:local}),callers:async()=>({ok:true,value:local}),workspaceCallers:async()=>({ok:true,value:{fact:composite,workspaceReplay:replay}}),workspaceOfChange:async()=>({ok:true,value:{fact:composite,workspaceReplay:replay}})});
  try {
    const tools = await session.listTools();
    const h = {path:"src/OrderController.java",symbol:"OrderController.one",line:17};
    const cases = [
      {name:"ye_ast_entrypoints",args:{},select:{kind:"entrypoint-evidence",findingIndex:0},item:{evidenceIndex:0,evidence:{path:"src/OrderController.java",line:17}}},
      {name:"ye_ast_impact",args:{base:"main"},select:{kind:"module-origins",owner:{kind:"local"},module:{file:"old",snapshot:"base"}},item:{originIndex:0,origin:{file:"old",change:"modified"}}},
      {name:"ye_ast_callers",args:{targets:[{file:"src/A.java",symbol:"A.f"}]},select:{kind:"handler-origins",owner:{kind:"local"},handler:h},item:{seedIndex:0,seed:values.seeds[0]}},
      {name:"ye_ast_impact",args:{base:"main"},select:{kind:"cut-places",owner:{kind:"fact"},cutIndex:0},item:{atIndex:1,place:"a"}},
      {name:"ye_ast_impact",args:{base:"main",workspace:{}},select:{kind:"workspace-link-evidence",linkId:"link-1"},item:{position:0,linkId:"link-1",link:ws.value.links[0]!.link}},
      {name:"ye_ast_callers",args:{targets:[{file:"src/A.java",symbol:"A.f"}],workspace:{}},select:{kind:"handler-origins",owner:{kind:"section",repo:"shop"},handler:h},item:{seedIndex:0,seed:values.seeds[0]}},
      {name:"ye_ast_impact",args:{base:"main",workspace:{}},select:{kind:"module-origins",owner:{kind:"section",repo:"shop"},module:{file:"old",snapshot:"base"}},item:{originIndex:0,origin:{file:"old",change:"modified"}}},
      {name:"ye_ast_callers",args:{targets:[{file:"src/A.java",symbol:"A.f"}],workspace:{}},select:{kind:"workspace-link-evidence",linkId:"link-1"},item:{position:0,linkId:"link-1",link:ws.value.links[0]!.link}},
    ];
    for (const c of cases) for (const mode of ["full","summary","details"]) {
      const tool = tools.find((t)=>t.name===c.name)!;
      const result = await session.callTool(c.name,{...c.args,select:c.select,page:{limit:1},mode});
      assert.equal(result.isError,undefined,JSON.stringify(result));
      assert.equal(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(result.structuredContent).valid,true,JSON.stringify(result.structuredContent));
      const response = result.structuredContent as {kind:string;items?:unknown[]};
      assert.equal(response.kind,mode === "full" ? "projection" : "projection-receipt");
      if (mode === "full") assert.deepEqual(response.items,[c.item]);
      else { assert.equal(response.items,undefined); assert.match(textOf(result),/Records:/); }
    }
  } finally { await session.close(); }
});

test("invalid selection controls and cursor bindings fail before querying", async () => {
  const {session,calls} = await setup();
  try {
    const tools = await session.listTools();
    const valid = {select:{kind:"entrypoint-evidence",findingIndex:0},page:{limit:1}};
    const cases = [
      {name:"ye_ast_entrypoints",args:{select:valid.select}},
      {name:"ye_ast_entrypoints",args:{page:{limit:1}}},
      {name:"ye_ast_entrypoints",args:{select:{...valid.select,findingIndex:-1},page:{limit:1}}},
      {name:"ye_ast_entrypoints",args:{select:valid.select,page:{limit:Number.MAX_SAFE_INTEGER+1}}},
      {name:"ye_ast_callers",args:{targets:[{file:"a",symbol:"f"}],select:{kind:"module-origins",owner:{kind:"local"},module:{file:"a",snapshot:"head"}},page:{limit:1}}},
      {name:"ye_ast_impact",args:{base:"main",select:{kind:"workspace-link-evidence",linkId:"x"},page:{limit:1}}},
      {name:"ye_ast_importers",args:{files:["a"],...valid}},
    ];
    for (const c of cases) {
      const schema = tools.find((t)=>t.name===c.name)!.inputSchema;
      assert.equal(new AjvJsonSchemaValidator().getValidator(schema)(c.args).valid, ("select" in c.args && !("page" in c.args)) || ("page" in c.args && !("select" in c.args)) || (c.name === "ye_ast_impact"));
      assert.equal((await session.callTool(c.name,c.args)).isError,true);
    }
    assert.equal(calls.map.length+calls.callers.length+calls.ofChange.length+calls.importers.length,0);
    const result = await session.callTool("ye_ast_entrypoints",{...valid,page:{limit:1,cursor:"bad"}});
    assert.equal(result.isError,true);
    assert.equal((result._meta?.["ye-ast/fault"] as {kind:string}).kind,"invalid-cursor");
    assert.equal(calls.map.length,0);
    assert.equal((await session.callTool("ye_ast_entrypoints",valid)).isError,undefined);
  } finally { await session.close(); }
});

test("unknown selection owners retain evidence; deadline and redacted recipes fail without payload", async () => {
  const original = mapFact();
  if (original.status !== "complete") throw new Error("fixture");
  let current: EntrypointMapFact = {...original,value:{...original.value,entrypoints:{...base({evidence:[{path:"hidden",line:4}]}),status:"unknown",reason:"unresolved"}}};
  const {session} = await setup({map:async()=>({ok:true,value:current})});
  try {
    const select = {kind:"entrypoint-evidence",findingIndex:0};
    const args = {select,page:{limit:1},mode:"full"};
    const unknown = await session.callTool("ye_ast_entrypoints",args);
    assert.equal(unknown.isError,undefined);
    const projection = unknown.structuredContent as {availability:string;reason:string;evidence:unknown[];page?:unknown};
    assert.equal(projection.availability,"unavailable");
    assert.equal(projection.reason,"unresolved");
    assert.deepEqual(projection.evidence,[{path:"hidden",line:4}]);
    assert.equal(projection.page,undefined);
    current = {...original,value:{...original.value,entrypoints:{...base(),status:"unknown",reason:"deadline"}}};
    const deadline = await session.callTool("ye_ast_entrypoints",args);
    assert.equal(deadline.isError,true);
    assert.equal((deadline._meta?.["ye-ast/fault"] as {kind:string;reason:string}).reason,"deadline");
    assert.equal(deadline.structuredContent,undefined);
    current = original;
    const secret = await session.callTool("ye_ast_entrypoints",{...args,scope:{include:[`src/${SECRET}/**`]}});
    assert.equal(secret.isError,true);
    assert.equal((secret._meta?.["ye-ast/fault"] as {kind:string;reason:string}).reason,"redacted-context");
    assert.doesNotMatch(JSON.stringify(secret),new RegExp(SECRET));
    assert.equal(secret.structuredContent,undefined);
  } finally { await session.close(); }
});

test("known empty selections stay available and missing subjects return typed faults", async () => {
  const targets = [{file:"a",symbol:"f"}];
  const fact = impactFact({value:{...IMPACT,entrypoints:IMPACT.entrypoints.map(e=>({...e,seeds:[]}))},inputs:{...base().inputs,declaredConfig:{targets:["a:f"]}}});
  const {session} = await setup({callers:async()=>({ok:true,value:fact})});
  try {
    const handler = {path:"src/OrderController.java",symbol:"OrderController.one",line:17};
    const select = {kind:"handler-origins",owner:{kind:"local"},handler};
    const zero = await session.callTool("ye_ast_callers",{targets,select,page:{limit:5},mode:"full"});
    assert.equal(zero.isError,undefined);
    const payload = zero.structuredContent as {items:unknown[];page:{total:number;returned:number;nextCursor?:string}};
    assert.deepEqual(payload.items,[]);
    assert.deepEqual(payload.page,{limit:5,offset:0,returned:0,total:0});
    const missing = await session.callTool("ye_ast_callers",{targets,select:{...select,handler:{...handler,line:18}},page:{limit:1}});
    assert.equal(missing.isError,true);
    assert.equal((missing._meta?.["ye-ast/fault"] as {kind:string}).kind,"selection-not-found");
  } finally { await session.close(); }
});

test("continuation cannot invent a page for an unavailable evidence owner", async () => {
  const original = mapFact();
  const fact: EntrypointMapFact = { ...original, value: { entrypoints: { ...base(), status: "unknown", reason: "unresolved" } } };
  const { session, calls } = await setup({ map: async () => ({ ok: true, value: fact }) });
  try {
    const whole = await session.callTool("ye_ast_entrypoints", { mode: "full" });
    const recovery = (whole.structuredContent as { recovery: { status: string; resultIdentity: string } }).recovery;
    assert.equal(recovery.status, "available");
    const select = { kind: "entrypoint-evidence", findingIndex: 0 };
    const digest = { of: (value: string) => createHash("sha256").update(value).digest("hex") };
    const cursor = encodeCursor({ version: 1, resultIdentity: recovery.resultIdentity, selection: selectionDigest(select, digest), limit: 1, next: 1 });
    assert.ok(cursor.ok);
    const result = await session.callTool("ye_ast_entrypoints", { select, page: { limit: 1, cursor: cursor.value } });
    assert.equal(result.isError, true);
    assert.equal((result._meta?.["ye-ast/fault"] as { kind: string }).kind, "invalid-cursor");
    assert.equal(result.structuredContent, undefined);
    const first = await session.callTool("ye_ast_entrypoints", { select, page: { limit: 1 } });
    assert.equal(first.isError, undefined);
    assert.equal((first.structuredContent as { availability: string }).availability, "unavailable");
    const tool = (await session.listTools()).find(tool => tool.name === "ye_ast_entrypoints")!;
    assert.equal(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(first.structuredContent).valid, true);
    assert.equal(calls.map.length, 3);
  } finally { await session.close(); }
});

test("selected UI evidence preserves known and unknown components through all public modes", async () => {
  const findings: Finding<Entrypoint>[] = [
    { status: "complete", value: { kind: "ui-route", name: "/known", path: "/known", outlet: "side", component: { path: "page.ts", symbol: "Page", line: 4, endLine: 9 }, guards: [] }, evidence: [{ path: "routes.ts", line: 1 }] },
    { status: "complete", value: { kind: "ui-route", name: "/unknown", path: "/unknown", component: "unknown", guards: [] }, evidence: [{ path: "routes.ts", line: 2 }, { path: "routes.ts", line: 2 }] },
    { status: "unknown", reason: "no-extractor", evidence: [{ path: "routes.ts", line: 3 }] },
  ];
  const fact: EntrypointMapFact = { ...base(), status: "partial", cuts: [{ kind: "section", at: ["entrypoints"] }], value: { entrypoints: { ...base(), status: "partial", cuts: [{ kind: "no-extractor", at: ["routes.ts"] }], value: findings } } };
  const { session } = await setup({ map: async () => ({ ok: true, value: fact }) });
  try {
    const tool = (await session.listTools()).find(({ name }) => name === "ye_ast_entrypoints")!;
    const validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    for (const [findingIndex, finding] of findings.entries()) {
      for (const mode of ["summary", "details", "full"] as const) {
        const result = await session.callTool(tool.name, { mode, select: { kind: "entrypoint-evidence", findingIndex }, page: { limit: 2 } });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.equal(validate(result.structuredContent).valid, true);
        const payload = result.structuredContent as { source: { analysis: { status: string } }; context?: { finding: Record<string, unknown> }; items?: unknown[] };
        assert.equal(payload.source.analysis.status, "partial");
        if (mode === "full") {
          assert.deepEqual(payload.items, finding.evidence.map((evidence, evidenceIndex) => ({ evidenceIndex, evidence })));
          if (finding.status === "unknown") assert.deepEqual(payload.context?.finding, { status: "unknown", reason: finding.reason });
          else {
            assert.equal(payload.context?.finding.status, "complete");
            const identity = payload.context?.finding.identity as Record<string, unknown>;
            assert.equal(identity.kind, "ui-route");
            if (finding.value.kind !== "ui-route") throw new Error("fixture");
            assert.deepEqual(identity.component, finding.value.component);
            assert.equal("handler" in identity || "guards" in identity, false);
          }
        } else {
          assert.equal(payload.items, undefined);
          assert.match(textOf(result), /Records:/);
        }
      }
    }
  } finally { await session.close(); }
});

test("selected evidence is redacted before page rendering in every public mode", async () => {
  const original = mapFact();
  const section = original.value.entrypoints;
  if (section.status === "unknown") throw new Error("fixture");
  const fact: EntrypointMapFact = { ...original, value: { entrypoints: { ...section, value: section.value.map((finding, index) => index === 0 ? { ...finding, evidence: [{ path: `src/${SECRET}.ts`, line: 7 }] } : finding) } } };
  const { session } = await setup({ map: async () => ({ ok: true, value: fact }) });
  try {
    for (const mode of ["summary", "details", "full"] as const) {
      const result = await session.callTool("ye_ast_entrypoints", { mode, select: { kind: "entrypoint-evidence", findingIndex: 0 }, page: { limit: 1 } });
      assert.equal(result.isError, undefined);
      assert.equal(JSON.stringify(result).includes(SECRET), false);
      const payload = result.structuredContent as { recovery: { status: string }; items?: unknown[] };
      assert.equal(payload.recovery.status, "available");
      if (mode === "full") assert.deepEqual(payload.items, [{ evidenceIndex: 0, evidence: { path: `src/${REDACTED}.ts`, line: 7 } }]);
      else assert.ok(textOf(result).includes(`src/${REDACTED}.ts`));
    }
  } finally { await session.close(); }
});

test("recovery recipes stay structured once across ordinary and selected response modes", async () => {
  const targets = [{ file: "src/OrderService.java", symbol: "OrderService.find" }];
  const fact = impactFact({ status: "partial", cuts: [{ kind: "depth", at: ["src/OrderService.java::OrderService.find", "src/OrderController.java:17"], limit: 2 }], inputs: { ...base().inputs, declaredConfig: { targets: ["src/OrderService.java:OrderService.find"] } } });
  const { session } = await setup({ callers: async () => ({ ok: true, value: fact }), ofChange: async () => ({ ok: true, value: fact }) });
  const cases = [
    { name: "ye_ast_entrypoints", args: {}, select: { kind: "entrypoint-evidence", findingIndex: 0 } },
    { name: "ye_ast_callers", args: { targets }, select: { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 } },
    { name: "ye_ast_impact", args: { base: "main" }, select: { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 } },
  ];
  try {
    for (const { name, args, select } of cases) {
      let original: unknown;
      for (const mode of ["summary", "details", "full"]) {
        for (const controls of [{}, { select, page: { limit: 1 } }]) {
          const result = await session.callTool(name, { ...args, mode, ...controls });
          assert.notEqual(result.isError, true);
          const recovery = (result.structuredContent as { recovery: { status: string; query: { name: string; arguments: unknown } } }).recovery;
          assert.equal(recovery.status, "available");
          assert.equal(recovery.query.name, name);
          original ??= recovery;
          assert.deepEqual(recovery, original);
          const text = textOf(result);
          assert.equal(text.includes(JSON.stringify(recovery)), false, `${name} ${mode}: duplicate recovery`);
          assert.equal(text.includes(JSON.stringify(recovery.query)), false, `${name} ${mode}: duplicate recipe`);
          assert.equal((text.match(/structuredContent\.recovery/g) ?? []).length, 1, `${name} ${mode}: recovery location`);
        }
      }
    }
  } finally { await session.close(); }
});
