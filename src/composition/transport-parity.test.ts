import { test } from "node:test";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { run } from "../cli/main.ts";
import { impactFact, type ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import { declaredScope } from "../core/domain/map/entrypoint-map.ts";
import { SCHEMA, type Fact, type FactBase } from "../core/domain/shared/fact.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { TraceBudget, TraceQueries } from "../core/ports/trace-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { ChangeRequest, ContractConsequencesQueries, HypothesesRequest } from "../core/ports/contract-consequences-queries.port.ts";
import type { ConsequencesValue } from "../core/domain/contracts/consequence-fact.ts";
import type { Install } from "../core/ports/install.port.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import { createMcpServer, RESULT_JSON_LABEL } from "../mcp/server.ts";
import { openSession, type ToolResult } from "../mcp/test-session.testing.ts";
import { serveQueries } from "../protocol/query-server.ts";

const REPO = "/work/shop";

const BASE: FactBase = {
  schema: SCHEMA,
  snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) },
  producer: { name: "ye-ast", version: "0.0.0" },
  inputs: { trust: "untrusted", scope: "scope-digest", declaredScope: declaredScope(), content: "content-digest", config: "config-digest", declaredConfig: {}, engines: {} },
  evidence: [],
};

/** A complete impact fact: the MCP surface renders what the others serialize, so the fake must be a real fact. */
const FACT = impactFact(BASE, { mergeBase: "b".repeat(40), seeds: [], changedEntrypoints: [], symbols: [], entrypoints: [] }, []);

const redaction: Redaction = {
  redact: (text) => text,
  redactValue: (value) => value,
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: (error) => (error instanceof Error ? error.message : String(error)),
  containsSecret: (text) => text.includes(REDACTED),
};

interface Family {
  impact: ImpactQueries;
  workspace: WorkspaceQueries;
  budgets: (ImpactBudget | undefined)[];
}

function family(): Family {
  const budgets: (ImpactBudget | undefined)[] = [];
  const answer = async (request: { budget?: ImpactBudget }) => {
    budgets.push(request.budget);
    return { ok: true, value: FACT } as never;
  };
  const impact = { ofChange: answer, callers: answer, importers: answer } as unknown as ImpactQueries;
  const workspace = { outwardNames: async () => ({ ok: true, value: { fact: FACT } } as never) } as unknown as WorkspaceQueries;
  return { impact, workspace, budgets };
}

const entrypoints = { map: async () => ({ ok: true, value: {} }) } as unknown as EntrypointQueries;
const install = { run: async () => ({ ok: true, value: {} }) } as unknown as Install;

/** The CLI accepts the flags it knows and answers a usage error otherwise. */
async function throughCli(args: readonly string[], budgets: (ImpactBudget | undefined)[]): Promise<boolean> {
  const code = await run(["impact", "--base", "HEAD", ...args, REPO], { out: () => undefined, err: () => undefined }, {
    version: "0.0.0",
    entrypoints,
    impact: { ofChange: async (request: { budget?: ImpactBudget }) => (budgets.push(request.budget), { ok: true, value: FACT } as never) } as unknown as ImpactQueries,
    outline: {} as OutlineQueries, trace: {} as TraceQueries,
    workspace: {} as WorkspaceQueries,
    decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries,
    install,
    mcpCommand: ["/bin/ye-ast"],
    redaction,
    canonicalRepositoryRoot: async (path: string) => ({ ok: true, value: path }),
    repositoryName: async () => ({ ok: true, value: "repo" }),
    signal: new AbortController().signal,
  });
  return code === 0;
}

/** The query protocol answers with a result or an error, never a usage code. */
async function throughProtocol(budget: unknown, budgets: (ImpactBudget | undefined)[]): Promise<boolean> {
  let written = "";
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "trust.declare", params: { mode: "untrusted" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "impact.ofChange", params: { repo: REPO, repoId: "shop", base: "HEAD", head: "HEAD", budget } }),
  ];
  await serveQueries(
    { version: "0.0.0", entrypoints, impact: { ofChange: async (request: { budget?: ImpactBudget }) => (budgets.push(request.budget), { ok: true, value: FACT } as never) } as unknown as ImpactQueries, outline: {} as OutlineQueries, trace: {} as TraceQueries, workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries, redaction },
    { input: Readable.from(lines.map((line) => `${line}\n`)), output: { write: (chunk: string) => void (written += chunk) } },
  );
  const answers = written.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: unknown });
  const answer = answers.find((message) => message.id === 2);
  assert.ok(answer, "the protocol answered the query");
  return answer.error === undefined;
}

/** The MCP tool answers a result or an error, and never closes the session over a bad argument. */
async function throughMcp(budget: unknown, budgets: (ImpactBudget | undefined)[]): Promise<boolean> {
  const session = await openSession(createMcpServer({
    digest: createSha256Digest(),
    version: "0.0.0",
    entrypoints,
    impact: { ofChange: async (request: { budget?: ImpactBudget }) => (budgets.push(request.budget), { ok: true, value: FACT } as never) } as unknown as ImpactQueries,
    outline: {} as OutlineQueries, trace: {} as TraceQueries,
    workspace: { outwardNames: async () => ({ ok: true, value: { fact: FACT } } as never) } as unknown as WorkspaceQueries,
    workspaceImpact: {} as unknown as WorkspaceImpactQueries,
    decisions: {} as unknown as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries,
    redaction,
    repository: { path: REPO, repoId: "shop" },
  }));
  try {
    const result = await session.callTool("ye_ast_impact", { base: "HEAD", budget });
    return (result as ToolResult).isError !== true;
  } finally {
    await session.close();
  }
}

interface Case {
  label: string;
  flags: readonly string[];
  budget: unknown;
  /** The budget every transport must hand the use case, or `undefined` when they must all refuse. */
  accepted: ImpactBudget | undefined;
}

const CASES: readonly Case[] = [
  { label: "depth", flags: ["--depth", "2"], budget: { depth: 2 }, accepted: { depth: 2 } },
  { label: "hub-fan-in", flags: ["--hub-fan-in", "3"], budget: { hubFanIn: 3 }, accepted: { hubFanIn: 3 } },
  { label: "expansions", flags: ["--expansions", "4"], budget: { expansions: 4 }, accepted: { expansions: 4 } },
  { label: "every field at once", flags: ["--depth", "1", "--hub-fan-in", "2", "--expansions", "3"], budget: { depth: 1, hubFanIn: 2, expansions: 3 }, accepted: { depth: 1, hubFanIn: 2, expansions: 3 } },
  { label: "zero", flags: ["--depth", "0"], budget: { depth: 0 }, accepted: undefined },
  { label: "a fraction", flags: ["--depth", "1.5"], budget: { depth: 1.5 }, accepted: undefined },
  { label: "a string", flags: ["--depth", "abc"], budget: { depth: "2" }, accepted: undefined },
  { label: "a field the domain does not know", flags: ["--other", "2"], budget: { other: 2 }, accepted: undefined },
];

test("the three transports accept and refuse the same budget, and hand the use case the same one", async () => {
  for (const { label, flags, budget, accepted } of CASES) {
    const cli = family();
    const protocol = family();
    const mcp = family();

    const answers = [
      await throughCli(flags, cli.budgets),
      await throughProtocol(budget, protocol.budgets),
      await throughMcp(budget, mcp.budgets),
    ];

    assert.deepEqual(answers, [accepted !== undefined, accepted !== undefined, accepted !== undefined], `${label}: the three transports agree`);
    assert.deepEqual([cli.budgets, protocol.budgets, mcp.budgets], accepted === undefined ? [[], [], []] : [[accepted], [accepted], [accepted]], `${label}: the same budget reaches the use case`);
  }
});

test("every surface that names a trust mode refuses one the domain does not know", async () => {
  const cli = await run(["init", "--trust", "sometimes", REPO], { out: () => undefined, err: () => undefined }, {
    version: "0.0.0",
    entrypoints,
    impact: family().impact,
    outline: {} as OutlineQueries, trace: {} as TraceQueries,
    workspace: {} as WorkspaceQueries,
    decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries,
    install,
    mcpCommand: ["/bin/ye-ast"],
    redaction,
    canonicalRepositoryRoot: async (path: string) => ({ ok: true, value: path }),
    repositoryName: async () => ({ ok: true, value: "repo" }),
    signal: new AbortController().signal,
  });

  let written = "";
  await serveQueries(
    { version: "0.0.0", entrypoints, impact: family().impact, outline: {} as OutlineQueries, trace: {} as TraceQueries, workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries, redaction },
    {
      input: Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "trust.declare", params: { mode: "sometimes" } })}\n`]),
      output: { write: (chunk: string) => void (written += chunk) },
    },
  );
  const answer = JSON.parse(written.split("\n").find((line) => line.includes('"id":1')) ?? "{}") as { error?: { data?: { kind?: string } } };

  assert.equal(cli, 2);
  assert.equal(answer.error?.data?.kind, "invalid-params");
});

const TRACE_FACT = { ...BASE, status: "complete", value: { roots: [], steps: [], readingPlan: { ranges: [], lines: 0 }, cost: { expanded: 0 } } };

function traceFamily(budgets: (TraceBudget | undefined)[]): TraceQueries {
  return { walk: async (request: { budget?: TraceBudget }) => (budgets.push(request.budget), { ok: true, value: TRACE_FACT } as never) } as unknown as TraceQueries;
}

test("the three transports accept the trace's own bounds and refuse the caller-count bound alike", async () => {
  const cases: readonly { flags: readonly string[]; budget: unknown; accepted: TraceBudget | undefined }[] = [
    { flags: ["--depth", "2", "--expansions", "4"], budget: { depth: 2, expansions: 4 }, accepted: { depth: 2, expansions: 4 } },
    { flags: ["--hub-fan-in", "3"], budget: { hubFanIn: 3 }, accepted: undefined },
  ];
  for (const { flags, budget, accepted } of cases) {
    const cli: (TraceBudget | undefined)[] = [];
    const protocol: (TraceBudget | undefined)[] = [];
    const mcp: (TraceBudget | undefined)[] = [];

    const cliCode = await run(["trace", ...flags, REPO, "src/a.ts:run"], { out: () => undefined, err: () => undefined }, {
      version: "0.0.0", entrypoints, impact: {} as ImpactQueries, outline: {} as OutlineQueries, trace: traceFamily(cli), workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries,
      install, mcpCommand: ["/bin/ye-ast"], redaction,
      canonicalRepositoryRoot: async (path: string) => ({ ok: true, value: path }), repositoryName: async () => ({ ok: true, value: "repo" }), signal: new AbortController().signal,
    });

    let written = "";
    await serveQueries(
      { version: "0.0.0", entrypoints, impact: {} as ImpactQueries, outline: {} as OutlineQueries, trace: traceFamily(protocol), workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries, redaction },
      {
        input: Readable.from([
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "trust.declare", params: { mode: "untrusted" } })}\n`,
          `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "trace.walk", params: { repo: REPO, repoId: "shop", revision: "HEAD", targets: [{ file: "src/a.ts", symbol: "run" }], budget } })}\n`,
        ]),
        output: { write: (chunk: string) => void (written += chunk) },
      },
    );
    const answer = written.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: number; error?: unknown }).find((message) => message.id === 2);

    const session = await openSession(createMcpServer({
      digest: createSha256Digest(), version: "0.0.0", entrypoints, impact: {} as ImpactQueries, outline: {} as OutlineQueries, trace: traceFamily(mcp),
      workspace: {} as WorkspaceQueries, workspaceImpact: {} as WorkspaceImpactQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries, redaction, repository: { path: REPO, repoId: "shop" },
    }));
    const result = await session.callTool("ye_ast_trace", { targets: [{ file: "src/a.ts", symbol: "run" }], budget }).finally(() => session.close());

    const expected = accepted !== undefined;
    assert.deepEqual([cliCode === 0, answer?.error === undefined, (result as ToolResult).isError !== true], [expected, expected, expected], JSON.stringify(budget));
    assert.deepEqual([cli, protocol, mcp], expected ? [[accepted], [accepted], [accepted]] : [[], [], []], JSON.stringify(budget));
  }
});

function traceTargets(asked: unknown[], answer: unknown): TraceQueries {
  return { walk: async (request: { targets: unknown }) => (asked.push(request.targets), answer as never) } as unknown as TraceQueries;
}

/** One trace through the CLI, the protocol and the MCP with the same targets: what each asked the family and how it answered. */
async function traceThroughEach(cliTargets: readonly string[], targets: readonly unknown[], answer: unknown) {
  const [cli, protocol, mcp]: [unknown[], unknown[], unknown[]] = [[], [], []];
  const stderr: string[] = [];
  const cliCode = await run(["trace", REPO, ...cliTargets], { out: () => undefined, err: (line: string) => void stderr.push(line) }, {
    version: "0.0.0", entrypoints, impact: {} as ImpactQueries, outline: {} as OutlineQueries, trace: traceTargets(cli, answer), workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries,
    install, mcpCommand: ["/bin/ye-ast"], redaction,
    canonicalRepositoryRoot: async (path: string) => ({ ok: true, value: path }), repositoryName: async () => ({ ok: true, value: "repo" }), signal: new AbortController().signal,
  });
  let written = "";
  await serveQueries(
    { version: "0.0.0", entrypoints, impact: {} as ImpactQueries, outline: {} as OutlineQueries, trace: traceTargets(protocol, answer), workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries, redaction },
    {
      input: Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "trust.declare", params: { mode: "untrusted" } })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "trace.walk", params: { repo: REPO, repoId: "shop", revision: "HEAD", targets } })}\n`,
      ]),
      output: { write: (chunk: string) => void (written += chunk) },
    },
  );
  const reply = written.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: number; error?: { code: number; data?: unknown } }).find((message) => message.id === 2);
  const session = await openSession(createMcpServer({
    digest: createSha256Digest(), version: "0.0.0", entrypoints, impact: {} as ImpactQueries, outline: {} as OutlineQueries, trace: traceTargets(mcp, answer),
    workspace: {} as WorkspaceQueries, workspaceImpact: {} as WorkspaceImpactQueries, decisions: {} as DecisionQueries, contractConsequences: {} as unknown as ContractConsequencesQueries, redaction, repository: { path: REPO, repoId: "shop" },
  }));
  const result = (await session.callTool("ye_ast_trace", { targets }).finally(() => session.close())) as ToolResult;
  return { asked: [cli, protocol, mcp], cliCode, stderr, reply, result };
}

test("the three transports pass an entrypoint target, by kind and the name split at the first colon, alike", async () => {
  const targets = [{ kind: "ui-route", name: "/orders/:id" }, { kind: "http-route", name: "POST /orders" }];
  const { asked, cliCode, reply, result } = await traceThroughEach(["--entrypoint", "ui-route:/orders/:id", "--entrypoint", "http-route:POST /orders"], targets, { ok: true, value: TRACE_FACT });
  assert.deepEqual([cliCode, reply?.error, result.isError === true], [0, undefined, false]);
  assert.deepEqual(asked, [[targets], [targets], [targets]]);
});

test("the three transports refuse an entrypoint kind the map does not read, asking nothing", async () => {
  const { asked, cliCode, reply, result } = await traceThroughEach(["--entrypoint", "page:/orders"], [{ kind: "page", name: "/orders" }], { ok: true, value: TRACE_FACT });
  assert.deepEqual([cliCode, reply?.error?.code, result.isError], [2, -32602, true]);
  assert.deepEqual(asked, [[], [], []]);
});

test("the three transports answer an unknown entrypoint as its own fault with the names of that kind", async () => {
  const entries = [{ kind: "http-route", name: "POST /orders", candidates: ["GET /orders"] }];
  const { cliCode, stderr, reply, result } = await traceThroughEach(["--entrypoint", "http-route:POST /orders"], [{ kind: "http-route", name: "POST /orders" }], { ok: false, fault: { kind: "unknown-entrypoint", detail: "no entrypoint", entries } });
  assert.deepEqual([cliCode, stderr.slice(1)], [1, ["  - http-route:POST /orders: the map's http-route names: GET /orders"]]);
  assert.deepEqual([reply?.error?.code, reply?.error?.data], [-32023, { kind: "unknown-entrypoint", entries }]);
  const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert.deepEqual([result.isError, /fault: unknown-entrypoint/.test(text), text.includes("http-route POST /orders: the map's http-route names: GET /orders")], [true, true, true]);
});

test("declaration targets together with entrypoint targets are refused before any query: a CLI usage error, protocol invalid params, and the MCP's invalid-argument tool error", async () => {
  const mixed = await traceThroughEach(["src/a.ts:run", "--entrypoint", "ui-route:/orders"], [{ file: "src/a.ts", symbol: "run" }, { kind: "ui-route", name: "/orders" }], { ok: true, value: TRACE_FACT });
  const badKind = await traceThroughEach(["--entrypoint", "page:/orders"], [{ kind: "page", name: "/orders" }], { ok: true, value: TRACE_FACT });
  const shape = (result: ToolResult) => [result.isError, result.content.map((part) => ("text" in part ? part.text.slice(0, part.text.indexOf(": targets")) : "")).join("")];
  assert.deepEqual([mixed.cliCode, mixed.reply?.error?.code], [2, -32602]);
  assert.deepEqual(shape(mixed.result), shape(badKind.result));
  assert.equal(shape(mixed.result)[0], true);
  assert.deepEqual(mixed.asked, [[], [], []]);
});

const HYPOTHESIS = { method: "GET", path: "/owners/{id}", target: "response", property: "name", change: "nullable" };

/** Every requested hypothesis unknown: the composite is still partial and keeps each one with its reason (RFC-0023 status table). */
const ALL_UNKNOWN = {
  ...BASE,
  status: "partial",
  cuts: [{ kind: "section", at: ["answers.0"] }, { kind: "section", at: ["answers.1"] }],
  value: {
    repositorySnapshots: [{ repo: "shop", snapshot: BASE.snapshot }],
    answers: [HYPOTHESIS, { ...HYPOTHESIS, path: "/vets" }].map((hypothesis) => ({ hypothesis, oldContract: "present-and-non-null", status: "unknown", reason: "no-project", detail: "no repository serves it" })),
  },
} as unknown as Fact<ConsequencesValue>;

/** Both revisions read and compared with no delta: no hypothesis derived, nothing cut, and the change kept. */
const NO_DERIVED = {
  ...BASE,
  status: "complete",
  value: {
    repositorySnapshots: [{ repo: "shop", snapshot: BASE.snapshot }],
    answers: [],
    change: { base: "main", head: "HEAD", snapshots: { base: "b".repeat(40), head: "c".repeat(40) }, derivation: { ...BASE, status: "complete", value: { gained: [], operations: { added: [], removed: [] }, frontiers: [] } } },
  },
} as unknown as Fact<ConsequencesValue>;

type Subject = { hypotheses: readonly object[] } | { base: string };
type Outcome = { accepted: boolean; requests: (HypothesesRequest | ChangeRequest)[]; fact?: unknown };

function consequencesPort(fact: Fact<ConsequencesValue>, requests: (HypothesesRequest | ChangeRequest)[]): ContractConsequencesQueries {
  return {
    ofHypotheses: async (request) => (requests.push(request), { ok: true, value: fact }),
    ofChange: async (request) => (requests.push(request), { ok: true, value: fact }),
  };
}

async function consequencesThroughCli(subject: Subject, fact: Fact<ConsequencesValue>): Promise<Outcome> {
  const requests: Outcome["requests"] = [];
  const out: string[] = [];
  const flags = "hypotheses" in subject ? subject.hypotheses.flatMap((hypothesis) => ["--hypothesis", JSON.stringify(hypothesis)]) : ["--base", subject.base];
  const code = await run(["contract-consequences", ...flags, REPO], { out: (line) => void out.push(line), err: () => undefined }, {
    version: "0.0.0", entrypoints, impact: family().impact, outline: {} as OutlineQueries, trace: {} as TraceQueries, workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries,
    contractConsequences: consequencesPort(fact, requests), install, mcpCommand: ["/bin/ye-ast"], redaction,
    canonicalRepositoryRoot: async (path: string) => ({ ok: true, value: path }), repositoryName: async () => ({ ok: true, value: "shop" }), signal: new AbortController().signal,
  });
  return { accepted: code === 0, requests, ...(code === 0 ? { fact: JSON.parse(out.join("\n")) } : {}) };
}

async function consequencesThroughProtocol(subject: Subject, fact: Fact<ConsequencesValue>): Promise<Outcome> {
  const requests: Outcome["requests"] = [];
  let written = "";
  const repo = { path: REPO, id: "shop" };
  const call = "hypotheses" in subject
    ? { method: "contractConsequences.ofHypotheses", params: { repo: { ...repo, revision: "HEAD" }, hypotheses: subject.hypotheses } }
    : { method: "contractConsequences.ofChange", params: { repo, base: subject.base, head: "HEAD" } };
  await serveQueries(
    { version: "0.0.0", entrypoints, impact: family().impact, outline: {} as OutlineQueries, trace: {} as TraceQueries, workspace: {} as WorkspaceQueries, decisions: {} as DecisionQueries, contractConsequences: consequencesPort(fact, requests), redaction },
    { input: Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "trust.declare", params: { mode: "untrusted" } }), JSON.stringify({ jsonrpc: "2.0", id: 2, ...call })].map((line) => `${line}\n`)), output: { write: (chunk: string) => void (written += chunk) } },
  );
  const answer = written.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }).find((message) => message.id === 2);
  assert.ok(answer, "the protocol answered the query");
  return { accepted: answer.error === undefined, requests, ...(answer.error === undefined ? { fact: answer.result } : {}) };
}

async function consequencesThroughMcp(subject: Subject, fact: Fact<ConsequencesValue>): Promise<Outcome> {
  const requests: Outcome["requests"] = [];
  const session = await openSession(createMcpServer({
    digest: createSha256Digest(), version: "0.0.0", entrypoints, impact: family().impact, outline: {} as OutlineQueries, trace: {} as TraceQueries, workspace: {} as WorkspaceQueries,
    workspaceImpact: {} as unknown as WorkspaceImpactQueries, decisions: {} as unknown as DecisionQueries, contractConsequences: consequencesPort(fact, requests), redaction, repository: { path: REPO, repoId: "shop" },
  }));
  try {
    const result = await session.callTool("ye_ast_contract_consequences", { ...subject, mode: "full" }) as ToolResult;
    if (result.isError === true) return { accepted: false, requests };
    const text = (result.content as { text: string }[])[0]!.text;
    return { accepted: true, requests, fact: JSON.parse(text.slice(text.lastIndexOf(`\n${RESULT_JSON_LABEL}`) + 1 + RESULT_JSON_LABEL.length)) };
  } finally {
    await session.close();
  }
}

test("the three transports answer the contract consequences family alike: the same subject reaches the port, an empty list is refused, and nothing an answer holds is dropped", async () => {
  const cases: { label: string; subject: Subject; fact: Fact<ConsequencesValue>; accepted: boolean }[] = [
    { label: "every hypothesis unknown", subject: { hypotheses: [HYPOTHESIS, { ...HYPOTHESIS, path: "/vets" }] }, fact: ALL_UNKNOWN, accepted: true },
    { label: "a change with no derived hypothesis", subject: { base: "main" }, fact: NO_DERIVED, accepted: true },
    { label: "an empty hypothesis list", subject: { hypotheses: [] }, fact: ALL_UNKNOWN, accepted: false },
  ];
  for (const { label, subject, fact, accepted } of cases) {
    const outcomes = [await consequencesThroughCli(subject, fact), await consequencesThroughProtocol(subject, fact), await consequencesThroughMcp(subject, fact)];
    assert.deepEqual(outcomes.map((outcome) => outcome.accepted), [accepted, accepted, accepted], `${label}: the three transports agree`);
    if (!accepted) {
      assert.deepEqual(outcomes.flatMap((outcome) => outcome.requests), [], `${label}: a refusal reaches no port`);
      continue;
    }
    const subjects = outcomes.map(({ requests }) => requests.map((request) => ("hypotheses" in request ? request.hypotheses : [request.base, request.head])));
    assert.deepEqual(subjects[1], subjects[0], `${label}: protocol hands the port what the CLI does`);
    assert.deepEqual(subjects[2], subjects[0], `${label}: MCP hands the port what the CLI does`);
    const [cli, protocol, mcp] = outcomes.map(({ fact: answered }) => answered as { status: string; value: unknown });
    assert.deepEqual(protocol, JSON.parse(JSON.stringify(fact)), `${label}: protocol serializes the fact whole`);
    assert.deepEqual(cli, protocol, `${label}: CLI prints the same fact`);
    assert.deepEqual([mcp!.status, mcp!.value], [fact.status, JSON.parse(JSON.stringify(fact.status === "unknown" ? undefined : fact.value))], `${label}: MCP full keeps status and value`);
  }
});
