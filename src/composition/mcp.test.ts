import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { EXIT_CODE } from "../cli/main.ts";
import { REDACTED } from "../core/ports/redaction.port.ts";
import type { MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ComposedQueries } from "./compose.ts";
import { runMcp } from "./mcp.ts";
import type { ProcessHost } from "./process-host.ts";

interface Harness {
  host: ProcessHost;
  maps: MapRequest[];
  errors: string[];
  warmed: string[];
  composed: { count: number; options: unknown[] };
  stdin: PassThrough;
  finished: () => Promise<number>;
  call: (method: string, params?: unknown) => Promise<{ result?: { isError?: boolean }; error?: unknown }>;
  start: (args: readonly string[]) => void;
}

function harness(overrides: Partial<ProcessHost> = {}, warmLive: (repo: string) => Promise<string | null> = async () => null): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const maps: MapRequest[] = [];
  const errors: string[] = [];
  const warmed: string[] = [];
  const composed: { count: number; options: unknown[] } = { count: 0, options: [] };
  const queries = {
    version: "0.0.0",
    entrypoints: {
      map: async (request: MapRequest) => {
        maps.push(request);
        return { ok: false as const, fault: { kind: "unknown-revision" as const, detail: "stub" } };
      },
    },
    impact: {},
    redaction: { redactError: () => REDACTED },
    warmLive: async (repo: string) => {
      warmed.push(repo);
      return warmLive(repo);
    },
  } as unknown as ComposedQueries;
  const host: ProcessHost = {
    cwd: "/work/projects",
    signal: new AbortController().signal,
    stdin,
    stdout,
    err: (line) => errors.push(line),
    queries: (options) => {
      composed.count += 1;
      composed.options.push(options);
      return queries;
    },
    ...overrides,
  };
  const replies = new Map<number, (message: never) => void>();
  createInterface({ input: stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) replies.get(message.id)?.(message as never);
  });
  let id = 0;
  let running: Promise<number> | undefined;
  return {
    host,
    maps,
    errors,
    warmed,
    composed,
    stdin,
    start: (args) => {
      running = runMcp(args, host);
    },
    finished: () => running!,
    call: (method, params) =>
      new Promise((resolve) => {
        id += 1;
        replies.set(id, resolve as (message: never) => void);
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) })}\n`);
      }),
  };
}

async function open(h: Harness): Promise<void> {
  await h.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  h.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
}

test("without a repository argument the server is bound to the working directory", async () => {
  const h = harness();
  h.start([]);
  await open(h);
  await h.call("tools/call", { name: "ye_ast_entrypoints", arguments: {} });
  assert.equal(h.maps[0]?.repo, "/work/projects");
  assert.equal(h.maps[0]?.repoId, "projects");
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.ok);
});

test("a relative repository argument is resolved against the working directory", async () => {
  const h = harness();
  h.start(["shop"]);
  await open(h);
  await h.call("tools/call", { name: "ye_ast_entrypoints", arguments: {} });
  assert.equal(h.maps[0]?.repo, "/work/projects/shop");
  assert.equal(h.maps[0]?.repoId, "shop");
  h.stdin.end();
  await h.finished();
});

test("a malformed command line is a usage error that composes nothing", async () => {
  for (const args of [["a", "b"], ["--repo"]]) {
    const h = harness();
    h.start(args);
    assert.equal(await h.finished(), EXIT_CODE.usage);
    assert.equal(h.composed.count, 0);
    assert.equal(h.errors.length, 1);
  }
});

test("the server stops when the process is asked to stop and exits as interrupted", async () => {
  const stop = new AbortController();
  const h = harness({ signal: stop.signal });
  h.start([]);
  await open(h);
  stop.abort();
  assert.equal(await h.finished(), EXIT_CODE.interrupted);
});

test("the server composes its queries to read the user's trust record", async () => {
  const h = harness();
  h.start([]);
  await open(h);

  assert.deepEqual(h.composed.options, [{ trustRecord: true }]);
  h.stdin.end();
  await h.finished();
});

test("the server starts the live index of its repository once at launch and keeps serving", async () => {
  const h = harness();
  h.start(["shop"]);
  await open(h);
  await h.call("tools/call", { name: "ye_ast_entrypoints", arguments: {} });

  assert.deepEqual(h.warmed, ["/work/projects/shop"]);
  assert.equal(h.maps.length, 1);
  assert.deepEqual(h.errors, []);
  h.stdin.end();
  await h.finished();
});

test("a live index that cannot be built is reported once on stderr and never stops the server", async () => {
  const h = harness({}, async () => "ye-ast: live index not built (stub)");
  h.start([]);
  await open(h);
  await h.call("tools/call", { name: "ye_ast_entrypoints", arguments: {} });

  assert.deepEqual(h.errors, ["ye-ast: live index not built (stub)"]);
  assert.equal(h.maps.length, 1);
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.ok);
});
