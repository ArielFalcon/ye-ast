import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { EventEmitter } from "node:events";
import { ask, attached, inProcessWorkers, scratchRuntime, testLink, until } from "./daemon.testing.ts";
import { isAlive, takeDaemonLock } from "./daemon-lock.ts";
import { PID_FILE, SOCKET_FILE } from "./runtime-directory.ts";
import { runSupervisor, type SupervisorDeps } from "./supervisor.ts";

const VERSION = "1.2.3";
let runtime: Awaited<ReturnType<typeof scratchRuntime>>;
const stops: AbortController[] = [];

beforeEach(async () => {
  runtime = await scratchRuntime();
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  await runtime.remove();
});

function deps(overrides: Partial<SupervisorDeps> = {}): SupervisorDeps & { workers: ReturnType<typeof inProcessWorkers> } {
  const stop = new AbortController();
  stops.push(stop);
  const workers = inProcessWorkers(60_000);
  return { directory: runtime.directory, version: VERSION, idleMs: 60_000, pid: process.pid, isAlive, spawnWorker: workers.spawnWorker, signal: stop.signal, workers, ...overrides };
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** The pid of a process that has exited, so no live process can hold it right after. */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

test("a pid file whose holder is dead and a leftover socket file are recovered: the new daemon serves", async () => {
  await writeFile(join(runtime.directory, PID_FILE), JSON.stringify({ pid: deadPid(), version: "0.0.1" }));
  await writeFile(join(runtime.directory, SOCKET_FILE), "left behind");
  const served = runSupervisor(deps());
  const link = testLink(runtime.directory, VERSION);
  (await attached(link, "/repo")).destroy();
  stops[0]!.abort();
  assert.equal(await served, "served");
});

test("a pid file held by a live process keeps a second daemon out, and of two racing starts exactly one serves", async () => {
  const held = await takeDaemonLock(join(runtime.directory, PID_FILE), { version: VERSION }, { pid: process.pid, isAlive });
  assert.notEqual(held, null);
  assert.equal(await runSupervisor(deps({ pid: process.pid + 1 })), "already-running");
  await held!.release();

  const first = runSupervisor(deps());
  const second = runSupervisor(deps());
  const outcome = await Promise.race([first, second]);
  assert.equal(outcome, "already-running");
  for (const stop of stops) stop.abort();
  assert.deepEqual([await first, await second].sort(), ["already-running", "served"]);
});

test("a daemon stays while a worker lives, however long it goes without a new client", async () => {
  const served = runSupervisor(deps({ idleMs: 30 }));
  const link = testLink(runtime.directory, VERSION);
  const socket = await attached(link, "/repo");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await ask(socket, 1, "echo") as { repo: string }).repo, "/repo");
  assert.equal((await link.attach("/repo", {})).kind, "attached");
  stops[0]!.abort();
  await served;
});

test("a worker that does not exit when the daemon stops is killed after the grace period", async () => {
  const exits = new EventEmitter();
  const kills: (string | undefined)[] = [];
  const served = runSupervisor(deps({ stopGraceMs: 20, spawnWorker: () => ({
    send: (message, handle) => (handle?.destroy(), true),
    once: (_event, listener) => exits.once("exit", listener),
    on: () => undefined,
    kill: (signal) => (kills.push(signal), exits.emit("exit"), true),
  }) }));
  const link = testLink(runtime.directory, VERSION);
  await until(async () => (await link.attach("/repo", {})).kind !== "absent");
  stops[0]!.abort();
  assert.equal(await served, "served");
  assert.deepEqual(kills, ["SIGKILL"]);
});

test("a daemon without a worker exits once idle, removing its socket and pid file", async () => {
  assert.equal(await runSupervisor(deps({ idleMs: 50 })), "served");
  assert.equal(await exists(join(runtime.directory, SOCKET_FILE)), false);
  assert.equal(await exists(join(runtime.directory, PID_FILE)), false);
});

test("each repository and configuration gets its own worker: a client never reaches a worker composed with another's options", async () => {
  const setup = deps();
  const served = runSupervisor(setup);
  const link = testLink(runtime.directory, VERSION);
  (await attached(link, "/a", { outputs: ["x"] })).destroy();
  const answers = [];
  for (const [repo, configuration] of [["/a", { outputs: ["x"] }], ["/a", { outputs: ["y"] }], ["/b", { outputs: ["x"] }], ["/a", { outputs: ["x"] }]] as const) {
    const attachment = await link.attach(repo, configuration);
    assert.equal(attachment.kind, "attached");
    if (attachment.kind === "attached") answers.push(await ask(attachment.socket, 7, "echo"));
  }
  assert.deepEqual(answers.map((answer) => (answer as { configuration: unknown }).configuration), [{ outputs: ["x"] }, { outputs: ["y"] }, { outputs: ["x"] }, { outputs: ["x"] }]);
  assert.deepEqual(answers.map((answer) => (answer as { repo: string }).repo), ["/a", "/a", "/b", "/a"]);
  const pids = answers.map((answer) => (answer as { pid: number }).pid);
  assert.equal(pids[0], pids[3]);
  assert.equal(new Set(pids).size, 3);
  assert.equal(setup.workers.spawned, 3);
  stops[0]!.abort();
  await served;
});

test("a client of another version retires the daemon: no new attach, the call in flight is answered, then it exits", async () => {
  const served = runSupervisor(deps());
  const link = testLink(runtime.directory, VERSION);
  const socket = await attached(link, "/repo");
  const inFlight = ask(socket, 1, "hold");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(await testLink(runtime.directory, "9.9.9").attach("/repo", {}), { kind: "version-mismatch", producer: VERSION });
  assert.equal((await link.attach("/repo", {})).kind, "absent");
  socket.write(`${JSON.stringify({ method: "release" })}\n`);
  assert.equal((await inFlight as { repo: string }).repo, "/repo");
  assert.equal(await served, "served");
  assert.equal(await exists(join(runtime.directory, PID_FILE)), false);
});

test("a client never connects through a runtime directory that is not private: it answers in process", async () => {
  const served = runSupervisor(deps());
  (await attached(testLink(runtime.directory, VERSION), "/repo")).destroy();
  assert.deepEqual(await testLink(runtime.directory, VERSION, undefined, async () => false).attach("/repo", {}), { kind: "refused" });
  stops[0]!.abort();
  await served;
});

test("stopping the daemon closes attached clients and removes the socket and the pid file", async () => {
  const served = runSupervisor(deps());
  const link = testLink(runtime.directory, VERSION);
  const socket = await attached(link, "/repo");
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.resume();
  stops[0]!.abort();
  assert.equal(await served, "served");
  await closed;
  assert.equal(await exists(join(runtime.directory, SOCKET_FILE)), false);
  assert.equal(await exists(join(runtime.directory, PID_FILE)), false);
});
