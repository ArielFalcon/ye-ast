import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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
  composed: { count: number; options: Parameters<ProcessHost["queries"]>[0][] };
  stdin: PassThrough;
  finished: () => Promise<number>;
  call: (method: string, params?: unknown) => Promise<{ result?: { isError?: boolean }; error?: unknown }>;
  start: (args: readonly string[]) => void;
}

function harness(
  overrides: Partial<ProcessHost> = {},
  warmLive: (repo: string) => Promise<string | null> = async () => null,
  repositoryName: ComposedQueries["repositoryName"] = async () => ({ ok: false, fault: { kind: "git-failed", detail: "stub" } }),
  canonicalRepositoryRoot: ComposedQueries["canonicalRepositoryRoot"] = async (path) => ({ ok: true, value: path }),
): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const maps: MapRequest[] = [];
  const errors: string[] = [];
  const warmed: string[] = [];
  const composed: Harness["composed"] = { count: 0, options: [] };
  const queries = {
    version: "0.0.0",
    entrypoints: {
      map: async (request: MapRequest) => {
        maps.push(request);
        return { ok: false as const, fault: { kind: "unknown-revision" as const, detail: "stub" } };
      },
    },
    impact: {},
    redaction: { redact: (text: string) => text, redactValue: (value: unknown) => value, detect: () => ({ redacted: false, patterns: [], count: 0 }), containsSecret: () => false, redactError: () => REDACTED },
    canonicalRepositoryRoot,
    repositoryName,
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

test("a worktree is bound to the name of the repository that holds it, not to its own directory name", async () => {
  const h = harness({}, async () => null, async () => ({ ok: true, value: "shop-service" }));
  h.start(["shop-service-fix-121"]);
  await open(h);
  await h.call("tools/call", { name: "ye_ast_entrypoints", arguments: {} });

  assert.equal(h.maps[0]?.repo, "/work/projects/shop-service-fix-121");
  assert.equal(h.maps[0]?.repoId, "shop-service");
  h.stdin.end();
  await h.finished();
});

test("a malformed command line is a usage error that composes nothing", async () => {
  for (const args of [["a", "b"], ["--repo"], ["--repo", "id"], ["--repo", "", "root"], ["--repo", "id", ""], ["--unknown"], ["--repo", "--unknown", "."], ["--repo", "id", "--unknown"], ["root", "--unknown", "id", "path"], ["root", "--repo", "id", "path", "extra"], [""]]) {
    const h = harness();
    h.start(args);
    h.stdin.end();
    assert.equal(await h.finished(), EXIT_CODE.usage);
    assert.equal(h.composed.count, 0);
    assert.deepEqual(h.warmed, []);
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


test("canonical declarations override launch identity and coalesce aliases without warming other roots", async () => {
  const seen: string[] = [];
  const h = harness({}, async () => null, async () => ({ ok: true, value: "natural" }), async (path) => {
    seen.push(path);
    return { ok: true, value: path.endsWith("alias") ? "/canonical/main" : path.endsWith("main") ? "/canonical/main" : "/canonical/other" };
  });
  h.start(["main", "--repo", "chosen", "alias", "--repo", "chosen", "main", "--repo", "foreign", "other"]);
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.ok);
  assert.deepEqual(seen, ["/work/projects/main", "/work/projects/alias", "/work/projects/main", "/work/projects/other"]);
  assert.deepEqual(h.warmed, ["/canonical/main"]);
  assert.equal(h.composed.count, 1);
});

test("conflicting canonical declarations fail before serving or warming", async () => {
  const h = harness({}, async () => null, undefined, async (path) => ({ ok: true, value: path.endsWith("alias") ? "/work/projects/main" : path }));
  h.start(["main", "--repo", "one", "alias", "--repo", "two", "main"]);
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.usage);
  assert.equal(h.composed.count, 1);
  assert.deepEqual(h.warmed, []);
});

test("root failures and aborts do not fall back or warm a repository", async () => {
  for (const kind of ["unreadable", "aborted"] as const) {
    const h = harness({}, async () => null, undefined, async () => ({ ok: false, fault: { kind, detail: "denied" } }));
    h.start([]);
    h.stdin.end();
    assert.equal(await h.finished(), kind === "aborted" ? EXIT_CODE.interrupted : EXIT_CODE.queryFailed);
    assert.deepEqual(h.warmed, []);
  }
});


test("launch override and distinct worktrees route through the same catalog", async () => {
  const h = harness({}, async () => null, async () => ({ ok: true, value: "natural" }), async (path) => ({ ok: true, value: path.endsWith("alias") ? "/work/projects/main" : path }));
  h.start(["main", "--repo", "launch", "alias", "--repo", "other", "linked"]);
  await open(h);
  await h.call("tools/call", { name: "ye_ast_entrypoints", arguments: {} });
  await h.call("tools/call", { name: "ye_ast_entrypoints", arguments: { repo: "other" } });
  assert.deepEqual(h.maps.map(({ repo, repoId }) => [repo, repoId]), [["/work/projects/main", "launch"], ["/work/projects/linked", "other"]]);
  assert.deepEqual(h.warmed, ["/work/projects/main"]);
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.ok);
});

test("one declared ID cannot identify distinct canonical roots", async () => {
  const h = harness();
  h.start(["main", "--repo", "same", "one", "--repo", "same", "two"]);
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.usage);
  assert.deepEqual(h.warmed, []);
});

test("cancellation during canonicalization stops preflight", async () => {
  const controller = new AbortController();
  const h = harness({ signal: controller.signal }, async () => null, undefined, async (_path, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return { ok: true, value: "/root" };
  });
  h.start([]);
  assert.equal(await h.finished(), EXIT_CODE.interrupted);
  assert.deepEqual(h.warmed, []);
});

test("--node-modules declares a build output of the launch repository only, and one that declares nothing is a usage error", async () => {
  const h = harness();
  h.start(["shop", "--node-modules", "web=deps/node_modules"]);
  await open(h);
  const declared = h.composed.options[0]?.buildOutputs;
  assert.deepEqual([declared?.("/work/projects/shop"), declared?.("/work/projects/other")], [[{ kind: "node-modules", at: "web", path: "/work/projects/deps/node_modules" }], undefined]);
  h.stdin.end();
  await h.finished();
  const plain = harness();
  plain.start(["shop"]);
  await open(plain);
  assert.equal(plain.composed.options[0]?.buildOutputs, undefined);
  plain.stdin.end();
  await plain.finished();
  for (const args of [["shop", "--node-modules"], ["shop", "--node-modules", "../up=/host/node_modules"]]) {
    const refused = harness();
    refused.start(args);
    refused.stdin.end();
    assert.equal(await refused.finished(), EXIT_CODE.usage, args.join(" "));
    assert.equal(refused.composed.count, 0);
  }
});

test("--jdk declares a JDK of the launch repository only, at the root or at <at>=, and a spec that declares nothing is a usage error", async () => {
  const h = harness();
  h.start(["shop", "--jdk", "/host/jdk", "--jdk", "svc=/host/svc-jdk"]);
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.ok);
  const declared = h.composed.options[0]?.buildOutputs;
  assert.deepEqual(
    [declared?.("/work/projects/shop"), declared?.("/work/projects/other")],
    [[{ kind: "jdk", at: "", path: "/host/jdk" }, { kind: "jdk", at: "svc", path: "/host/svc-jdk" }], undefined],
  );
  for (const args of [["shop", "--jdk"], ["shop", "--jdk", "../up=/host/jdk"], ["shop", "--jdk", "svc="]]) {
    const refused = harness();
    refused.start(args);
    refused.stdin.end();
    assert.equal(await refused.finished(), EXIT_CODE.usage, args.join(" "));
    assert.equal(refused.composed.count, 0);
  }
});

test("--java-sources declares a generated source directory of the launch repository only, and one that names no at is a usage error", async () => {
  const h = harness();
  h.start(["shop", "--java-sources", "target/generated-sources/openapi=deps/generated"]);
  h.stdin.end();
  assert.equal(await h.finished(), EXIT_CODE.ok);
  const declared = h.composed.options[0]?.buildOutputs;
  assert.deepEqual([declared?.("/work/projects/shop"), declared?.("/work/projects/other")], [[{ kind: "java-sources", at: "target/generated-sources/openapi", path: "/work/projects/deps/generated" }], undefined]);
  for (const args of [["shop", "--java-sources"], ["shop", "--java-sources", "deps/generated"], ["shop", "--java-sources", "=/host/generated"]]) {
    const refused = harness();
    refused.start(args);
    refused.stdin.end();
    assert.equal(await refused.finished(), EXIT_CODE.usage, args.join(" "));
    assert.equal(refused.composed.count, 0);
  }
});
