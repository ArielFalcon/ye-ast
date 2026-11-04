import { test } from "node:test";
import assert from "node:assert/strict";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { Entrypoint } from "../core/domain/entrypoints/entrypoint.ts";
import { SCHEMA, type Cut, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
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
  workspaceOfChange: (request: WorkspaceOfChangeRequest) => Promise<Result<FactRead<WorkspaceImpactValue>, WorkspaceFault>>;
}

async function setup(answers: Partial<Answers> = {}, refresh?: WorkspaceRefresh): Promise<{ session: Session; calls: Calls }> {
  const calls: Calls = { map: [], ofChange: [], callers: [], importers: [], outline: [], workspaceCallers: [], workspaceOfChange: [], workspaceReads: [], decisions: [] };
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
      return (answers.outwardNames ?? (async () => ({ ok: true, value: read({ ...base(), status: "complete", value: { workspace: { repos: [], gateways: [], source: "none" }, repositorySnapshots: [], sections: {}, candidates: [], unserved: [], repositories: [{ repo: "shop", snapshot: base().snapshot, entrypoints: [], callSites: [] }] } }) })))(request);
    },
  } as unknown as WorkspaceQueries;
  const workspaceImpact: WorkspaceImpactQueries = {
    callers: async (request) => {
      calls.workspaceCallers.push(request);
      return { ok: true, value: read(workspaceImpactFact()) };
    },
    ofChange: async (request) => {
      calls.workspaceOfChange.push(request);
      return (answers.workspaceOfChange ?? (async () => ({ ok: true as const, value: read(workspaceImpactFact()) })))(request);
    },
  };
  const outline: OutlineQueries = {
    outline: (request) => {
      calls.outline.push(request);
      return (answers.outline ?? (async () => ({ ok: true, value: { ...base(), status: "complete", value: OUTLINE } as Fact<OutlineValue> })))(request);
    },
  };
  const decisions: DecisionQueries = {
    decisions: (request) => {
      calls.decisions.push(request);
      return (answers.decisions ?? (async () => ({ ok: true, value: read(decisionFact()) })))(request);
    },
  };
  const server = createMcpServer({ version: "0.0.0", entrypoints, impact, outline, workspace, workspaceImpact, decisions, redaction: fakeRedaction, repository: REPOSITORY });
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
  assert.match(textOf(impact), /depth \(1\); limit 1/);
  await session.close();
});

test("workspace repository roots accompany the answer without entering the fact", async () => {
  const repositoryRoots = [{ repo: "shop", path: REPOSITORY.path }, { repo: "shop-web", path: "/clones/frontend" }];
  const fact = workspaceFact();
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact, repositoryRoots } }) });

  for (const full of [false, true]) {
    const result = await session.callTool("ye_ast_workspace", { full });
    const structured = result.structuredContent as Record<string, unknown>;
    assert.deepEqual(structured["repositoryRoots"], repositoryRoots);
    assert.match(textOf(result), /repository root: shop-web -> \/clones\/frontend/);
    assert.equal(JSON.stringify(structured["inputs"]).includes("/clones/frontend"), false);
    assert.equal(JSON.stringify(structured["value"])?.includes("/clones/frontend") ?? false, false);
  }
  await session.close();
});

test("full adds the value and every cut place while other tools retain their text", async () => {
  const cuts = [{ kind: "depth", at: ["src/A.java::f"], limit: 1 }] as const;
  const partial = impactFact({ status: "partial", cuts } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });

  for (const [name, args] of TOOL_CALLS) {
    const plain = await session.callTool(name, args);
    const whole = await session.callTool(name, { ...args, full: true });
    if (name !== "ye_ast_importers") assert.equal(textOf(whole), textOf(plain), `${name}: the text is the same in both modes`);
    assert.equal("value" in (whole.structuredContent as Record<string, unknown>), true, `${name}: value`);
  }

  const whole = await session.callTool("ye_ast_impact", { base: "main", full: true });
  assert.deepEqual(whole.structuredContent, JSON.parse(JSON.stringify(partial)));
  await session.close();
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

test("lists the seven read tools, each described, none taking a top-level repository selector", async () => {
  const { session } = await setup();
  const tools = await session.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ye_ast_callers", "ye_ast_decisions", "ye_ast_entrypoints", "ye_ast_impact", "ye_ast_importers", "ye_ast_outline", "ye_ast_workspace"]);
  for (const tool of tools) {
    assert.ok((tool.description ?? "").length > 0, tool.name);
    for (const forbidden of ["repo", "repoId", "path", "repository"]) assert.equal(tool.inputSchema.properties?.[forbidden], undefined, `${tool.name}.${forbidden}`);
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
  await session.close();
});

test("tool discovery publishes the same live exclusions that calls enforce", async () => {
  const { session, calls } = await setup();
  try {
    const tools = await session.listTools();
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["ye_ast_impact", { base: "main" }, ["head", "offline", "workspace"]],
      ["ye_ast_callers", { targets: [{ file: "a", symbol: "f" }] }, ["revision", "offline", "workspace"]],
      ["ye_ast_entrypoints", {}, ["revision"]],
      ["ye_ast_importers", { files: ["a"] }, ["revision"]],
      ["ye_ast_outline", { files: ["a"] }, ["revision"]],
    ];
    for (const [name, args, fields] of cases) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      assert.ok(schema, name);
      const validate = new AjvJsonSchemaValidator().getValidator(schema);
      assert.deepEqual(schema?.allOf, fields.map((field) => ({
        not: { properties: { live: { const: true } }, required: ["live", field] },
      })), name);
      for (const field of fields) {
        const value = field === "offline" ? false : field === "workspace" ? {} : "main";
        assert.equal(validate({ ...args, live: true, [field]: value }).valid, false, name);
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
    const result = await session.callTool("ye_ast_impact", { base: "main", full: true, detail: "full" });
    assert.deepEqual(((result.structuredContent as { value: ImpactValue }).value).modules, value.modules);
    assert.match(textOf(result), /src\/consumer-9.ts/);
    assert.match(textOf(result), /reached entrypoints \(0\)/);
  } finally { await session.close(); }
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
  assert.match(text, /src\/OrderController\.java\n {4}17 OrderController\.one \[method\] \(depth 2, confidence 0\.75, fan-in 3, via src\/OrderService\.java:OrderService\.find at 44\)/);
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

test("impact forwards the changed selection", async () => {
  const { session, calls } = await setup();
  await session.callTool("ye_ast_impact", { base: "main", changed: ["src/a/**", "src/b/**"] });
  assert.deepEqual(calls.ofChange[0]?.changed, ["src/a/**", "src/b/**"]);
  await session.close();
});

test("an answer read with a changed selection says the repository is indexed whole", async () => {
  const fact = impactFact({ inputs: { ...base().inputs, declaredConfig: { changed: ["src/a/**"] } } });
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /^change: only paths matching src\/a\/\*\* \(the repository is indexed whole; callers outside the selection are known; the rest of the change is not answered about\)$/m);
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

test("importers forwards the files and identifies disjoint file relationships", async () => {
  const { session, calls } = await setup();
  const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], revision: "topic", detail: "full" });
  assert.deepEqual(calls.importers[0]?.files, ["src/OrderService.java"]);
  assert.equal(calls.importers[0]?.revision, "topic");
  const text = textOf(result);
  assert.match(text, /src\/OrderService\.java/);
  assert.match(text, /importers[\s\S]*src\/OrderController\.java/);
  assert.match(text, /additional users[\s\S]*src\/Billing\.java/);
  assert.match(text, /unresolved-only candidates.*src\/Legacy\.java/);
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
  const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], detail: "full" });
  const text = textOf(result);
  for (const path of ["src/Imported.java", "src/Shared.java", "src/Used.java", "src/UsedPending.java", "src/Candidate.java"]) {
    assert.equal(text.split(path).length - 1, 1, path);
  }
  assert.match(text, /related files \(5 distinct\)/);
  assert.match(text, /importers \(2\):\n +with unresolved name matches \(1\): src\/Shared\.java\n +without unresolved name matches \(1\): src\/Imported\.java/);
  assert.match(text, /additional users \(2\):\n +with unresolved name matches \(1\): src\/UsedPending\.java\n +without unresolved name matches \(1\): src\/Used\.java/);
  assert.match(text, /unresolved-only candidates \(1\): src\/Candidate\.java/);
  assert.match(text, /2 files with resolved links also have unresolved name matches/);
  assert.match(text, /not establish additional dependencies/);
  await session.close();
});

test("importers summary counts omitted file identities without adding overlapping categories", async () => {
  const paths = Array.from({ length: 18 }, (_, i) => `src/app/core/auth/consumers/consumer-${String(i).padStart(2, "0")}.ts`);
  const value: ImportersValue = { files: [{ file: "src/auth.service.ts", importers: paths, users: paths, unresolvedNamers: paths.slice(1) }] };
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...base(), status: "complete", value } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/auth.service.ts"] }));
  assert.match(text, /related files \(18 distinct\)/);
  assert.match(text, /importers \(18\)/);
  assert.match(text, /additional users \(0\)/);
  assert.match(text, /unresolved-only candidates \(0\)/);
  assert.match(text, /17 files with resolved links also have unresolved name matches/);
  for (const path of paths) assert.equal(text.includes(path), false, path);
  assert.match(text, /detail: "full"/);
  assert.match(text, /full: true/);
  const detail = textOf(await session.callTool("ye_ast_importers", { files: ["src/auth.service.ts"], detail: "full" }));
  assert.ok(Buffer.byteLength(text) <= Buffer.byteLength(detail));
  await session.close();
});

test("importers full keeps the original overlapping fact and cuts without repeating file lists in text", async () => {
  const fact: Fact<ImportersValue> = { ...base(), status: "partial", value: OVERLAPPING_IMPORTERS, cuts: [{ kind: "no-extractor", at: ["src/Unread.java"] }] };
  const { session } = await setup({ importers: async () => ({ ok: true, value: fact }) });
  for (const detail of ["summary", "full"]) {
    const result = await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], full: true, detail });
    assert.deepEqual(result.structuredContent, fact);
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
  const detail = textOf(await session.callTool("ye_ast_importers", { files: ["a.ts"], detail: "full" }));
  assert.equal(summary, detail);
  assert.equal(summary.split("b.ts").length - 1, 1);
  await session.close();
});

test("importers distinguishes a complete empty result from an unknown result in every presentation", async () => {
  const empty: Fact<ImportersValue> = { ...base(), status: "complete", value: { files: [{ file: "a.ts", importers: [], users: [], unresolvedNamers: [] }] } };
  const unknown: Fact<ImportersValue> = { ...base(), status: "unknown", reason: "index-unavailable" };
  for (const fact of [empty, unknown]) {
    const { session } = await setup({ importers: async () => ({ ok: true, value: fact }) });
    for (const presentation of [{}, { detail: "full" }, { full: true }]) {
      const result = await session.callTool("ye_ast_importers", { files: ["a.ts"], ...presentation });
      assert.equal((result.structuredContent as Fact<ImportersValue>).status, fact.status);
      const text = textOf(result);
      if (fact.status === "unknown") {
        assert.match(text, /index-unavailable/);
        assert.equal(text.includes("related files"), false);
      } else if (!("full" in presentation)) {
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
  const result = await session.callTool("ye_ast_impact", { base: "main", detail: "full", full: true });
  const text = textOf(result);
  assert.deepEqual(result.structuredContent, deep);
  assert.match(text, /src\/b\.ts[\s\S]*B\.user: 1 cut, 2 reference places/);
  assert.doesNotMatch(text, /src\/y\.ts/);
  assert.match(text, /depth \(1\): src\/c\.ts::C\.top \(limit 5\)/);
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
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], detail: "full" }));
  assert.match(text, /unresolved-link at src\/a\.ts::A\.f: lines 18, 123 \(no-extractor\), src\/b\.ts:7/);
  await session.close();
});

test("with detail full, the places of a cut are grouped under their file, every place kept and the path printed once", async () => {
  const places = ["src/a.ts::A.f", ...["10", "11", "12", "40"].map((line) => `src/x.ts:${line}`), ...["7", "9"].map((line) => `src/y.ts:${line}`), "src/z.ts:3 no-extractor"];
  const partial = impactFact({ status: "partial", cuts: [{ kind: "unresolved-link", at: places }] } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ importers: async () => ({ ok: true, value: { ...partial, value: IMPORTERS } }) });
  const text = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], detail: "full" }));
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
    /unresolved-link \(1 file, 2 declarations, 5 references; detail "full" lists every place\):\n {4}src\/a\.ts\n {6}A\.f: src\/x\.ts, src\/y\.ts\n {6}A\.g: src\/x\.ts\n {4}src\/z\.ts\n {6}\(the file itself\)$/m,
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
  const full = textOf(await session.callTool("ye_ast_importers", { files: ["src/OrderService.java"], detail: "full" }));
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
    /unresolved-link \(3 declarations, 6 references; detail "full" lists every place\):\n {4}src\/a\.ts\n {6}A\.f: src\/x\.ts, src\/y\.ts\n {6}A\.h \(same places as A\.f\)\n {4}src\/b\.ts\n {6}B\.g \(same places as src\/a\.ts::A\.f\)$/m,
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
  for (const detail of ["summary", "full"] as const) {
    const text = textOf(await session.callTool("ye_ast_workspace", { detail }));
    assert.match(text, /shop: unknown \(revision-unavailable\)/);
  }
  await session.close();
});

test("both impact text levels count unselected change origins while full JSON preserves them", async () => {
  const seeds = Array.from({ length: 12 }, (_, index) => ({ file: `src/feature-${index}.ts`, symbol: `a${index}`, line: index + 1, basis: index % 2 === 0 ? "lines" as const : "top-level" as const }));
  const fact = impactFact({ value: { ...IMPACT, seeds, symbols: [], entrypoints: [], changedEntrypoints: [] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: fact }) });
  const summary = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(summary, /^seeds \(12\):\n {2}change origins: 12 declarations across 12 files \(lines 6, top-level 6\); full: true includes every seed$/m);
  assert.doesNotMatch(summary, /src\/feature-/);
  const full = await session.callTool("ye_ast_impact", { base: "main", detail: "full", full: true });
  assert.deepEqual(full.structuredContent, fact);
  assert.doesNotMatch(textOf(full), /src\/feature-/);
  assert.match(textOf(full), /change origins: 12 declarations across 12 files/);
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
  assert.match(summary, /^seeds \(11\):\n {2}src\/a\.ts \(requested\)\n {4}1 asked\n {2}change origins: 10 declarations across 1 file \(lines 10\); full: true includes every seed$/m);
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
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", detail: "full" }));
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
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", detail: "full" }));
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
  assert.match(text, /-> src\/OrderController\.java:17-31 OrderController\.one \(depth 1\)$/m);
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
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", detail: "full" }));
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
  assert.deepEqual(result.structuredContent, envelopeOf(deep));
  const full = textOf(await session.callTool("ye_ast_callers", { targets: [{ file: "src/a.ts", symbol: "A.seed" }], detail: "full" }));
  assert.match(full, /4 A\.other/);
  assert.match(full, /8 other symbols; full: true/);
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
    await session.callTool("ye_ast_impact", { base: "main", changed: ["./x/**"] }),
  ];
  assert.deepEqual(refused.map((result) => result.isError), [true, true, true, true, true, true, true, true, true, true]);
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
  assert.deepEqual(result.structuredContent, { ...envelopeOf(mapFact()), live: notice });
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
  assert.equal(calls.workspaceOfChange[0]?.head, "topic");
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
  assert.match(text, / {2}shop:\n {4}path-prefix \(1\):\n {6}- orders-api \(src\/app\/order\.api\.ts:7\)\n {4}dependency \(3\): no repository given serves them; detail "full" lists them/);
  assert.match(text, /^no local repository serves \(4\): 3 dependency counted; detail "full" lists them$/m);
  assert.doesNotMatch(text, /- dependency @angular\/core/);
  await session.close();
});

test("a workspace full answer lists the dependency coordinates its summary counts", async () => {
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact() } }) });

  const text = textOf(await session.callTool("ye_ast_workspace", { detail: "full" }));

  assert.match(text, / {4}dependency \(3\):\n {6}- @angular\/core \(package\.json:36\)\n {6}- @capacitor\/core \(package\.json:49\)\n {6}- rxjs \(package\.json:74\)/);
  assert.match(text, /^no local repository serves \(4\):$/m);
  assert.match(text, / {2}- dependency @angular\/core \(shop:package\.json:36\)$/m);
  await session.close();
});

test("a workspace answer names each unresolved call site with its declaration, its transport and the request it writes", async () => {
  const { session } = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact() } }) });

  const text = textOf(await session.callTool("ye_ast_workspace", {}));

  assert.match(text, /^unresolved call sites \(1\):$/m);
  assert.match(text, / {2}shop:\n {4}src\/app\/order\.api\.ts\n {6}9-12 OrderApi\.create \(http\) GET \/orders/);
  assert.doesNotMatch(text, /\(the file itself\)/);
  assert.doesNotMatch(text, /unresolved-link/);
  await session.close();
});

test("a decisions summary groups the gaps by kind and counts the free-text-only dependency gaps", async () => {
  const { session } = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact(DEPENDENCY_GAP) } }) });

  const text = textOf(await session.callTool("ye_ast_decisions", {}));

  assert.match(text, /^decisions \(3\):$/m);
  assert.match(text, / {2}repository \(2\): 1 dependency counted \(free text only\); detail "full" lists them/);
  assert.match(text, / {4}geo\.example\.com/);
  assert.doesNotMatch(text, /@angular\/core/);
  await session.close();
});

test("a decisions full answer lists the dependency gaps its summary counts", async () => {
  const { session } = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact(DEPENDENCY_GAP) } }) });

  const text = textOf(await session.callTool("ye_ast_decisions", { detail: "full" }));

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
  const { session } = await setup({ outwardNames: async () => ({
    ok: true,
    value: { fact: workspaceFact(), refresh: leaking, repositoryRoots: [{ repo: "orders", path: `/clones/${SECRET}` }] },
  }) });

  const result = await session.callTool("ye_ast_workspace", {});

  const structured = JSON.stringify(result.structuredContent);
  assert.doesNotMatch(structured, new RegExp(SECRET));
  assert.match(structured, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  assert.doesNotMatch(textOf(result), new RegExp(SECRET));
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
  const full = textOf(await session.callTool("ye_ast_impact", { base: "main", detail: "full" }));
  assertCountedSummaryShorter(summary, full);
  await session.close();
});

test("the counted elision of a workspace and a decisions summary never renders longer than listing what it hides", async () => {
  const workspace = await setup({ outwardNames: async () => ({ ok: true, value: { fact: workspaceFact() } }) });
  assertCountedSummaryShorter(textOf(await workspace.session.callTool("ye_ast_workspace", {})), textOf(await workspace.session.callTool("ye_ast_workspace", { detail: "full" })));
  await workspace.session.close();

  const decisions = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact(DEPENDENCY_GAP) } }) });
  assertCountedSummaryShorter(textOf(await decisions.session.callTool("ye_ast_decisions", {})), textOf(await decisions.session.callTool("ye_ast_decisions", { detail: "full" })));
  await decisions.session.close();
});

test("decision text and structured full retain each evidence repository", async () => {
  const evidence = [{ repo: "caller", path: "src/app.ts", line: 7 }, { repo: "server", path: "src/app.ts", line: 7 }];
  const decision = { ...DECISIONS.decisions[0]!, evidence, options: [{ value: "server", evidence, recommended: true }] };
  const { session } = await setup({ decisions: async () => ({ ok: true, value: { fact: decisionFact({ ...DECISIONS, decisions: [decision] }) } }) });
  const result = await session.callTool("ye_ast_decisions", { detail: "full", full: true });
  const text = textOf(result);
  assert.match(text, /caller:src\/app\.ts:7/);
  assert.match(text, /server:src\/app\.ts:7/);
  const structured = result.structuredContent as { value: DecisionValue };
  assert.deepEqual(structured.value.decisions[0]?.evidence, evidence);
  await session.close();
});

test("impact text presents consequences before seeds", async () => {
  const { session } = await setup();
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main", full: true }));
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
  for (const detail of ["summary", "full"] as const) {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, detail, full: true }));
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
  for (const detail of ["summary", "full"] as const) {
    const text = textOf(await session.callTool("ye_ast_impact", { base: "main", workspace: WORKSPACE, detail }));
    assert.match(text, /shop: partial[\s\S]*trigger: unknown \(index-unavailable\)/);
    assert.match(text, /not-exported/);
    if (detail === "full") assert.match(text, /src\/omitted\.ts/);
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
  const summary = await session.callTool("ye_ast_impact", { base: "main", full: true });
  const full = await session.callTool("ye_ast_impact", { base: "main", detail: "full", full: true });
  for (const result of [summary, full]) {
    assert.deepEqual(result.structuredContent, fact);
  }
  assert.doesNotMatch(textOf(summary), /one verified origin/);
  assert.match(textOf(full), /one verified origin: src\/pages\/checkout\.component\.ts:30-45 Checkout \(resource\)/);
  assert.match(textOf(full), /1 other origin; full: true includes all/);
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
