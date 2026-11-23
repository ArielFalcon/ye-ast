import type { Socket } from "node:net";
import { ATTACH_ID, attachLine, connected, DAEMON_PROTOCOL, firstLine, helloOf, isRecord, parsed, type WorkerConfiguration } from "./handshake.ts";
import { daemonFiles } from "./runtime-directory.ts";

/** How a client's attach ended: a socket bound to its worker, or why it answers in process. */
export type Attachment =
  | { kind: "attached"; socket: Socket }
  | { kind: "absent" }
  | { kind: "version-mismatch"; producer: string }
  | { kind: "retiring" }
  | { kind: "refused" }
  | { kind: "failed" };

export interface DaemonLinkDeps {
  directory: string;
  /** The directory ye-ast is installed in: its daemon is the one this link reaches. */
  installation: string;
  version: string;
  /** Opens a connection to the socket path: `net.createConnection`. */
  connect(path: string): Socket;
  /** Starts a daemon detached from this process. */
  spawnDaemon(): void;
  now(): number;
  /** True while the runtime directory is private to this account; a client never connects through one that is not. */
  verify(): Promise<boolean>;
}

export interface DaemonLink {
  /** Binds a connection to the worker of `repo` and `configuration`; the socket comes back paused. */
  attach(repo: string, configuration: WorkerConfiguration): Promise<Attachment>;
  /** Starts the daemon, at most once a minute from this process. */
  start(): void;
  /**
   * Attaches, and while no daemon of this version answers (none, or one of another version that retires) starts one and
   * tries again until `timeoutMs` passed.
   */
  attachStarting(repo: string, configuration: WorkerConfiguration, timeoutMs: number): Promise<Attachment>;
}

const HANDSHAKE_MS = 10_000;
const START_INTERVAL_MS = 60_000;
const RETRY_MS = 100;
/** A daemon started while the previous one still exits loses the lock and leaves; another is started after this long. */
const RESPAWN_MS = 1_000;

function refusal(message: unknown): string | undefined {
  if (!isRecord(message) || message.id !== ATTACH_ID || !isRecord(message.error) || !isRecord(message.error.data)) return undefined;
  return typeof message.error.data.kind === "string" ? message.error.data.kind : undefined;
}

export function daemonLink(deps: DaemonLinkDeps): DaemonLink {
  let startedAt: number | undefined;

  const attach = async (repo: string, configuration: WorkerConfiguration): Promise<Attachment> => {
    if (!(await deps.verify())) return { kind: "refused" };
    const socket = deps.connect(daemonFiles(deps.directory, deps.installation).socket);
    const reached = await connected(socket);
    if (reached !== "connected") return { kind: reached };
    socket.on("error", () => undefined);
    const fail = (): Attachment => {
      socket.destroy();
      return { kind: "failed" };
    };
    const hello = await firstLine(socket, HANDSHAKE_MS);
    const greeting = helloOf(hello?.line);
    if (greeting === undefined) return fail();
    const { producer } = greeting;
    socket.resume();
    socket.write(attachLine({ protocol: DAEMON_PROTOCOL.name, version: DAEMON_PROTOCOL.version, producer: deps.version, repo, configuration }));
    const answer = await firstLine(socket, HANDSHAKE_MS);
    const reply = answer === null ? undefined : parsed(answer.line);
    const refused = refusal(reply);
    if (refused === "version-mismatch") {
      socket.destroy();
      return { kind: "version-mismatch", producer };
    }
    if (refused === "retiring") {
      socket.destroy();
      return { kind: "retiring" };
    }
    if (!isRecord(reply) || reply.id !== ATTACH_ID || !isRecord(reply.result)) return fail();
    return { kind: "attached", socket };
  };

  const spawnAfter = (intervalMs: number): void => {
    const now = deps.now();
    if (startedAt !== undefined && now - startedAt < intervalMs) return;
    startedAt = now;
    deps.spawnDaemon();
  };

  return {
    attach,
    start: () => spawnAfter(START_INTERVAL_MS),
    attachStarting: async (repo, configuration, timeoutMs) => {
      const deadline = deps.now() + timeoutMs;
      for (;;) {
        const attachment = await attach(repo, configuration);
        if (attachment.kind === "attached" || attachment.kind === "failed" || attachment.kind === "refused" || deps.now() >= deadline) return attachment;
        if (attachment.kind === "absent") spawnAfter(RESPAWN_MS);
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    },
  };
}
