import type { Readable } from "node:stream";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import { isId, isRecord } from "./guards.ts";
import { readLines } from "./lines.ts";
import { WARM_METHOD, type LineKind } from "./daemon-dialect.ts";
import type { RequestId } from "./protocol.ts";

/** The daemon could not answer this call (closed, retiring, refused or failed): its client answers it in process. */
export class DaemonUnavailableError extends Error {
  constructor(readonly reason: "closed" | "refused" | "unsupported", message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export interface DaemonDialectClient {
  /** The port's `Result` the worker answered for `request`; aborting the request's signal cancels it there. */
  call(method: string, request: object): Promise<unknown>;
  warm(repo: string, repoId: string | undefined): Promise<unknown>;
  readonly closed: boolean;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  onStale?: (notice: LiveStaleNotice) => void;
}

/**
 * The client end of a daemon worker's connection (ADR-0157 decision 6). `onLine` receives the lines the worker's
 * composition wrote for this client. The connection is never retried here: a closed one rejects every call.
 */
export function daemonDialectClient(streams: { input: Readable; output: { write(chunk: string): unknown } }, onLine: (kind: LineKind, line: string) => void): DaemonDialectClient {
  const pending = new Map<RequestId, Pending>();
  let nextId = 1;
  let closed = false;
  const handle = streams.input as Partial<{ ref(): void; unref(): void }>;
  /** The connection keeps the process alive only while a call waits on it, so an idle client exits normally. */
  const holding = (): void => (pending.size > 0 ? handle.ref?.() : handle.unref?.());

  const reader = readLines(streams.input, (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.method === "line" && isRecord(message.params)) {
      const { kind, line: text } = message.params;
      if ((kind === "measure" || kind === "diagnostic") && typeof text === "string") onLine(kind, text);
      return;
    }
    if (message.method === "stale" && isRecord(message.params) && isId(message.params.id)) {
      pending.get(message.params.id)?.onStale?.(message.params.notice as LiveStaleNotice);
      return;
    }
    if (!isId(message.id)) return;
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    holding();
    if ("result" in message) waiting?.resolve(message.result);
    else waiting?.reject(new DaemonUnavailableError("refused", isRecord(message.error) ? String(message.error.message) : "no answer"));
  });
  void reader.done.then(() => {
    closed = true;
    for (const waiting of pending.values()) waiting.reject(new DaemonUnavailableError("closed", "the daemon connection closed"));
    pending.clear();
  });
  streams.input.resume();
  holding();

  const send = (method: string, params: object, signal?: AbortSignal, onStale?: Pending["onStale"]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new DaemonUnavailableError("closed", "the daemon connection closed"));
      const id = nextId++;
      const cancel = (): unknown => streams.output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "cancel", params: { id } })}\n`);
      const settle = <T>(finish: (value: T) => void) => (value: T): void => {
        signal?.removeEventListener("abort", cancel);
        finish(value);
      };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), ...(onStale === undefined ? {} : { onStale }) });
      holding();
      streams.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });

  return {
    get closed() {
      return closed;
    },
    call: (method, request) => {
      const { signal, onStale, ...rest } = request as { signal?: AbortSignal; onStale?: Pending["onStale"] };
      if (Object.values(rest).some((value) => typeof value === "function")) return Promise.reject(new DaemonUnavailableError("unsupported", `${method} carries a callback the daemon cannot run`));
      return send(method, { request: rest, ...(onStale === undefined ? {} : { stale: true }) }, signal, onStale);
    },
    warm: (repo, repoId) => send(WARM_METHOD, { repo, ...(repoId === undefined ? {} : { repoId }) }),
  };
}
