import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { test } from "node:test";
import type { Attachment, DaemonLink } from "../daemon/daemon-link.ts";
import type { ComposedQueries } from "./compose.ts";
import { daemonBackedQueries, requestWarm } from "./daemon-queries.ts";

const LOCAL = { ok: true, value: { answeredBy: "process" } };

function local(calls: string[]): ComposedQueries {
  return {
    version: "1.0.0",
    redaction: { redact: (text: string) => text },
    impact: { callers: async () => (calls.push("callers"), LOCAL) },
    warmLive: async () => (calls.push("warm"), null),
  } as unknown as ComposedQueries;
}

/** A worker end that reads requests and does what `reply` says with each; the client end goes to the link. */
function workerPair(reply: (line: string, toClient: PassThrough) => void): Socket {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  toServer.on("data", (chunk: Buffer) => chunk.toString("utf8").split("\n").filter(Boolean).forEach((line) => reply(line, toClient)));
  return Duplex.from({ readable: toClient, writable: toServer }) as unknown as Socket;
}

function link(attach: () => Attachment, starts: string[] = []): DaemonLink {
  return { attach: async () => attach(), attachStarting: async () => attach(), start: () => void starts.push("start") };
}

const options = (overrides: Partial<Parameters<typeof daemonBackedQueries>[1]> & { link: DaemonLink }) => ({ startsDaemon: false, report: () => undefined, configuration: () => ({}), ...overrides });

test("without a daemon the call is answered in process, and only the MCP server starts one", async () => {
  for (const startsDaemon of [true, false]) {
    const calls: string[] = [];
    const starts: string[] = [];
    const queries = daemonBackedQueries(local(calls), options({ link: link(() => ({ kind: "absent" }), starts), startsDaemon }));
    assert.deepEqual(await queries.impact.callers({ repo: "/r", repoId: "r", revision: "HEAD", targets: [] } as never), LOCAL);
    assert.deepEqual([calls, starts], [["callers"], startsDaemon ? ["start"] : []]);
  }
});

test("a daemon of another version is said once and every call is answered in process", async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const queries = daemonBackedQueries(local(calls), options({ link: link(() => ({ kind: "version-mismatch", producer: "0.9.0" })), report: (line) => lines.push(line) }));
  for (let index = 0; index < 2; index++) assert.deepEqual(await queries.impact.callers({ repo: "/r" } as never), LOCAL);
  assert.equal(calls.length, 2);
  assert.equal(lines.length, 1);
});

test("a connection that closes before the answer is answered in process, never with an empty result", async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const socket = workerPair((_line, toClient) => toClient.end());
  const queries = daemonBackedQueries(local(calls), options({ link: link(() => ({ kind: "attached", socket })), report: (line) => lines.push(line) }));
  assert.deepEqual(await queries.impact.callers({ repo: "/r" } as never), LOCAL);
  assert.deepEqual(calls, ["callers"]);
  assert.equal(lines.length, 1);
});

test("the daemon's answer is the call's answer, and its measurement lines reach the client's sink", async () => {
  const calls: string[] = [];
  const measured: string[] = [];
  const answer = { ok: true, value: { answeredBy: "daemon" } };
  const socket = workerPair((line, toClient) => {
    const { id } = JSON.parse(line) as { id: number };
    toClient.write(`${JSON.stringify({ jsonrpc: "2.0", method: "line", params: { kind: "measure", line: "{\"ye_ast\":{\"served\":\"daemon\"}}" } })}\n`);
    toClient.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: answer })}\n`);
  });
  const queries = daemonBackedQueries(local(calls), options({ link: link(() => ({ kind: "attached", socket })), measure: (line) => measured.push(line) }));
  assert.deepEqual(await queries.impact.callers({ repo: "/r" } as never), answer);
  assert.deepEqual(calls, []);
  assert.deepEqual(measured, ["{\"ye_ast\":{\"served\":\"daemon\"}}"]);
});

test("init's warm request returns once written, without waiting for the priming", async () => {
  const received: string[] = [];
  const socket = workerPair((line) => received.push(JSON.parse(line).method));
  assert.equal(await requestWarm(link(() => ({ kind: "attached", socket })), "/r", "r", {}), true);
  assert.deepEqual(received, ["warm"]);
  assert.equal(await requestWarm(link(() => ({ kind: "absent" })), "/r", "r", {}), false);
});

test("launch priming without a daemon runs in process", async () => {
  const calls: string[] = [];
  const queries = daemonBackedQueries(local(calls), options({ link: link(() => ({ kind: "absent" })), startsDaemon: true }));
  assert.equal(await queries.warmLive("/r", undefined, "r"), null);
  assert.deepEqual(calls, ["warm"]);
});
