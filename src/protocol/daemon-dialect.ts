import type { Readable } from "node:stream";
import type { ContractConsequencesQueries } from "../core/ports/contract-consequences-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { TraceQueries } from "../core/ports/trace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";
import { isId, isRecord } from "./guards.ts";
import { readLines } from "./lines.ts";
import type { RequestId } from "./protocol.ts";

/** The read query families a daemon worker answers, and the launch priming of a repository; nothing else is reachable. */
export interface DaemonFamilies {
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  trace: TraceQueries;
  workspace: WorkspaceQueries;
  workspaceImpact: WorkspaceImpactQueries;
  contractConsequences: ContractConsequencesQueries;
  decisions: DecisionQueries;
  /** Primes `repo` for the worker's life; resolves to why it could not, or `null`. */
  warm(repo: string, repoId: string | undefined): Promise<unknown>;
}

export const WARM_METHOD = "warm";

/** The error kinds of the dialect; a client answers each of them in process. */
export const DIALECT_ERROR = { "method-not-found": -32601, "invalid-params": -32602, "internal-error": -32603, retiring: -32029 } as const;

export type LineKind = "measure" | "diagnostic";

/** Where the lines a call's composition writes go: the connection that made the call, while it is open. */
export interface CallLines {
  open(): boolean;
  send(kind: LineKind, line: string): void;
}

export interface DialectHooks {
  /** A call started (`1`) or was answered (`-1`). */
  busy(delta: 1 | -1): void;
  /** True once the worker retires: every new call is refused. */
  retiring(): boolean;
  /** Runs a call so that the lines its composition writes reach `lines`. */
  within<T>(lines: CallLines, call: () => Promise<T>): Promise<T>;
  /** Registers a connection for the lines no call wrote; returns its removal. */
  listen(lines: CallLines): () => void;
}

type Operation = (families: DaemonFamilies, request: never) => Promise<unknown>;

/** `<family>.<operation>`: the read operations of the eight query families, and only them. */
export const DAEMON_OPERATIONS: ReadonlyMap<string, Operation> = new Map<string, Operation>([
  ["entrypoints.map", (families, request) => families.entrypoints.map(request)],
  ["impact.ofChange", (families, request) => families.impact.ofChange(request)],
  ["impact.callers", (families, request) => families.impact.callers(request)],
  ["impact.importers", (families, request) => families.impact.importers(request)],
  ["outline.outline", (families, request) => families.outline.outline(request)],
  ["trace.walk", (families, request) => families.trace.walk(request)],
  ["workspace.outwardNames", (families, request) => families.workspace.outwardNames(request)],
  ["workspaceImpact.callers", (families, request) => families.workspaceImpact.callers(request)],
  ["workspaceImpact.ofChange", (families, request) => families.workspaceImpact.ofChange(request)],
  ["contractConsequences.ofHypotheses", (families, request) => families.contractConsequences.ofHypotheses(request)],
  ["contractConsequences.ofChange", (families, request) => families.contractConsequences.ofChange(request)],
  ["decisions.decisions", (families, request) => families.decisions.decisions(request)],
]);

export interface DialectStreams {
  input: Readable;
  output: { write(chunk: string): unknown; readonly writable: boolean };
}

/**
 * Serves one attached connection of a daemon worker (ADR-0157 decision 6): each call is the port's request without its
 * signal and callbacks, and its answer the port's `Result` unchanged. Resolves once the client stops writing and every
 * call is answered; a client that leaves aborts its calls in flight, never a `warm`.
 */
export async function serveDaemonDialect(families: DaemonFamilies, streams: DialectStreams, hooks: DialectHooks): Promise<void> {
  const inFlight = new Map<RequestId, AbortController>();
  const running = new Set<Promise<void>>();
  const send = (message: object): void => {
    if (streams.output.writable) streams.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const lines: CallLines = { open: () => streams.output.writable, send: (kind, line) => send({ method: "line", params: { kind, line } }) };
  const fail = (id: RequestId, kind: keyof typeof DIALECT_ERROR, message: string): void => send({ id, error: { code: DIALECT_ERROR[kind], message, data: { kind } } });

  const call = async (id: RequestId, method: string, params: Record<string, unknown>): Promise<void> => {
    const aborter = new AbortController();
    inFlight.set(id, aborter);
    hooks.busy(1);
    try {
      if (method === WARM_METHOD) {
        if (typeof params.repo !== "string") return fail(id, "invalid-params", "warm takes a repo");
        const repoId = typeof params.repoId === "string" ? params.repoId : undefined;
        return send({ id, result: await hooks.within(lines, () => families.warm(params.repo as string, repoId)) });
      }
      const operation = DAEMON_OPERATIONS.get(method);
      if (operation === undefined) return fail(id, "method-not-found", method);
      if (!isRecord(params.request)) return fail(id, "invalid-params", "params.request must be an object");
      const onStale = params.stale === true ? { onStale: (notice: LiveStaleNotice) => send({ method: "stale", params: { id, notice } }) } : {};
      const request = { ...params.request, ...onStale, signal: aborter.signal } as never;
      send({ id, result: await hooks.within(lines, () => operation(families, request)) });
    } catch (error) {
      fail(id, "internal-error", error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.delete(id);
      hooks.busy(-1);
    }
  };

  const handle = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string") return;
    if (message.id === undefined) {
      if (message.method === "cancel" && isRecord(message.params) && isId(message.params.id)) inFlight.get(message.params.id)?.abort();
      return;
    }
    if (!isId(message.id)) return;
    const id = message.id;
    if (hooks.retiring()) return fail(id, "retiring", "the daemon is exiting");
    const settled = call(id, message.method, isRecord(message.params) ? message.params : {}).finally(() => running.delete(settled));
    running.add(settled);
  };

  const unlisten = hooks.listen(lines);
  const reader = readLines(streams.input, (line) => {
    if (line.trim() !== "") handle(line);
  });
  streams.input.resume();
  await reader.done;
  for (const aborter of inFlight.values()) if (!streams.output.writable) aborter.abort();
  await Promise.all(running);
  unlisten();
}
