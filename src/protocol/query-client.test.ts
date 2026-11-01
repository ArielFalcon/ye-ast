import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { ERROR_CODE, METHOD, PROTOCOL } from "./protocol.ts";
import { connectQueryClient, ConnectionClosedError, ProtocolMismatchError, QueryError } from "./query-client.ts";
import { serveQueries, type QueryServerDeps } from "./query-server.ts";

const identity: Redaction = {
  redact: (text) => text,
  redactValue: (value) => value,
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: String,
  containsSecret: () => false,
};

const PARAMS = { repo: "/work/shop", repoId: "shop", revision: "HEAD" };

function pair(map: EntrypointQueries["map"]): { streams: { input: PassThrough; output: PassThrough }; written: string[]; done: Promise<void> } {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const deps: QueryServerDeps = { version: "1.2.3", redaction: identity, entrypoints: { map }, impact: {} as ImpactQueries };
  const written: string[] = [];
  toServer.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  return { streams: { input: toClient, output: toServer }, written, done: serveQueries(deps, { input: toServer, output: toClient }) };
}

test("a client declares the trust mode after the hello and answers a request with the fact", async () => {
  const { streams } = pair(async (request) => ({ ok: true, value: { repoId: request.repoId } as never }));
  const client = await connectQueryClient({ ...streams, trust: "untrusted" });

  const fact = await client.request(METHOD.entrypointsMap, PARAMS);

  assert.deepEqual(fact, { repoId: "shop" });
  assert.equal(client.producer, "1.2.3");
});

test("a fault comes back as a QueryError carrying the code and kind", async () => {
  const { streams } = pair(async () => ({ ok: false, fault: { kind: "unknown-revision", detail: "no such revision" } }));
  const client = await connectQueryClient({ ...streams, trust: "untrusted" });

  await assert.rejects(client.request(METHOD.entrypointsMap, PARAMS), (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.deepEqual([error.code, error.kind], [ERROR_CODE["unknown-revision"], "unknown-revision"]);
    return true;
  });
});

test("declaring `trusted` rejects the connection with the server's refusal", async () => {
  const { streams } = pair(async () => ({ ok: true, value: {} as never }));

  await assert.rejects(connectQueryClient({ ...streams, trust: "trusted" }), (error: unknown) => error instanceof QueryError && error.kind === "trust-unsupported");
});

test("aborting the signal of a request sends a cancel that stops that call", async () => {
  const { streams } = pair(
    (request) =>
      new Promise((resolve) => request.signal?.addEventListener("abort", () => resolve({ ok: false, fault: { kind: "aborted", detail: "stopped" } }), { once: true })),
  );
  const client = await connectQueryClient({ ...streams, trust: "untrusted" });
  const aborter = new AbortController();

  const pending = client.request(METHOD.entrypointsMap, PARAMS, { signal: aborter.signal });
  aborter.abort();

  await assert.rejects(pending, (error: unknown) => error instanceof QueryError && error.kind === "aborted");
});

test("a hello of another protocol version stops the client and says which versions met", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: METHOD.hello, params: { protocol: PROTOCOL.name, version: PROTOCOL.version + 1, producer: "9" } })}\n`);

  await assert.rejects(connectQueryClient({ input, output, trust: "untrusted" }), (error: unknown) => error instanceof ProtocolMismatchError);
});

test("a connection that closes answers the requests in flight with ConnectionClosedError", async () => {
  const { streams } = pair(() => new Promise(() => {}));
  const client = await connectQueryClient({ ...streams, trust: "untrusted" });

  const pending = client.request(METHOD.entrypointsMap, PARAMS);
  streams.input.end();

  await assert.rejects(pending, (error: unknown) => error instanceof ConnectionClosedError);
});

test("a request made after the connection closed is rejected at once with ConnectionClosedError", { timeout: 2000 }, async () => {
  const { streams } = pair(async () => ({ ok: true, value: {} as never }));
  const client = await connectQueryClient({ ...streams, trust: "untrusted" });
  streams.input.end();
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(client.request(METHOD.entrypointsMap, PARAMS), (error: unknown) => error instanceof ConnectionClosedError);
});

test("aborting the signal of a request that already settled sends no cancel", async () => {
  const { streams, written } = pair(async () => ({ ok: true, value: "done" as never }));
  const client = await connectQueryClient({ ...streams, trust: "untrusted" });
  const aborter = new AbortController();
  await client.request(METHOD.entrypointsMap, PARAMS, { signal: aborter.signal });

  aborter.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(!written.join("").includes(METHOD.cancel));
});
