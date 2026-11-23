import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ask, attached, echoServe, scratchRuntime, testLink, until } from "./daemon.testing.ts";
import { isAlive } from "./daemon-lock.ts";
import { runSupervisor } from "./supervisor.ts";
import { runWorkerHost } from "./worker-host.ts";

const VERSION = "1.2.3";
let runtime: Awaited<ReturnType<typeof scratchRuntime>>;

beforeEach(async () => {
  runtime = await scratchRuntime();
});

afterEach(async () => {
  await runtime.remove();
});

test("a worker stays while a client is attached or a call runs, and exits once idle", async () => {
  const channel = new EventEmitter();
  let exited = false;
  const host = runWorkerHost({ channel, pid: 1, idleMs: 30, start: (repo, configuration) => echoServe(repo, configuration, 1) }).then(() => (exited = true));
  channel.emit("message", { kind: "start", repo: "/repo", configuration: {} });
  const stop = new AbortController();
  const served = runSupervisor({ directory: runtime.directory, version: VERSION, idleMs: 60_000, pid: process.pid, isAlive, signal: stop.signal, spawnWorker: () => ({
    send: (message, handle) => (channel.emit("message", message, handle), true),
    once: (_event, listener) => void host.then(listener),
    on: () => undefined,
    kill: () => true,
  }) });
  const link = testLink(runtime.directory, VERSION);
  const socket = await attached(link, "/repo");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exited, false);
  socket.destroy();
  await host;
  assert.equal(exited, true);
  stop.abort();
  await served;
});

test("a crashed worker takes only its own clients down, and the next attach of its repository starts a new one", async () => {
  const stop = new AbortController();
  const children: number[] = [];
  const served = runSupervisor({ directory: runtime.directory, version: VERSION, idleMs: 60_000, pid: process.pid, isAlive, signal: stop.signal, spawnWorker: () => {
    const child = fork(join(import.meta.dirname, "echo-worker.testing.ts"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.push(child.pid!);
    return child;
  } });
  try {
    const link = testLink(runtime.directory, VERSION);
    const a = await attached(link, "/a");
    const b = await attached(link, "/b");
    const pidA = ((await ask(a, 1, "echo")) as { pid: number }).pid;
    const pidB = ((await ask(b, 1, "echo")) as { pid: number }).pid;
    assert.notEqual(pidA, pidB);
    const lost = new Promise((resolve) => a.once("close", resolve));
    process.kill(pidA, "SIGKILL");
    await lost;
    assert.equal(((await ask(b, 2, "echo")) as { pid: number }).pid, pidB);
    const again = await link.attach("/a", {});
    if (again.kind !== "attached") return assert.fail(again.kind);
    const renewed = ((await ask(again.socket, 1, "echo")) as { pid: number }).pid;
    assert.notEqual(renewed, pidA);
    assert.ok(children.includes(renewed));
  } finally {
    stop.abort();
    await served;
    await until(() => children.every((pid) => !isAlive(pid)), 10_000);
  }
});
