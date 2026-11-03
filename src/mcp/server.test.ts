import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import { SCHEMA, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries, MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactCallersRequest, ImpactFault, ImpactImportersRequest, ImpactOfChangeRequest, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import type { VcsFault } from "../core/ports/vcs.port.ts";
import type { LiveFault } from "../core/ports/live-queries.port.ts";
import type { WorkspaceQueries, WorkspaceRequest } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceFault } from "../core/ports/workspace-repos.port.ts";
import type { WorkspaceCallersRequest, WorkspaceImpactQueries, WorkspaceImpactValue, WorkspaceOfChangeRequest } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionQueries, DecisionsRequest, DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { FactRead, WorkspaceRefresh } from "../core/ports/workspace-queries.port.ts";
import { createMcpServer, CUT_GUIDANCE } from "./server.ts";
import { openSession, type Session } from "./test-session.ts";

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

function mapFact(overrides: Partial<EntrypointMapFact> = {}): EntrypointMapFact {
  const item: Fact<Entrypoint> = { ...base({ evidence: [{ path: "src/OrderController.java", line: 17 }] }), status: "complete", value: ROUTE };
  const section: Fact<readonly Fact<Entrypoint>[]> = { ...base(), status: "complete", value: [item] };
  return { ...base(), status: "complete", value: { entrypoints: section }, ...overrides } as EntrypointMapFact;
}

const IMPACT: ImpactValue = {
  mergeBase: "b".repeat(40),
  seeds: [{ file: "src/OrderService.java", symbol: "OrderService.find", line: 31, basis: "lines" }],
  changedEntrypoints: [{ change: "added", kind: "http-route", name: "POST /orders", handler: { path: "src/OrderController.java", symbol: "OrderController.create", line: 40 } }],
  symbols: [{ file: "src/OrderController.java", symbol: "OrderController.one", kind: "method", line: 17, depth: 2, confidence: 0.75, fanIn: 3, via: { file: "src/OrderService.java", symbol: "OrderService.find" } }],
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
  const section = (value: object): Fact<never> => ({ ...base(), status: "complete", value }) as never;
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
      evidence: [{ path: "src/app/order.api.ts", line: 7 }],
      options: [
        { value: "orders", basis: "exact-name", evidence: [{ path: "src/app/order.api.ts", line: 7 }], recommended: true },
        { value: "orders-core", basis: "artifact", evidence: [], recommended: false },
      ],
      allowsFreeText: true,
      required: false,
    },
    {
      id: "repository:geo.example.com",
      kind: "repository",
      subject: "geo.example.com",
      evidence: [{ path: "src/app/geo.api.ts", line: 11 }],
      options: [],
      allowsFreeText: true,
      required: false,
    },
  ],
};

function decisionFact(value: DecisionValue = DECISIONS): Fact<DecisionValue> {
  return { ...base(), status: "complete", value };
}

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
  decisions: DecisionsRequest[];
}

interface Answers {
  map: (request: MapRequest) => Promise<Result<EntrypointMapFact, VcsFault | LiveFault>>;
  ofChange: (request: ImpactOfChangeRequest) => Promise<Result<Fact<ImpactValue>, VcsFault | LiveFault>>;
  callers: (request: ImpactCallersRequest) => Promise<Result<Fact<ImpactValue>, ImpactFault>>;
  importers: (request: ImpactImportersRequest) => Promise<Result<Fact<ImportersValue>, VcsFault | LiveFault>>;
  decisions: (request: DecisionsRequest) => Promise<Result<FactRead<DecisionValue>, WorkspaceFault>>;
}

async function setup(answers: Partial<Answers> = {}, refresh?: WorkspaceRefresh): Promise<{ session: Session; calls: Calls }> {
  const calls: Calls = { map: [], ofChange: [], callers: [], importers: [], workspaceCallers: [], workspaceOfChange: [], workspaceReads: [], decisions: [] };
  /** A fact with the sidecar a read that refreshed something carries, and without one when it refreshed nothing. */
  const read = <T>(fact: Fact<T>): FactRead<T> => (refresh === undefined ? { fact } : { fact, refresh });
  const entrypoints: EntrypointQueries = {
    map: (request) => {
      calls.map.push(request);
      return (answers.map ?? (async () => ({ ok: true, value: mapFact() })))(request);
    },
  };
  const impact: ImpactQueries = {
    ofChange: (request) => {
      calls.ofChange.push(request);
      return (answers.ofChange ?? (async () => ({ ok: true, value: impactFact() })))(request);
    },
    callers: (request) => {
      calls.callers.push(request);
      return (answers.callers ?? (async () => ({ ok: true, value: impactFact() })))(request);
    },
    importers: (request) => {
      calls.importers.push(request);
      return (answers.importers ?? (async () => ({ ok: true, value: { ...base(), status: "complete", value: IMPORTERS } as Fact<ImportersValue> })))(request);
    },
  };
  const workspace = {
    outwardNames: async (request: WorkspaceRequest) => {
      calls.workspaceReads.push(request);
      return {
        ok: true,
        value: read({ ...base(), status: "complete", value: { workspace: { repos: [], gateways: [], source: "none" }, repositorySnapshots: [], sections: {}, candidates: [], unserved: [], repositories: [{ repo: "shop", path: "/work/shop", entrypoints: [], callSites: [] }] } }),
      };
    },
  } as unknown as WorkspaceQueries;
  const workspaceImpact: WorkspaceImpactQueries = {
    callers: async (request) => {
      calls.workspaceCallers.push(request);
      return { ok: true, value: read(workspaceImpactFact()) };
    },
    ofChange: async (request) => {
      calls.workspaceOfChange.push(request);
      return { ok: true, value: read(workspaceImpactFact()) };
    },
  };
  const decisions: DecisionQueries = {
    decisions: (request) => {
      calls.decisions.push(request);
      return (answers.decisions ?? (async () => ({ ok: true, value: read(decisionFact()) })))(request);
    },
  };
  const server = createMcpServer({ version: "0.0.0", entrypoints, impact, workspace, workspaceImpact, decisions, redaction: fakeRedaction, repository: REPOSITORY });
  return { session: await openSession(server), calls };
}

const textOf = (result: { content: { text: string }[] }): string => result.content.map((block) => block.text).join("\n");

/** The fact without the family's payload: what a tool answers in its structured content unless asked for the whole one. */
function envelopeOf(fact: object): Record<string, unknown> {
  const { value: _value, cuts: _cuts, ...envelope } = JSON.parse(JSON.stringify(fact)) as Record<string, unknown>;
  return envelope;
}

const TOOL_CALLS: [string, Record<string, unknown>][] = [
  ["ye_ast_entrypoints", {}],
  ["ye_ast_impact", { base: "main" }],
  ["ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.f" }] }],
  ["ye_ast_importers", { files: ["src/a.ts"] }],
  ["ye_ast_workspace", {}],
  ["ye_ast_decisions", {}],
];

test("by default every tool answers the envelope alone, keeping a partial status without the places the text names", async () => {
  const partial = impactFact({ status: "partial", cuts: [{ kind: "depth", at: ["src/A.java::f"], limit: 1 }] } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });

  for (const [name, args] of TOOL_CALLS) {
    const result = await session.callTool(name, args);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal("value" in structured, false, `${name}: no value`);
    assert.equal("cuts" in structured, false, `${name}: no cut places`);
    assert.deepEqual(Object.keys(structured).toSorted(), ["evidence", "inputs", "producer", "schema", "snapshot", "status"], name);
  }

  const impact = await session.callTool("ye_ast_impact", { base: "main" });
  assert.equal((impact.structuredContent as { status: string }).status, "partial");
  assert.match(textOf(impact), /src\/A\.java::f/);
  await session.close();
});

test("full adds the value and every cut place to the structured content and leaves the text byte for byte", async () => {
  const cuts = [{ kind: "depth", at: ["src/A.java::f"], limit: 1 }] as const;
  const partial = impactFact({ status: "partial", cuts } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });

  for (const [name, args] of TOOL_CALLS) {
    const plain = await session.callTool(name, args);
    const whole = await session.callTool(name, { ...args, full: true });
    assert.equal(textOf(whole), textOf(plain), `${name}: the text is the same in both modes`);
    assert.equal("value" in (whole.structuredContent as Record<string, unknown>), true, `${name}: value`);
  }

  const whole = await session.callTool("ye_ast_impact", { base: "main", full: true });
  assert.deepEqual(whole.structuredContent, JSON.parse(JSON.stringify(partial)));
  await session.close();
});

test("lists the six read tools, each described, none taking a top-level repository selector", async () => {
  const { session } = await setup();
  const tools = await session.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ye_ast_callers", "ye_ast_decisions", "ye_ast_entrypoints", "ye_ast_impact", "ye_ast_importers", "ye_ast_workspace"]);
  for (const tool of tools) {
    assert.ok((tool.description ?? "").length > 0, tool.name);
    for (const forbidden of ["repo", "repoId", "path", "repository"]) assert.equal(tool.inputSchema.properties?.[forbidden], undefined, `${tool.name}.${forbidden}`);
  }
  const required = (name: string): string[] => tools.find((tool) => tool.name === name)?.inputSchema.required ?? [];
  assert.deepEqual(required("ye_ast_impact"), ["base"]);
  assert.deepEqual(required("ye_ast_importers"), ["files"]);
  assert.deepEqual(required("ye_ast_callers"), ["targets"]);
  assert.deepEqual(required("ye_ast_entrypoints"), []);
  assert.deepEqual(required("ye_ast_workspace"), []);
  assert.deepEqual(required("ye_ast_decisions"), []);
  for (const name of ["ye_ast_workspace", "ye_ast_decisions"]) {
    const repos = tools.find((tool) => tool.name === name)?.inputSchema.properties?.["repos"] as { items?: { properties?: Record<string, unknown> } } | undefined;
    assert.ok(repos?.items?.properties?.["path"] !== undefined, `a passed repository is named by a nested path, in ${name}`);
    assert.ok(repos?.items?.properties?.["remote"] !== undefined, `a passed repository may declare its remote, in ${name}`);
  }
  await session.close();
});

test("the server instructions tell the agent when to call every tool", async () => {
  const { session } = await setup();
  const tools = await session.listTools();
  for (const tool of tools) assert.ok(session.instructions?.includes(tool.name), tool.name);
  await session.close();
});

test("the server instructions name the root every answer is relative to", async () => {
  const { session } = await setup();
  assert.ok(session.instructions?.includes(`${REPOSITORY.path} (id ${REPOSITORY.repoId})`), session.instructions);
  assert.match(session.instructions ?? "", /Every path in an answer is relative to that root/);
  await session.close();
});

test("a workspace answer says where its repositories came from, so one repository is never read as all of them", async () => {
  const { session } = await setup();
  const text = textOf(await session.callTool("ye_ast_workspace", {}));
  assert.match(text, /^repositories declared by: nothing: this answer covers the bound repository alone/m);
  await session.close();
});

test("every tool advertises an object output schema for the fact envelope", async () => {
  const { session } = await setup();
  for (const tool of await session.listTools()) {
    assert.equal(tool.outputSchema?.type, "object", tool.name);
    assert.deepEqual(tool.outputSchema?.required?.toSorted(), ["evidence", "inputs", "producer", "schema", "snapshot", "status"], tool.name);
  }
  await session.close();
});

test("entrypoints reads the bound repository at HEAD by default and answers the fact with its rendering", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_entrypoints", {});
  assert.equal(calls.map.length, 1);
  assert.equal(calls.map[0]?.repo, REPOSITORY.path);
  assert.equal(calls.map[0]?.repoId, REPOSITORY.repoId);
  assert.equal(calls.map[0]?.revision, "HEAD");
  assert.deepEqual(result.structuredContent, envelopeOf(mapFact()));
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

test("impact reads a change of the bound repository, head defaulting to HEAD, and renders seeds, reached symbols and entrypoints", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_impact", { base: "main", detail: "full" });
  assert.deepEqual(calls.ofChange.map(({ repo, repoId, base: from, head, budget }) => ({ repo, repoId, from, head, budget })), [
    { repo: REPOSITORY.path, repoId: REPOSITORY.repoId, from: "main", head: "HEAD", budget: undefined },
  ]);
  assert.deepEqual(result.structuredContent, envelopeOf(impactFact()));
  const text = textOf(result);
  assert.match(text, /status: complete/);
  assert.match(text, /^seeds \(1\):\n {2}src\/OrderService\.java \(lines\)\n {4}31 OrderService\.find$/m);
  assert.match(text, /src\/OrderController\.java\n {4}17 OrderController\.one \[method\] \(depth 2, confidence 0\.75, fan-in 3, via src\/OrderService\.java:OrderService\.find\)/);
  assert.match(text, /added http-route POST \/orders.*src\/OrderController\.java:40/);
  assert.match(text, /GET \/orders\/\{id\}.*src\/OrderController\.java:17.*depth 2/);
  await session.close();
});

test("impact forwards head and the budget bounds the caller sets", async () => {
  const { session, calls } = await setup();
  await session.callTool("ye_ast_impact", { base: "main", head: "topic", budget: { depth: 3, hubFanIn: 50, expansions: 9 } });
  assert.equal(calls.ofChange[0]?.head, "topic");
  assert.deepEqual(calls.ofChange[0]?.budget, { depth: 3, hubFanIn: 50, expansions: 9 });
  await session.close();
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

test("importers forwards the files and renders importers, users and unresolved namers per file", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], revision: "topic" });
  assert.deepEqual(calls.importers[0]?.files, ["src/OrderService.java"]);
  assert.equal(calls.importers[0]?.revision, "topic");
  const text = textOf(result);
  assert.match(text, /src\/OrderService\.java/);
  assert.match(text, /importers.*src\/OrderController\.java/);
  assert.match(text, /users.*src\/Billing\.java/);
  assert.match(text, /unresolved namers.*src\/Legacy\.java/);
  await session.close();
});

test("a partial answer counts its cuts in the status line and lists every one under a closing heading", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [{ kind: "depth", at: ["src/A.java:A.f", "src/B.java:B.g"], limit: 3 }, { kind: "hub", at: ["src/C.java:C.h"] }],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  const lines = text.split("\n");
  assert.equal(lines[0], "status: partial (cuts: 1 depth, 1 hub)");
  assert.match(text, /depth at src\/A\.java:A\.f, src\/B\.java:B\.g \(limit 3\)/);
  assert.match(text, /hub \(1\): src\/C\.java:C\.h/);
  assert.ok(text.indexOf("\ncuts:") > text.indexOf("impacted symbols"), "the cut list closes the answer");
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
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", detail: "full" }));
  assert.match(text, /unresolved-link at src\/a\.ts::A\.f: lines 18, 123 \(no-extractor\), src\/b\.ts:7/);
  await session.close();
});

test("with detail full, the places of a cut are grouped under their file, every place kept and the path printed once", async () => {
  const places = ["src/a.ts::A.f", ...["10", "11", "12", "40"].map((line) => `src/x.ts:${line}`), ...["7", "9"].map((line) => `src/y.ts:${line}`), "src/z.ts:3 no-extractor"];
  const partial = impactFact({ status: "partial", cuts: [{ kind: "unresolved-link", at: places }] } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", detail: "full" }));
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
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(
    text,
    /unresolved-link \(3 declarations, 5 references; detail "full" lists every place\):\n {4}src\/a\.ts\n {6}A\.f: src\/x\.ts, src\/y\.ts\n {6}A\.g: src\/x\.ts\n {4}src\/z\.ts\n {6}\(the file itself\)$/m,
  );
  assert.doesNotMatch(text, /src\/x\.ts:\d/, "a summary prints no line of a place");
  assert.equal(text.split("src/a.ts").length - 1, 1, "the file of the declarations is printed once");
  await session.close();
});

test("the seeds of an impact answer are grouped under their file, with the basis printed once when the file shares it", async () => {
  const seeds = [
    { file: "src/a.ts", symbol: "a", line: 3, basis: "lines" as const },
    { file: "src/a.ts", symbol: "b", line: 9, basis: "top-level" as const },
    { file: "src/b.ts", symbol: "c", line: 2, basis: "requested" as const },
  ];
  const fact = impactFact({ value: { ...IMPACT, seeds } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /^seeds \(3\):\n {2}src\/a\.ts\n {4}3 a \(lines\)\n {4}9 b \(top-level\)\n {2}src\/b\.ts \(requested\)\n {4}2 c$/m);
  assert.equal(text.split("src/a.ts").length - 1, 1, "the path of a grouped file is printed once");
  await session.close();
});

test("impacted symbols are grouped under their file, a seed at depth 0 is not printed twice and only a confidence below 1 or a fan-in above 0 is printed", async () => {
  const grouped = impactFact({
    value: {
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/a.ts", symbol: "A.seed", kind: "method", line: 1, depth: 0, confidence: 1, fanIn: 0 },
        { file: "src/a.ts", symbol: "A.other", kind: "method", line: 4, depth: 1, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.user", kind: "function", line: 9, depth: 2, confidence: 0.5, fanIn: 2, via: { file: "src/a.ts", symbol: "A.other" } },
        { file: "src/b.ts", symbol: "B.helper", kind: "function", line: 2, depth: 2, confidence: 0.5, fanIn: 1, via: { file: "src/b.ts", symbol: "B.user" } },
      ],
      entrypoints: [],
      cost: { expansionsUsed: 1 },
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: grouped }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", detail: "full" }));
  assert.match(text, /impacted symbols \(3\):\n {2}src\/a\.ts\n {4}4 A\.other \[method\] \(depth 1\)\n {2}src\/b\.ts\n {4}9 B\.user \[function\] \(depth 2, confidence 0\.5, fan-in 2, via src\/a\.ts:A\.other\)\n {4}2 B\.helper \[function\] \(depth 2, confidence 0\.5, fan-in 1, via B\.user\)/);
  assert.doesNotMatch(text, /A\.seed \[method\]/);
  await session.close();
});

test("by default impact lists the symbols at depth 0 and 1 and says how many deeper ones it does not list", async () => {
  const deep = impactFact({
    value: {
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/a.ts", symbol: "A.other", kind: "method", line: 4, depth: 1, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.user", kind: "function", line: 9, depth: 2, confidence: 1, fanIn: 0 },
        { file: "src/b.ts", symbol: "B.helper", kind: "function", line: 2, depth: 3, confidence: 1, fanIn: 0 },
        { file: "src/c.ts", symbol: "C.top", kind: "function", line: 5, depth: 2, confidence: 1, fanIn: 0 },
      ],
      entrypoints: [],
      cost: { expansionsUsed: 1 },
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ callers: async () => ({ ok: true, value: deep }) });
  const result = await session.callTool("ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.seed" }] });
  const text = textOf(result);
  assert.match(text, /impacted symbols \(4\): 1 at depth 0-1 listed, 3 deeper not listed; detail "full" lists them\n {2}src\/a\.ts\n {4}4 A\.other \[method\] \(depth 1\)$/m);
  assert.doesNotMatch(text, /at depth 2-3|src\/c\.ts: 1 at depth/);
  assert.doesNotMatch(text, /B\.user|C\.top/);
  assert.deepEqual(result.structuredContent, envelopeOf(deep));
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
  assert.match(text, /GET \/sure -> src\/OrderController\.java:17 OrderController\.one \(depth 1\)\n/);
  assert.match(text, /GET \/maybe -> src\/OrderController\.java:17 OrderController\.one \(depth 2, confidence 0\.4\)/);
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
  assert.match(text, /\ncuts:\n {2}no-extractor \(1\): src\/scripts\/build\.js\n {2}section \(1\): entrypoints$/);
  await session.close();
});

test("an unknown answer says unknown with its reason and its evidence, never an empty list", async () => {
  const unknown = { ...base({ evidence: [{ path: "src/Broken.java", line: 4 }] }), status: "unknown", reason: "index-unavailable" } as Fact<ImpactValue>;
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: unknown }) });
  const result = await session.callTool("ye_ast_impact", { base: "main" });
  const text = textOf(result);
  assert.match(text, /status: unknown \(index-unavailable\)/);
  assert.match(text, /src\/Broken\.java:4/);
  assert.equal((result.structuredContent as { status: string }).status, "unknown");
  assert.doesNotMatch(text, /\(none\)/);
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
  const leaking = impactFact({ value: { ...IMPACT, seeds: [{ file: `src/${SECRET}.java`, symbol: "S.f", line: 1, basis: "lines" }] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: leaking }) });
  const result = await session.callTool("ye_ast_impact", { base: "main", full: true });
  assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(SECRET));
  assert.match(JSON.stringify(result.structuredContent), new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  assert.doesNotMatch(textOf(result), new RegExp(SECRET));
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
  for (const kind of Object.keys(CUT_GUIDANCE)) assert.ok(session.instructions?.includes(`- ${kind}: `), kind);
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
  ];
  assert.deepEqual(refused.map((result) => result.isError), [true, true, true, true, true, true, true, true, true]);
  assert.deepEqual([calls.map.length, calls.ofChange.length, calls.importers.length, calls.callers.length], [0, 0, 0, 0]);
  await session.close();
});

test("cancelling a call aborts the signal the query received", async () => {
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
  const call = session.startCall("ye_ast_entrypoints", {});
  assert.equal((await queryRunning).aborted, false);
  await session.cancel(call.id);
  assert.equal((await seenAbort).aborted, true);
  await session.close();
});

test("live on each tool asks for the working tree with no revision, and the fact is answered unchanged", async () => {
  const { session, calls } = await setup();

  const results = [
    await session.callTool("ye_ast_entrypoints", { live: true }),
    await session.callTool("ye_ast_impact", { base: "main", live: true }),
    await session.callTool("ye_ast_callers", { live: true, targets: [{ file: "src/A.java", symbol: "f" }] }),
    await session.callTool("ye_ast_importers", { live: true, files: ["src/A.java"] }),
  ];

  const requests: Record<string, unknown>[] = [calls.map[0], calls.ofChange[0], calls.callers[0], calls.importers[0]].map((request) => ({ ...request }));
  assert.deepEqual(requests.map((request) => [request.live, request.revision, request.head]), [[true, undefined, undefined], [true, undefined, undefined], [true, undefined, undefined], [true, undefined, undefined]]);
  assert.equal(calls.ofChange[0]?.base, "main");
  assert.deepEqual(results[0]?.structuredContent, envelopeOf(mapFact()));
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

test("an answer the working tree moved past opens its text with a stale line and carries the notice in _meta, with the fact untouched", async () => {
  const { session } = await setup({
    map: async (request) => {
      request.live === true && request.onStale?.({ stateId: "s1", changed: ["src/A.java", `src/${SECRET}.java`] });
      return { ok: true, value: mapFact() };
    },
  });

  const result = await session.callTool("ye_ast_entrypoints", { live: true });

  assert.match(textOf(result), /^stale: .*state s1: src\/A\.java, src\/\[REDACTED\]\.java\nstatus: complete/);
  assert.deepEqual(result._meta, { "ye-ast/live": { stateId: "s1", changed: ["src/A.java", `src/${REDACTED}.java`] } });
  assert.deepEqual(result.structuredContent, envelopeOf(mapFact()));
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
  await session.callTool("ye_ast_impact", { base: "main", head: "topic", workspace: WORKSPACE });

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
  assert.equal(calls.workspaceOfChange[0]?.head, "topic");
  assert.deepEqual(calls.workspaceOfChange[0]?.repos, WORKSPACE.repos);
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
  assert.match(text, /shop-web:src\/app\/order\.api\.ts:7 OrderApi\.create -> shop GET \/orders\/\{id\} \(route-overlap, upstream\)/);
  assert.match(text, /unmatched \(1\):\n\s+- src\/app\/order\.api\.ts:9 .* GET orders-api\/missing/);
  assert.match(text, /external \(1\):\n\s+- src\/app\/order\.api\.ts:11 .* GET geo-api\/provinces/);
  assert.match(text, /no local repository serves \(1\): geo-api/);
  assert.match(text, /declared gateways that matched nothing \(1\):\n\s+- legacy -> shop/);
  assert.equal(text.match(/reached entrypoints \(/g)?.length, 1, "the bound repository's walk is printed once");
  await session.close();
});

test("live with a workspace is refused by the schema before any query runs", async () => {
  const { session, calls } = await setup();

  const results = [
    await session.callTool("ye_ast_impact", { base: "main", live: true, workspace: WORKSPACE }).catch((error: Error) => error),
    await session.callTool("ye_ast_callers", { live: true, targets: [{ file: "a", symbol: "f" }], workspace: WORKSPACE }).catch((error: Error) => error),
  ];

  for (const result of results) assert.equal(result instanceof Error || (result as { isError?: boolean }).isError === true, true);
  assert.deepEqual([calls.workspaceCallers, calls.workspaceOfChange, calls.callers, calls.ofChange], [[], [], [], []]);
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
  const { session } = await setup();

  const result = await session.callTool("ye_ast_workspace", { full: true });

  const value = (result.structuredContent as { value: Record<string, unknown> }).value;
  assert.equal("repositories" in value, false);
  assert.deepEqual(Object.keys(value).sort(), ["candidates", "repositorySnapshots", "sections", "unserved", "workspace"]);
  await session.close();
});

test("a passed repository's remote reaches the workspace family, and an empty one is refused before any query runs", async () => {
  const { session, calls } = await setup();
  const remote = "https://git.example.com/shop/web.git";

  await session.callTool("ye_ast_workspace", { repos: [{ path: "/work/shop-web", id: "shop-web", remote }] });
  const refused = await session.callTool("ye_ast_workspace", { repos: [{ path: "/work/shop-web", remote: "" }] }).catch((error: Error) => error);

  assert.deepEqual(calls.workspaceReads.map(({ repos }) => repos), [[{ path: "/work/shop-web", id: "shop-web", remote }]]);
  assert.equal(refused instanceof Error || (refused as { isError?: boolean }).isError === true, true);
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
  assert.match(text, /\n {2}membership orders-api\n {4}evidence: src\/app\/order\.api\.ts:7\n {4}- orders \(exact-name, recommended, src\/app\/order\.api\.ts:7\)\n {4}- orders-core \(artifact\)\n {4}free text/);
  assert.match(text, /\n {2}repository geo\.example\.com\n {4}evidence: src\/app\/geo\.api\.ts:11\n {4}free text/);
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
    const before = (await plain.session.callTool(name, args)).structuredContent as Record<string, unknown>;
    const after = (await refreshed.session.callTool(name, args)).structuredContent as Record<string, unknown>;
    assert.equal("freshness" in before, false, `${name}: a read that refreshed nothing carries no freshness`);
    assert.equal("resolution" in before, false, `${name}: a read that refreshed nothing carries no resolution`);
    assert.deepEqual(after["freshness"], REFRESH.freshness, name);
    assert.deepEqual(after["resolution"], REFRESH.resolution, name);
    const { freshness: _freshness, resolution: _resolution, ...fact } = after;
    assert.deepEqual(fact, before, `${name}: the fact is unchanged by the refresh`);
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
  const { session } = await setup(undefined, leaking);

  const result = await session.callTool("ye_ast_workspace", {});

  const structured = JSON.stringify(result.structuredContent);
  assert.doesNotMatch(structured, new RegExp(SECRET));
  assert.match(structured, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  await session.close();
});
