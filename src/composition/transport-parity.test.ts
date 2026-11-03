import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { run } from "../cli/main.ts";
import { impactFact, type ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import { declaredScope } from "../core/domain/map/entrypoint-map.ts";
import { SCHEMA, type FactBase } from "../core/domain/shared/fact.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { Install } from "../core/ports/install.port.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import { createMcpServer } from "../mcp/server.ts";
import { openSession, type ToolResult } from "../mcp/test-session.ts";
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
    install,
    mcpCommand: ["/bin/ye-ast"],
    redaction,
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
    { version: "0.0.0", entrypoints, impact: { ofChange: async (request: { budget?: ImpactBudget }) => (budgets.push(request.budget), { ok: true, value: FACT } as never) } as unknown as ImpactQueries, redaction },
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
    version: "0.0.0",
    entrypoints,
    impact: { ofChange: async (request: { budget?: ImpactBudget }) => (budgets.push(request.budget), { ok: true, value: FACT } as never) } as unknown as ImpactQueries,
    workspace: { outwardNames: async () => ({ ok: true, value: { fact: FACT } } as never) } as unknown as WorkspaceQueries,
    workspaceImpact: {} as unknown as WorkspaceImpactQueries,
    decisions: {} as unknown as DecisionQueries,
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
    install,
    mcpCommand: ["/bin/ye-ast"],
    redaction,
    signal: new AbortController().signal,
  });

  let written = "";
  await serveQueries(
    { version: "0.0.0", entrypoints, impact: family().impact, redaction },
    {
      input: Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "trust.declare", params: { mode: "sometimes" } })}\n`]),
      output: { write: (chunk: string) => void (written += chunk) },
    },
  );
  const answer = JSON.parse(written.split("\n").find((line) => line.includes('"id":1')) ?? "{}") as { error?: { data?: { kind?: string } } };

  assert.equal(cli, 2);
  assert.equal(answer.error?.data?.kind, "invalid-params");
});
