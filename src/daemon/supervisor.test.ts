import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import { EventEmitter } from "node:events";
import type { DaemonLink } from "./daemon-link.ts";
import { ask, attached, inProcessWorkers, scratchRuntime, TEST_INSTALLATION, testLink, until } from "./daemon.testing.ts";
import { isAlive } from "./daemon-lock.ts";
import { daemonFiles } from "./runtime-directory.ts";
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
  return { directory: runtime.directory, installation: TEST_INSTALLATION, version: VERSION, idleMs: 60_000, pid: process.pid, isAlive, spawnWorker: workers.spawnWorker, signal: stop.signal, workers, ...overrides };
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const files = (): { socket: string; pid: string } => daemonFiles(runtime.directory, TEST_INSTALLATION);

/** The pid of a process that has exited, so no live process can hold it right after. */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

test("a pid file whose holder is dead and a leftover socket file are recovered: the new daemon serves", async () => {
  await writeFile(files().pid, JSON.stringify({ pid: deadPid(), version: "0.0.1" }));
  await writeFile(files().socket, "left behind");
  const served = runSupervisor(deps());
  const link = testLink(runtime.directory, VERSION);
  (await attached(link, "/repo")).destroy();
  stops[0]!.abort();
  assert.equal(await served, "served");
});

test("a pid file naming a live process that does not answer on the daemon's socket is stale: the new daemon serves", async () => {
  await writeFile(files().pid, JSON.stringify({ pid: 1, version: "0.0.1" }));
  const served = runSupervisor(deps());
  const outcome = await Promise.race([served, attached(testLink(runtime.directory, VERSION), "/repo").then((socket) => (socket.destroy(), "attached"))]);
  assert.equal(outcome, "attached");
  stops[0]!.abort();
  assert.equal(await served, "served");
});

test("two installations keep a daemon each: clients alternating between them retire neither, and both are served", async () => {
  const started: string[] = [];
  const daemons: Promise<unknown>[] = [];
  const linkOf = (installation: string): DaemonLink => {
    const version = `${VERSION}@${installation}`;
    return testLink(runtime.directory, version, {
      installation,
      spawnDaemon: () => {
        started.push(installation);
        daemons.push(runSupervisor(deps({ version, installation })));
      },
    });
  };
  const a = linkOf("/install/a");
  const b = linkOf("/install/b");
  for (const link of [a, b, a, b, a, b]) {
    const attachment = await link.attachStarting("/repo", {}, 5_000);
    if (attachment.kind !== "attached") return assert.fail(attachment.kind);
    assert.equal(((await ask(attachment.socket, 1, "echo")) as { repo: string }).repo, "/repo");
    attachment.socket.destroy();
  }
  assert.deepEqual(started, ["/install/a", "/install/b"]);
  for (const stop of stops) stop.abort();
  assert.deepEqual(await Promise.all(daemons), ["served", "served"]);
});

test("a running daemon keeps a second one of its installation out, and of two racing starts exactly one serves", async () => {
  const running = runSupervisor(deps());
  (await attached(testLink(runtime.directory, VERSION), "/repo")).destroy();
  assert.equal(await runSupervisor(deps({ pid: process.pid + 1 })), "already-running");
  stops[0]!.abort();
  assert.equal(await running, "served");

  const first = runSupervisor(deps());
  const second = runSupervisor(deps());
  const outcome = await Promise.race([first, second]);
  assert.equal(outcome, "already-running");
  for (const stop of stops) stop.abort();
  assert.deepEqual([await first, await second].sort(), ["already-running", "served"]);
});

test("a daemon stays while a worker lives, however long it goes without a new client", async () => {
  const served = runSupervisor(deps({ idleMs: 300 }));
  const link = testLink(runtime.directory, VERSION);
  const socket = await attached(link, "/repo");
  await new Promise((resolve) => setTimeout(resolve, 900));
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
  assert.equal(await exists(files().socket), false);
  assert.equal(await exists(files().pid), false);
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

test("a client of another version at the same installation retires the daemon: no new attach, the call in flight is answered, then it exits", async () => {
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
  assert.equal(await exists(files().pid), false);
});

test("an in-place upgrade: the new version's daemon takes over while the old one finishes its call in flight, and keeps serving once the old one exits", async () => {
  const old = runSupervisor(deps());
  const socket = await attached(testLink(runtime.directory, VERSION), "/repo");
  const inFlight = ask(socket, 1, "hold");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const upgraded: Promise<unknown>[] = [];
  const link = testLink(runtime.directory, "9.9.9", { spawnDaemon: () => upgraded.push(runSupervisor(deps({ version: "9.9.9" }))) });
  const fresh = await link.attachStarting("/repo", {}, 10_000);
  if (fresh.kind !== "attached") return assert.fail(fresh.kind);
  fresh.socket.destroy();
  socket.write(`${JSON.stringify({ method: "release" })}\n`);
  assert.equal((await inFlight as { repo: string }).repo, "/repo");
  assert.equal(await old, "served");
  const after = await link.attach("/repo", {});
  if (after.kind !== "attached") return assert.fail(after.kind);
  after.socket.destroy();
  for (const stop of stops) stop.abort();
  assert.ok((await Promise.all(upgraded)).includes("served"));
});

test("a client never connects through a runtime directory that is not private: it answers in process", async () => {
  const served = runSupervisor(deps());
  (await attached(testLink(runtime.directory, VERSION), "/repo")).destroy();
  assert.deepEqual(await testLink(runtime.directory, VERSION, { verify: async () => false }).attach("/repo", {}), { kind: "refused" });
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
  assert.equal(await exists(files().socket), false);
  assert.equal(await exists(files().pid), false);
});
