import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { daemonDialectClient, DaemonUnavailableError } from "./daemon-dialect-client.ts";
import { DAEMON_OPERATIONS, serveDaemonDialect, type CallLines, type DaemonFamilies, type DialectHooks } from "./daemon-dialect.ts";

interface Seen {
  requests: Record<string, unknown>[];
  signals: AbortSignal[];
}

const FAULT = { ok: false, fault: { kind: "unreadable", detail: "/home/someone/repo/src/a.ts cannot be read" } };
const VALUE = { ok: true, value: { fact: { snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, findings: [{ path: "src/a.ts", line: 3 }] } } };

function families(seen: Seen, overrides: Partial<Record<string, (request: Record<string, unknown>) => Promise<unknown>>> = {}): DaemonFamilies {
  const answer = (name: string) => async (request: Record<string, unknown>) => {
    seen.requests.push(request);
    seen.signals.push(request.signal as AbortSignal);
    return (overrides[name] ?? (async () => (name === "impact.callers" ? FAULT : VALUE)))(request);
  };
  const family = (name: string, operations: string[]) => Object.fromEntries(operations.map((operation) => [operation, answer(`${name}.${operation}`)]));
  return {
    entrypoints: family("entrypoints", ["map"]),
    impact: family("impact", ["ofChange", "callers", "importers"]),
    outline: family("outline", ["outline"]),
    trace: family("trace", ["walk"]),
    workspace: family("workspace", ["outwardNames"]),
    workspaceImpact: family("workspaceImpact", ["callers", "ofChange"]),
    contractConsequences: family("contractConsequences", ["ofHypotheses", "ofChange"]),
    decisions: family("decisions", ["decisions"]),
    warm: async (repo: string, repoId: string | undefined) => overrides.warm?.({ repo, repoId }) ?? null,
  } as unknown as DaemonFamilies;
}

function hooks(overrides: Partial<DialectHooks> = {}): DialectHooks & { busy: DialectHooks["busy"]; count: () => number } {
  let busy = 0;
  return { busy: (delta) => void (busy += delta), retiring: () => false, within: (_lines, call) => call(), listen: () => () => undefined, count: () => busy, ...overrides };
}

function connection(served: DaemonFamilies, serverHooks: DialectHooks = hooks(), onLine: (kind: string, line: string) => void = () => undefined) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const done = serveDaemonDialect(served, { input: toServer, output: toClient }, serverHooks);
  const client = daemonDialectClient({ input: toClient, output: toServer }, onLine);
  return { client, done, close: () => (toServer.end(), toClient.destroy()) };
}

test("an answer crosses unchanged, a typed fault with its own detail included, and the request arrives without its signal's identity", async () => {
  const seen: Seen = { requests: [], signals: [] };
  const { client } = connection(families(seen));
  const request = { repo: "/work/shop", revision: "HEAD", targets: [{ file: "src/a.ts", symbol: "A" }], signal: new AbortController().signal };
  assert.deepEqual(await client.call("impact.callers", request), FAULT);
  assert.deepEqual(await client.call("trace.walk", request), VALUE);
  assert.deepEqual({ ...seen.requests[0], signal: undefined }, { repo: "/work/shop", revision: "HEAD", targets: [{ file: "src/a.ts", symbol: "A" }], signal: undefined });
});

test("only the read operations of the query families are reachable: an administration or install method is refused", async () => {
  const seen: Seen = { requests: [], signals: [] };
  const { client } = connection(families(seen));
  for (const method of ["snapshot.open", "snapshotAdmin.retire", "fixedLayer.refresh", "install.run", "impact.constructor", "__proto__"]) {
    await assert.rejects(client.call(method, { repo: "/r" }), (error) => error instanceof DaemonUnavailableError && error.reason === "refused");
  }
  assert.equal(seen.requests.length, 0);
  assert.deepEqual([...DAEMON_OPERATIONS.keys()].filter((method) => !/^(entrypoints|impact|outline|trace|workspace|workspaceImpact|contractConsequences|decisions)\.[a-zA-Z]+$/.test(method)), []);
});

test("a request carrying a callback other than its stale notice is never sent: the daemon could not run it", async () => {
  const seen: Seen = { requests: [], signals: [] };
  const { client } = connection(families(seen));
  await assert.rejects(client.call("trace.walk", { repo: "/r", revision: "HEAD", progress: () => undefined }), (error) => error instanceof DaemonUnavailableError && error.reason === "unsupported");
  assert.equal(seen.requests.length, 0);
});

test("a live call's stale notice reaches the caller's callback before its answer", async () => {
  const seen: Seen = { requests: [], signals: [] };
  const notice = { stateId: "s1", changed: ["src/a.ts"] };
  const { client } = connection(families(seen, { "outline.outline": async (request) => ((request.onStale as (n: unknown) => void)(notice), VALUE) }));
  const order: string[] = [];
  const answer = await client.call("outline.outline", { repo: "/r", live: true, files: ["a"], onStale: (received: unknown) => order.push(JSON.stringify(received)) });
  order.push("answer");
  assert.deepEqual(answer, VALUE);
  assert.deepEqual(order, [JSON.stringify(notice), "answer"]);
});

test("aborting the caller's signal aborts the worker's call; a closed connection rejects the call, never answers it empty", async () => {
  const seen: Seen = { requests: [], signals: [] };
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const { client, close } = connection(families(seen, { "impact.importers": async () => (await blocked, VALUE) }));
  const caller = new AbortController();
  const answered = client.call("impact.importers", { repo: "/r", files: ["a"], signal: caller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  caller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen.signals[0]!.aborted, true);
  release();
  assert.deepEqual(await answered, VALUE);

  const pending = client.call("impact.importers", { repo: "/r", files: ["a"] });
  close();
  await assert.rejects(pending, (error) => error instanceof DaemonUnavailableError && error.reason === "closed");
});

test("a retiring worker refuses new calls so the client answers them in process", async () => {
  const seen: Seen = { requests: [], signals: [] };
  const { client } = connection(families(seen), hooks({ retiring: () => true }));
  await assert.rejects(client.call("entrypoints.map", { repo: "/r", revision: "HEAD" }), (error) => error instanceof DaemonUnavailableError && error.reason === "refused");
  assert.equal(seen.requests.length, 0);
});

test("the lines a call's composition writes reach that call's client, and a warm counts as busy until its priming ends", async () => {
  const seen: Seen = { requests: [], signals: [] };
  const lines: string[] = [];
  let finishWarm: (value: unknown) => void = () => {};
  const warmed = new Promise((resolve) => (finishWarm = resolve));
  const serverHooks = hooks({ within: (target: CallLines, call) => (target.send("measure", "{\"ye_ast\":{}}"), call()) });
  const { client, close, done } = connection(families(seen, { warm: () => warmed }), serverHooks, (kind, line) => lines.push(`${kind}:${line}`));
  await client.call("entrypoints.map",{ repo: "/r", revision: "HEAD" });
  assert.deepEqual(lines, ["measure:{\"ye_ast\":{}}"]);
  const warm = client.warm("/r", "shop");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(serverHooks.count(), 1);
  close();
  finishWarm(null);
  await done;
  assert.equal(serverHooks.count(), 0);
  await assert.rejects(warm, DaemonUnavailableError);
});
