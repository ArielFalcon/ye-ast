import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLink, type DaemonLink } from "./daemon-link.ts";
import { isRecord, parsed, type WorkerConfiguration } from "./handshake.ts";
import type { WorkerProcess } from "./supervisor.ts";
import { runWorkerHost, type ServeConnection } from "./worker-host.ts";

/** A private runtime directory under the system temporary directory, never the user's. */
export async function scratchRuntime(): Promise<{ directory: string; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "ye-ast-d-"));
  return { directory, remove: () => rm(directory, { recursive: true, force: true }) };
}

/**
 * Answers each line `{id, method}` with `{id, result: {repo, configuration, pid}}`; `hold` answers only once `release`
 * is written on any connection of the worker, and `retiring` is answered when the worker retires.
 */
export function echoServe(repo: string, configuration: WorkerConfiguration, pid: number): ServeConnection {
  const held = new EventEmitter();
  return (socket, hooks) =>
    new Promise<void>((done) => {
      let rest = "";
      let open = 0;
      let ended = false;
      const settle = (): void => {
        if (ended && open === 0) done();
      };
      const answer = (id: unknown, result: unknown): void => void socket.write(`${JSON.stringify({ id, result })}\n`);
      socket.on("data", (chunk: Buffer) => {
        const lines = (rest + chunk.toString("utf8")).split("\n");
        rest = lines.pop()!;
        for (const line of lines) {
          const message = parsed(line);
          if (!isRecord(message)) continue;
          if (message.method === "release") held.emit("release");
          if (message.id === undefined) continue;
          if (hooks.retiring()) {
            answer(message.id, "retiring");
            continue;
          }
          hooks.busy(1);
          open += 1;
          const reply = (): void => {
            answer(message.id, { repo, configuration, pid });
            hooks.busy(-1);
            open -= 1;
            settle();
          };
          if (message.method === "hold") held.once("release", reply);
          else reply();
        }
      });
      socket.once("end", () => {
        ended = true;
        settle();
      });
      socket.once("close", () => done());
      socket.resume();
    });
}

/** Workers that run in this process on the real worker host, each with its own fake pid, over a fake IPC channel. */
export function inProcessWorkers(idleMs: number): { spawnWorker(): WorkerProcess; spawned: number } {
  let nextPid = 1000;
  const state = { spawned: 0 };
  return {
    get spawned() {
      return state.spawned;
    },
    spawnWorker: () => {
      state.spawned += 1;
      const pid = nextPid++;
      const channel = new EventEmitter();
      const process = new EventEmitter();
      void runWorkerHost({ channel, pid, idleMs, start: (repo, configuration) => echoServe(repo, configuration, pid) }).then(() => process.emit("exit"));
      return {
        send: (message, handle) => {
          setImmediate(() => channel.emit("message", message, handle));
          return true;
        },
        once: (event, listener) => process.once(event, listener),
        on: (event, listener) => process.on(event, listener),
        kill: () => {
          channel.emit("message", { kind: "stop" });
          return true;
        },
      };
    },
  };
}

export function testLink(directory: string, version: string, spawnDaemon: () => void = () => undefined): DaemonLink {
  return daemonLink({ directory, version, connect: (path) => createConnection(path), spawnDaemon, now: () => Date.now() });
}

/** Writes a request line on an attached socket and resolves its answer's `result`. */
export function ask(socket: Socket, id: number, method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let rest = "";
    const onData = (chunk: Buffer): void => {
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop()!;
      for (const line of lines) {
        const message = parsed(line);
        if (isRecord(message) && message.id === id) {
          socket.off("data", onData);
          resolve(message.result);
        }
      }
    };
    socket.on("data", onData);
    socket.once("close", () => reject(new Error("closed")));
    socket.resume();
    socket.write(`${JSON.stringify({ id, method })}\n`);
  });
}

/** Attaches once the daemon listens; the earlier attempts found no socket and left nothing open. */
export async function attached(link: DaemonLink, repo: string, configuration: WorkerConfiguration = {}): Promise<Socket> {
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 10))) {
    const attachment = await link.attach(repo, configuration);
    if (attachment.kind === "attached") return attachment.socket;
    if (attachment.kind !== "absent") throw new Error(attachment.kind);
  }
  throw new Error("the daemon never listened");
}

export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
