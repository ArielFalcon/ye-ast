import type { Socket } from "node:net";

/** The daemon's protocol: ADR-0011's framing, with an `attach` that binds the connection to one worker (ADR-0157). */
export const DAEMON_PROTOCOL = { name: "ye-ast-daemon", version: 1 } as const;

/** Every handshake message fits in this many bytes; a longer first line is not a client. */
const LINE_BYTES = 64 * 1024;

export const ATTACH_ID = 1;

export const HANDSHAKE_ERROR = { "invalid-request": -32600, "version-mismatch": -32028, retiring: -32029 } as const;

export type HandshakeRefusal = keyof typeof HANDSHAKE_ERROR;

/** What composes the worker a client attaches to; the daemon reads none of it and only tells two apart. */
export type WorkerConfiguration = Readonly<Record<string, unknown>>;

export interface AttachParams {
  protocol: string;
  version: number;
  producer: string;
  repo: string;
  configuration: WorkerConfiguration;
}

export function helloLine(producer: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { protocol: DAEMON_PROTOCOL.name, version: DAEMON_PROTOCOL.version, producer } })}\n`;
}

export function attachLine(params: AttachParams): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id: ATTACH_ID, method: "attach", params })}\n`;
}

export function attachedLine(worker: number): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id: ATTACH_ID, result: { worker } })}\n`;
}

export function refusedLine(kind: HandshakeRefusal, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id: ATTACH_ID, error: { code: HANDSHAKE_ERROR[kind], message, data: { kind } } })}\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Any refused connection means no daemon listens there: none started, one exited, or a leftover path. */
export function connected(socket: Socket): Promise<"connected" | "absent"> {
  return new Promise((resolve) => {
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve("connected");
    });
    const onError = (): void => resolve("absent");
    socket.once("error", onError);
  });
}

/** Whether a first line is a daemon's hello, and the producer it names. */
export function helloOf(line: string | undefined): { producer: string } | undefined {
  const greeting = line === undefined ? undefined : parsed(line);
  if (!isRecord(greeting) || greeting.method !== "hello" || !isRecord(greeting.params)) return undefined;
  return { producer: String(greeting.params.producer) };
}

/**
 * The first line the peer writes, or `null` when it closes, writes more than a handshake holds, or says nothing within
 * `timeoutMs`. The socket is left paused with whatever followed the line put back, so the next reader loses nothing;
 * `trailing` says whether anything did.
 */
export function firstLine(socket: Socket, timeoutMs: number): Promise<{ line: string; trailing: boolean } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (answer: { line: string; trailing: boolean } | null): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      bytes += chunk.length;
      const all = Buffer.concat(chunks);
      const end = all.indexOf(0x0a);
      if (end === -1) return void (bytes > LINE_BYTES && finish(null));
      const rest = all.subarray(end + 1);
      finish({ line: all.subarray(0, end).toString("utf8"), trailing: rest.length > 0 });
      if (rest.length > 0) socket.unshift(rest);
    };
    const onClose = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}
