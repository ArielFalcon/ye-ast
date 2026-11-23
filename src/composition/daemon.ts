import { fork, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODE } from "../cli/main.ts";
import { daemonLink, type DaemonLink } from "../daemon/daemon-link.ts";
import { isAlive } from "../daemon/daemon-lock.ts";
import { runtimeDirectory, runtimeDirectoryRefusal } from "../daemon/runtime-directory.ts";
import { runSupervisor } from "../daemon/supervisor.ts";
import { ownVersion } from "./installed-versions.ts";

/** How long a worker, or a supervisor without workers, stays without a client (ADR-0157 decision 10). */
export const DAEMON_IDLE_MS = 30 * 60 * 1000;

/** The environment variable whose value `off` keeps every client in process (ADR-0157 decision 11). */
export const DAEMON_SWITCH = "YE_AST_DAEMON";

const OWN_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EXTENSION = extname(fileURLToPath(import.meta.url));

/**
 * What a client and a daemon must share to talk: the ye-ast version and the installation it runs from, so two
 * checkouts of one version never answer for each other (ADR-0157 decision 5).
 */
export function daemonProducer(): string {
  return `${ownVersion()}@${join(OWN_DIRECTORY, "..", "..")}`;
}

export interface DaemonEnvironment {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number | undefined;
}

/** The runtime directory of this environment, or `null` when the daemon is switched off or the platform has none. */
export function daemonDirectory(environment: DaemonEnvironment): string | null {
  if (environment.env[DAEMON_SWITCH] === "off") return null;
  return runtimeDirectory({ ...environment, tmpdir: tmpdir() });
}

/** Starts `ye-ast daemon` detached from this process, in its own session, with no standard stream of ours. */
function spawnDaemon(): void {
  const child = spawn(process.execPath, [...process.execArgv, join(OWN_DIRECTORY, `main${EXTENSION}`), "daemon"], { detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => undefined);
  child.unref();
}

/** The link of this process to the daemon of `directory`: attaching through a directory that is not private answers in process. */
export function processDaemonLink(directory: string, ownerUid: number): DaemonLink {
  return daemonLink({
    directory,
    version: daemonProducer(),
    connect: (path) => createConnection(path),
    spawnDaemon,
    now: () => Date.now(),
    verify: async () => (await runtimeDirectoryRefusal(directory, ownerUid).catch(() => "unusable")) === null,
  });
}

/** `ye-ast daemon`: the supervisor in the foreground until it is stopped, retires or stays idle. */
export async function runDaemon(environment: DaemonEnvironment, signal: AbortSignal, err: (line: string) => void): Promise<number> {
  const directory = runtimeDirectory({ ...environment, tmpdir: tmpdir() });
  if (directory === null || environment.uid === undefined) {
    err("ye-ast: the daemon needs Unix sockets and account ids; clients answer in process here");
    return EXIT_CODE.usage;
  }
  const refusal = await runtimeDirectoryRefusal(directory, environment.uid).catch((error: Error) => error.message);
  if (refusal !== null) {
    err(`ye-ast: daemon runtime directory refused: ${refusal}`);
    return EXIT_CODE.usage;
  }
  await runSupervisor({
    directory,
    version: daemonProducer(),
    idleMs: DAEMON_IDLE_MS,
    pid: process.pid,
    isAlive,
    signal,
    spawnWorker: () => fork(join(OWN_DIRECTORY, `daemon-worker${EXTENSION}`), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] }),
  });
  return EXIT_CODE.ok;
}
