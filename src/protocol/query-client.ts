import type { Readable } from "node:stream";
import { isId, isRecord } from "./guards.ts";
import { readLines } from "./lines.ts";
import { ERROR_CODE, METHOD, PROTOCOL, type ErrorKind, type RequestId, type TrustMode } from "./protocol.ts";

/** The server answered a request with an error of the closed set. */
export class QueryError extends Error {
  constructor(
    readonly code: number,
    readonly kind: ErrorKind,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

/** The server's hello names another protocol or version than this client speaks. */
export class ProtocolMismatchError extends Error {
  constructor(
    readonly offered: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolMismatchError";
  }
}

export class ConnectionClosedError extends Error {
  constructor() {
    super("the connection closed");
    this.name = "ConnectionClosedError";
  }
}

export interface QueryClientStreams {
  /** What the server writes. */
  input: Readable;
  /** Where requests go. */
  output: { write(chunk: string): unknown };
  trust: TrustMode;
}

export interface QueryClient {
  /** The ye-ast version the server's hello announced. */
  producer: string;
  /** The fact `method` answers; aborting `signal` sends the server a cancel for this request. */
  request(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const KINDS = new Map<number, ErrorKind>(Object.entries(ERROR_CODE).map(([kind, code]) => [code, kind as ErrorKind]));

/** Reads the hello, declares the trust mode and returns a client; rejects when the hello does not match or the trust is refused. */
export async function connectQueryClient(streams: QueryClientStreams): Promise<QueryClient> {
  const pending = new Map<RequestId, Pending>();
  let nextId = 1;
  let closed = false;
  let greeted = false;
  let hello: (message: unknown) => void = () => {};
  const greeting = new Promise<unknown>((resolve) => (hello = resolve));

  const lines = readLines(streams.input, (line) => {
    const message = parseLine(line);
    if (!greeted) {
      greeted = true;
      return hello(message);
    }
    if (!isRecord(message) || !isId(message.id)) return;
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (isRecord(message.error)) {
      const { code, message: text, data } = message.error;
      waiting?.reject(new QueryError(code as number, KINDS.get(code as number) ?? "internal-error", String(text), data));
    } else {
      waiting?.resolve(message.result);
    }
  });
  const ended = lines.done.then(() => {
    closed = true;
    for (const waiting of pending.values()) waiting.reject(new ConnectionClosedError());
    pending.clear();
  });

  const offered = await Promise.race([greeting, ended.then(() => Promise.reject(new ConnectionClosedError()))]);
  const params = isRecord(offered) && offered.method === METHOD.hello && isRecord(offered.params) ? offered.params : undefined;
  if (params?.protocol !== PROTOCOL.name || params.version !== PROTOCOL.version) {
    lines.stop();
    throw new ProtocolMismatchError(offered, `this client speaks ${PROTOCOL.name} version ${PROTOCOL.version}`);
  }

  const request: QueryClient["request"] = (method, requestParams, { signal } = {}) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new ConnectionClosedError());
      const id = nextId++;
      const cancel = (): unknown => streams.output.write(`${JSON.stringify({ jsonrpc: "2.0", method: METHOD.cancel, params: { id } })}\n`);
      const settled = <T>(settle: (value: T) => void) => (value: T): void => {
        signal?.removeEventListener("abort", cancel);
        settle(value);
      };
      pending.set(id, { resolve: settled(resolve), reject: settled(reject) });
      streams.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: requestParams })}\n`);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });

  try {
    await request(METHOD.declareTrust, { mode: streams.trust });
  } catch (error) {
    lines.stop();
    throw error;
  }
  return { producer: String(params.producer), request };
}
