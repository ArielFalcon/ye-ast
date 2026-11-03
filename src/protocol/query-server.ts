import type { Readable } from "node:stream";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactFault, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { WorkspaceFault } from "../core/ports/workspace-repos.port.ts";
import { isLiveFault } from "../core/ports/live-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { isId, isRecord } from "./guards.ts";
import { readLines } from "./lines.ts";
import { deadlineOf, InvalidParamsError, readCallers, readCancelledId, readDecisions, readImporters, readMap, readOfChange, readOutline, readTrustMode, readWorkspace } from "./params.ts";
import { ERROR_CODE, METHOD, PROTOCOL, type ErrorKind, type RequestId } from "./protocol.ts";

/** What a host may ask of ye-ast: the read query families only, so no write is reachable through the protocol. */
export interface QueryServerDeps {
  version: string;
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  workspace: WorkspaceQueries;
  decisions: DecisionQueries;
  redaction: Redaction;
}

export interface QueryServerStreams {
  input: Readable;
  output: { write(chunk: string): unknown };
  /** Aborted when the process is asked to stop: every call in flight is aborted and the server ends. */
  signal?: AbortSignal;
}

type Call = (signal: AbortSignal) => Promise<Result<unknown, ImpactFault | WorkspaceFault>>;

/** Each operation reads and validates its params up front, so an invalid one is answered before any work starts. */
const OPERATIONS = new Map<string, (deps: QueryServerDeps, params: unknown) => Call>([
  [
    METHOD.entrypointsMap,
    (deps, params) => {
      const request = readMap(params);
      return (signal) => deps.entrypoints.map({ ...request, signal });
    },
  ],
  [
    METHOD.impactOfChange,
    (deps, params) => {
      const request = readOfChange(params);
      return (signal) => deps.impact.ofChange({ ...request, signal });
    },
  ],
  [
    METHOD.impactCallers,
    (deps, params) => {
      const request = readCallers(params);
      return (signal) => deps.impact.callers({ ...request, signal });
    },
  ],
  [
    METHOD.impactImporters,
    (deps, params) => {
      const request = readImporters(params);
      return (signal) => deps.impact.importers({ ...request, signal });
    },
  ],
  [
    METHOD.outlineFiles,
    (deps, params) => {
      const request = readOutline(params);
      return (signal) => deps.outline.outline({ ...request, signal });
    },
  ],
  [
    METHOD.workspaceOutwardNames,
    (deps, params) => {
      const request = readWorkspace(params);
      return (signal) => deps.workspace.outwardNames({ ...request, signal });
    },
  ],
  [
    METHOD.decisionsDecisions,
    (deps, params) => {
      const request = readDecisions(params);
      return (signal) => deps.decisions.decisions({ ...request, signal });
    },
  ],
]);

function firstLine(text: string): string {
  return text.split("\n")[0]!.trim();
}

/** Serves the query protocol on the streams until the input ends and every call in flight is answered. */
export async function serveQueries(deps: QueryServerDeps, streams: QueryServerStreams): Promise<void> {
  const { redaction } = deps;
  const shutdown = streams.signal ?? new AbortController().signal;
  const inFlight = new Map<RequestId, AbortController>();
  const running = new Set<Promise<void>>();
  let trustDeclared = false;

  const send = (message: object): void => void streams.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const succeed = (id: RequestId, result: unknown): void => send({ id, result });
  const fail = (id: RequestId | null, kind: ErrorKind, message: string, data: object = {}): void =>
    send({ id, error: { code: ERROR_CODE[kind], message, data: { kind, ...data } } });

  function declareTrust(id: RequestId, params: unknown): void {
    const mode = readTrustMode(params);
    if (mode === "trusted") return void fail(id, "trust-unsupported", "no trusted path exists yet");
    trustDeclared = true;
    succeed(id, { trust: mode });
  }

  async function query(id: RequestId, call: Call, deadline: number | undefined): Promise<void> {
    const aborter = new AbortController();
    let timedOut = false;
    const timer =
      deadline === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            aborter.abort();
          }, deadline);
    inFlight.set(id, aborter);
    try {
      const result = await call(AbortSignal.any([aborter.signal, shutdown]));
      if (result.ok) return succeed(id, redaction.redactValue(result.value));
      const { fault } = result;
      if (fault.kind === "aborted" && timedOut) return fail(id, "deadline", `the deadline of ${deadline} ms elapsed`);
      if (isLiveFault(fault)) return fail(id, "internal-error", redaction.redact(fault.detail.trim()));
      const data = fault.kind === "unknown-symbol" ? { entries: redaction.redactValue(fault.entries) } : fault.kind === "unknown-change-path" ? { globs: redaction.redactValue(fault.globs) } : {};
      fail(id, fault.kind, redaction.redact(fault.detail.trim()), data);
    } catch (error) {
      fail(id, "internal-error", firstLine(redaction.redactError(error)));
    } finally {
      clearTimeout(timer);
      inFlight.delete(id);
    }
  }

  function handleRequest(id: RequestId, method: string, params: unknown): Promise<void> | undefined {
    try {
      if (inFlight.has(id)) return void fail(null, "invalid-request", `request ${id} is still in flight`);
      if (method === METHOD.declareTrust) return void declareTrust(id, params);
      const prepare = OPERATIONS.get(method);
      if (prepare === undefined) return void fail(id, "method-not-found", method);
      if (!trustDeclared) return void fail(id, "trust-not-declared", "declare the trust mode first");
      const deadline = deadlineOf(params);
      return query(id, prepare(deps, params), deadline);
    } catch (error) {
      if (error instanceof InvalidParamsError) return void fail(id, "invalid-params", error.message);
      return void fail(id, "internal-error", firstLine(redaction.redactError(error)));
    }
  }

  function handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return fail(null, "parse-error", "the line is not JSON");
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && !isId(message.id))) {
      return fail(isRecord(message) && isId(message.id) ? message.id : null, "invalid-request", "not a JSON-RPC 2.0 request");
    }
    if (message.id === undefined) {
      if (message.method === METHOD.cancel) {
        const target = readCancelledId(message.params);
        if (target !== undefined) inFlight.get(target)?.abort();
      }
      return;
    }
    const call = handleRequest(message.id, message.method, message.params);
    if (call !== undefined) {
      const settled = call.catch(() => {}).finally(() => running.delete(settled));
      running.add(settled);
    }
  }

  send({ method: METHOD.hello, params: { protocol: PROTOCOL.name, version: PROTOCOL.version, producer: deps.version } });
  const lines = readLines(streams.input, (line) => {
    if (line.trim() !== "") handleLine(line);
  });
  shutdown.addEventListener("abort", lines.stop, { once: true });
  if (shutdown.aborted) lines.stop();
  await lines.done;
  shutdown.removeEventListener("abort", lines.stop);
  await Promise.all(running);
}
