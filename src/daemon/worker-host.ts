import type { Socket } from "node:net";
import { attachedLine, isRecord, type WorkerConfiguration } from "./handshake.ts";
import type { WorkerMessage } from "./supervisor.ts";

/** What a served connection tells its worker, so the worker knows when it is idle and when it may leave. */
export interface ConnectionHooks {
  /** A call started (`1`) or answered (`-1`); a `warm` counts until its priming ended. */
  busy(delta: 1 | -1): void;
  /** True once the worker retires: a new call is refused so its client answers it in process. */
  retiring(): boolean;
}

/** Serves one attached connection until its client stops writing and every call is answered. */
export type ServeConnection = (socket: Socket, hooks: ConnectionHooks) => Promise<void>;

/** The worker's end of the supervisor's IPC channel: `process` in a forked worker. */
export interface WorkerChannel {
  on(event: "message", listener: (message: unknown, handle?: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
}

export interface WorkerHostDeps {
  channel: WorkerChannel;
  pid: number;
  /** How long the worker stays without a connection and without a call before it exits. */
  idleMs: number;
  /** Composes the worker's query families for the repository and configuration; `signal` aborts when it exits. */
  start(repo: string, configuration: WorkerConfiguration, signal: AbortSignal): ServeConnection;
}

function workerMessage(message: unknown): WorkerMessage | undefined {
  if (!isRecord(message)) return undefined;
  if (message.kind === "start") return typeof message.repo === "string" && isRecord(message.configuration) ? { kind: "start", repo: message.repo, configuration: message.configuration } : undefined;
  return message.kind === "attach" || message.kind === "retire" || message.kind === "stop" ? { kind: message.kind } : undefined;
}

/**
 * Runs a worker until it is stopped, retires with no call in flight, loses its supervisor, or stays idle. Resolves once
 * its composition is aborted and every connection is closed; the process then exits.
 */
export function runWorkerHost(deps: WorkerHostDeps): Promise<void> {
  const exit = new AbortController();
  const connections = new Set<Socket>();
  let serve: ServeConnection | undefined;
  let busy = 0;
  let retiring = false;
  let idle: NodeJS.Timeout | undefined;
  let leave: () => void = () => {};
  const left = new Promise<void>((resolve) => (leave = resolve));

  const end = (): void => {
    if (exit.signal.aborted) return;
    clearTimeout(idle);
    exit.abort();
    for (const socket of connections) socket.destroy();
    leave();
  };
  const settle = (): void => {
    clearTimeout(idle);
    if (busy > 0 || exit.signal.aborted) return;
    if (retiring) return end();
    if (connections.size === 0) idle = setTimeout(end, deps.idleMs);
  };
  const hooks: ConnectionHooks = {
    busy: (delta) => {
      busy += delta;
      settle();
    },
    retiring: () => retiring,
  };
  const attach = (socket: Socket): void => {
    if (serve === undefined || retiring || exit.signal.aborted) return void socket.destroy();
    socket.on("error", () => undefined);
    connections.add(socket);
    socket.once("close", () => {
      connections.delete(socket);
      settle();
    });
    socket.write(attachedLine(deps.pid));
    settle();
    void serve(socket, hooks)
      .catch(() => undefined)
      .finally(() => socket.end());
  };

  deps.channel.on("message", (raw, handle) => {
    const message = workerMessage(raw);
    if (message?.kind === "start" && serve === undefined) serve = deps.start(message.repo, message.configuration, exit.signal);
    else if (message?.kind === "attach" && isSocket(handle)) attach(handle);
    else if (message?.kind === "retire") {
      retiring = true;
      settle();
    } else if (message?.kind === "stop") end();
  });
  deps.channel.on("disconnect", end);
  settle();
  return left;
}

function isSocket(handle: unknown): handle is Socket {
  return isRecord(handle) && typeof handle.write === "function" && typeof handle.destroy === "function";
}
