import { rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { takeDaemonLock } from "./daemon-lock.ts";
import { connected, DAEMON_PROTOCOL, firstLine, helloLine, helloOf, isRecord, parsed, refusedLine, type AttachParams, type WorkerConfiguration } from "./handshake.ts";
import { daemonFiles } from "./runtime-directory.ts";

/** What the supervisor tells a worker; an `attach` carries the client's socket as its handle. */
export type WorkerMessage =
  | { kind: "start"; repo: string; configuration: WorkerConfiguration }
  | { kind: "attach" }
  | { kind: "retire" }
  | { kind: "stop" };

/** A worker child process, as `child_process.fork` returns it. */
export interface WorkerProcess {
  send(message: WorkerMessage, handle?: Socket): boolean;
  once(event: "exit", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SupervisorDeps {
  /** The prepared runtime directory (ADR-0157 decision 3). */
  directory: string;
  /** The directory ye-ast is installed in: one daemon runs per installation (ADR-0157 decision 4). */
  installation: string;
  version: string;
  pid: number;
  isAlive(pid: number): boolean;
  /** How long the supervisor stays without a worker and without a pending attach before it exits. */
  idleMs: number;
  /** Forks one worker; the supervisor sends it its `start` message. */
  spawnWorker(): WorkerProcess;
  /** Aborted to stop the daemon: workers stop, the socket and the pid file go. */
  signal: AbortSignal;
  /** How long a stopped worker may take to exit before it is killed; 5 s by default. */
  stopGraceMs?: number;
}

/** How long a client may take to attach. */
const HANDSHAKE_MS = 10_000;
const STOP_GRACE_MS = 5_000;
/** How long the daemon a live pid file names may take to answer its hello, so one that has the lock and is about to listen is waited for. */
const HOLDER_ANSWER_MS = 2_000;
const HOLDER_RETRY_MS = 50;

/** Whether a daemon answers its hello on `path` before `deadline`. */
async function answersHello(path: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const socket = createConnection(path);
    socket.on("error", () => undefined);
    if ((await connected(socket)) === "connected") {
      const hello = await firstLine(socket, Math.max(0, deadline - Date.now()));
      socket.destroy();
      return helloOf(hello?.line) !== undefined;
    }
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, HOLDER_RETRY_MS));
  }
  return false;
}

function attachParams(message: unknown): AttachParams | undefined {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || message.id !== 1 || message.method !== "attach" || !isRecord(message.params)) return undefined;
  const { protocol, version, producer, repo, configuration } = message.params;
  if (typeof protocol !== "string" || typeof version !== "number" || typeof producer !== "string" || typeof repo !== "string" || repo === "" || !isRecord(configuration)) return undefined;
  return { protocol, version, producer, repo, configuration };
}

/**
 * Serves the daemon's socket until it is stopped, retires, or stays idle: one worker per repository and configuration,
 * each attached client handed to its worker. Resolves `already-running` without listening when another daemon of this
 * installation runs.
 */
export async function runSupervisor(deps: SupervisorDeps): Promise<"served" | "already-running"> {
  const { socket: socketPath, pid: pidFile } = daemonFiles(deps.directory, deps.installation);
  const lock = await takeDaemonLock(pidFile, { version: deps.version }, {
    pid: deps.pid,
    running: async (holder) => deps.isAlive(holder) && (await answersHello(socketPath, Date.now() + HOLDER_ANSWER_MS)),
  });
  if (lock === null) return "already-running";
  await rm(socketPath, { force: true });
  const workers = new Map<string, WorkerProcess>();
  let pending = 0;
  let closing: "retiring" | "stopping" | undefined;
  let idle: NodeJS.Timeout | undefined;
  let finished = false;
  let resolveServed: () => void = () => {};
  const served = new Promise<void>((resolve) => (resolveServed = resolve));

  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    clearTimeout(idle);
    deps.signal.removeEventListener("abort", stop);
    server.close();
    if (closing === undefined) await rm(socketPath, { force: true });
    await lock.release();
    resolveServed();
  };
  const settle = (): void => {
    if (workers.size > 0 || pending > 0) return void clearTimeout(idle);
    if (closing !== undefined) return void finish();
    clearTimeout(idle);
    idle = setTimeout(() => void finish(), deps.idleMs);
  };
  const close = (state: "retiring" | "stopping"): void => {
    if (closing === "stopping") return;
    closing = state;
    server.close();
    void rm(socketPath, { force: true });
    for (const worker of workers.values()) {
      worker.send({ kind: state === "retiring" ? "retire" : "stop" });
      if (state === "stopping") setTimeout(() => worker.kill("SIGKILL"), deps.stopGraceMs ?? STOP_GRACE_MS).unref();
    }
    settle();
  };
  const stop = (): void => close("stopping");

  const workerFor = (repo: string, configuration: WorkerConfiguration): WorkerProcess => {
    const key = canonicalJson([repo, configuration]);
    const known = workers.get(key);
    if (known !== undefined) return known;
    const worker = deps.spawnWorker();
    worker.on("error", () => undefined);
    worker.send({ kind: "start", repo, configuration });
    workers.set(key, worker);
    worker.once("exit", () => {
      if (workers.get(key) === worker) workers.delete(key);
      settle();
    });
    return worker;
  };

  const attach = async (socket: Socket): Promise<void> => {
    socket.on("error", () => undefined);
    socket.write(helloLine(deps.version));
    const first = await firstLine(socket, HANDSHAKE_MS);
    const params = first === null ? undefined : attachParams(parsed(first.line));
    if (first === null) return void socket.destroy();
    if (params === undefined || first.trailing) return void socket.end(refusedLine("invalid-request", "the first line must be an attach request, alone"));
    if (params.protocol !== DAEMON_PROTOCOL.name || params.version !== DAEMON_PROTOCOL.version || params.producer !== deps.version) {
      socket.end(refusedLine("version-mismatch", `this daemon runs ${DAEMON_PROTOCOL.name} ${DAEMON_PROTOCOL.version} of ye-ast ${deps.version}`));
      return close("retiring");
    }
    if (closing !== undefined) return void socket.end(refusedLine("retiring", "the daemon is exiting"));
    try {
      workerFor(params.repo, params.configuration).send({ kind: "attach" }, socket);
    } catch {
      socket.destroy();
    }
  };

  const server: Server = createServer((socket) => {
    pending += 1;
    clearTimeout(idle);
    void attach(socket).finally(() => {
      pending -= 1;
      settle();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
  deps.signal.addEventListener("abort", stop, { once: true });
  if (deps.signal.aborted) stop();
  settle();
  await served;
  return "served";
}
