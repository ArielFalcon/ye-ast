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
import { createMcpServer } from "./server.ts";
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
  symbols: [{ file: "src/OrderController.java", symbol: "OrderController.one", kind: "method", line: 17, depth: 2, confidence: 0.75, fanIn: 3, via: { file: "src/OrderService.java", symbol: "OrderService.find" }, seeds: [0] }],
  entrypoints: [{ kind: "http-route", name: "GET /orders/{id}", handler: ROUTE.kind === "http-route" ? ROUTE.handler : never(), depth: 2, confidence: 0.75, seeds: [0] }],
  cost: { expansionsUsed: 0 },
};

function never(): never {
  throw new Error("unreachable");
}

function impactFact(overrides: Partial<Fact<ImpactValue>> = {}): Fact<ImpactValue> {
  return { ...base(), status: "complete", value: IMPACT, ...overrides } as Fact<ImpactValue>;
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
  map: MapRequest[];
  ofChange: ImpactOfChangeRequest[];
  callers: ImpactCallersRequest[];
  importers: ImpactImportersRequest[];
}

interface Answers {
  map: (request: MapRequest) => Promise<Result<EntrypointMapFact, VcsFault | LiveFault>>;
  ofChange: (request: ImpactOfChangeRequest) => Promise<Result<Fact<ImpactValue>, VcsFault | LiveFault>>;
  callers: (request: ImpactCallersRequest) => Promise<Result<Fact<ImpactValue>, ImpactFault>>;
  importers: (request: ImpactImportersRequest) => Promise<Result<Fact<ImportersValue>, VcsFault | LiveFault>>;
}

async function setup(answers: Partial<Answers> = {}): Promise<{ session: Session; calls: Calls }> {
  const calls: Calls = { map: [], ofChange: [], callers: [], importers: [] };
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
  const server = createMcpServer({ version: "0.0.0", entrypoints, impact, redaction: fakeRedaction, repository: REPOSITORY });
  return { session: await openSession(server), calls };
}

const textOf = (result: { content: { text: string }[] }): string => result.content.map((block) => block.text).join("\n");

test("lists the four read tools, each described, none taking a repository", async () => {
  const { session } = await setup();
  const tools = await session.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ye_ast_callers", "ye_ast_entrypoints", "ye_ast_impact", "ye_ast_importers"]);
  for (const tool of tools) {
    assert.ok((tool.description ?? "").length > 0, tool.name);
    for (const forbidden of ["repo", "repoId", "path", "repository"]) assert.equal(tool.inputSchema.properties?.[forbidden], undefined, `${tool.name}.${forbidden}`);
  }
  const required = (name: string): string[] => tools.find((tool) => tool.name === name)?.inputSchema.required ?? [];
  assert.deepEqual(required("ye_ast_impact"), ["base"]);
  assert.deepEqual(required("ye_ast_importers"), ["files"]);
  assert.deepEqual(required("ye_ast_callers"), ["targets"]);
  assert.deepEqual(required("ye_ast_entrypoints"), []);
  await session.close();
});

test("the server instructions tell the agent when to call every tool", async () => {
  const { session } = await setup();
  const tools = await session.listTools();
  for (const tool of tools) assert.ok(session.instructions?.includes(tool.name), tool.name);
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
  assert.deepEqual(result.structuredContent, JSON.parse(JSON.stringify(mapFact())));
  const text = textOf(result);
  assert.match(text, /status: complete/);
  assert.match(text, /GET \/orders\/\{id\}/);
  assert.match(text, /src\/OrderController\.java:17/);
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
  const result = await session.callTool("ye_ast_impact", { base: "main" });
  assert.deepEqual(calls.ofChange.map(({ repo, repoId, base: from, head, budget }) => ({ repo, repoId, from, head, budget })), [
    { repo: REPOSITORY.path, repoId: REPOSITORY.repoId, from: "main", head: "HEAD", budget: undefined },
  ]);
  assert.deepEqual(result.structuredContent, JSON.parse(JSON.stringify(impactFact())));
  const text = textOf(result);
  assert.match(text, /status: complete/);
  assert.match(text, /src\/OrderService\.java:31 OrderService\.find/);
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

test("an unresolved-link cut renders the places in its anchor's file as line numbers and other files as path:line", async () => {
  const partial = impactFact({
    status: "partial",
    cuts: [{ kind: "unresolved-link", at: ["src/a.ts::A.f", "src/a.ts:18", "src/a.ts:123 no-extractor", "src/b.ts:7"] }],
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /unresolved-link at src\/a\.ts::A\.f: lines 18, 123 \(no-extractor\), src\/b\.ts:7/);
  await session.close();
});

test("impacted symbols are grouped under their file, a seed at depth 0 is not printed twice and only a confidence below 1 or a fan-in above 0 is printed", async () => {
  const grouped = impactFact({
    value: {
      seeds: [{ file: "src/a.ts", symbol: "A.seed", line: 1, basis: "requested" }],
      symbols: [
        { file: "src/a.ts", symbol: "A.seed", kind: "method", line: 1, depth: 0, confidence: 1, fanIn: 0, seeds: [0] },
        { file: "src/a.ts", symbol: "A.other", kind: "method", line: 4, depth: 1, confidence: 1, fanIn: 0, seeds: [0] },
        { file: "src/b.ts", symbol: "B.user", kind: "function", line: 9, depth: 2, confidence: 0.5, fanIn: 2, via: { file: "src/a.ts", symbol: "A.other" }, seeds: [0] },
        { file: "src/b.ts", symbol: "B.helper", kind: "function", line: 2, depth: 2, confidence: 0.5, fanIn: 1, via: { file: "src/b.ts", symbol: "B.user" }, seeds: [0] },
      ],
      entrypoints: [],
      cost: { expansionsUsed: 1 },
    },
  } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: grouped }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /impacted symbols \(3\):\n {2}src\/a\.ts\n {4}4 A\.other \[method\] \(depth 1\)\n {2}src\/b\.ts\n {4}9 B\.user \[function\] \(depth 2, confidence 0\.5, fan-in 2, via src\/a\.ts:A\.other\)\n {4}2 B\.helper \[function\] \(depth 2, confidence 0\.5, fan-in 1, via B\.user\)/);
  assert.doesNotMatch(text, /A\.seed \[method\]/);
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
  assert.equal(lines[0], "status: partial (cuts: 1 section)");
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

test("a verified-empty complete answer says none", async () => {
  const empty = impactFact({ value: { seeds: [], symbols: [], entrypoints: [] } } as Partial<Fact<ImpactValue>>);
  const { session } = await setup({ ofChange: async () => ({ ok: true, value: empty }) });
  const text = textOf(await session.callTool("ye_ast_impact", { base: "main" }));
  assert.match(text, /status: complete/);
  assert.match(text, /\(none\)/);
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
  const result = await session.callTool("ye_ast_impact", { base: "main" });
  assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(SECRET));
  assert.match(JSON.stringify(result.structuredContent), new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  assert.doesNotMatch(textOf(result), new RegExp(SECRET));
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
  ];
  assert.deepEqual(refused.map((result) => result.isError), [true, true, true, true, true, true]);
  assert.deepEqual([calls.ofChange.length, calls.importers.length, calls.callers.length], [0, 0, 0]);
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
  assert.deepEqual(results[0]?.structuredContent, mapFact());
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
  assert.deepEqual(result.structuredContent, mapFact());
  await session.close();
});

test("a live query refused under untrusted is an error result naming the command that trusts the repository", async () => {
  const { session } = await setup({ map: async () => ({ ok: false, fault: { kind: "live-requires-trusted", detail: "run `ye-ast install --trust trusted`" } }) });

  const result = await session.callTool("ye_ast_entrypoints", { live: true });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /live-requires-trusted[\s\S]*ye-ast install --trust trusted/);
  await session.close();
});
