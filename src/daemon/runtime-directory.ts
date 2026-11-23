import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { privateToOwner } from "../core/domain/shared/private-to-owner.ts";

export const SOCKET_FILE = "daemon.sock";
export const PID_FILE = "daemon.pid";

/** The longest socket path the platform binds: `sun_path` holds 104 bytes on macOS and 108 on Linux, with its terminator. */
const SOCKET_PATH_BYTES: Readonly<Partial<Record<NodeJS.Platform, number>>> = { darwin: 103, linux: 107 };

export interface RuntimeEnvironment {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The account id; absent where the platform has none. */
  uid: number | undefined;
  tmpdir: string;
}

/**
 * The per-user directory of the daemon's socket and pid file, or `null` where the platform has no account ids or Unix
 * sockets: `$XDG_RUNTIME_DIR/ye-ast` when that is absolute, otherwise `<tmpdir>/ye-ast-<uid>`; when its socket path would
 * not bind, a directory under `/tmp` named by the preferred one's digest, so two temporary directories never share one.
 */
export function runtimeDirectory(environment: RuntimeEnvironment): string | null {
  const limit = SOCKET_PATH_BYTES[environment.platform];
  if (limit === undefined || environment.uid === undefined) return null;
  const runtime = environment.env.XDG_RUNTIME_DIR;
  const preferred = runtime !== undefined && isAbsolute(runtime) ? join(runtime, "ye-ast") : join(environment.tmpdir, `ye-ast-${environment.uid}`);
  if (Buffer.byteLength(join(preferred, SOCKET_FILE)) <= limit) return preferred;
  return join("/tmp", `ye-ast-${environment.uid}-${createHash("sha256").update(preferred).digest("hex").slice(0, 16)}`);
}

/**
 * Creates the directory with mode 0700 when absent; why it cannot hold the daemon's socket (a symbolic link, another
 * account's, or open to other accounts: the `--cache` rule), or `null` when it is private to `ownerUid`.
 */
export async function runtimeDirectoryRefusal(directory: string, ownerUid: number): Promise<string | null> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const status = await lstat(directory);
  const refusal = privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, ownerUid);
  return refusal === null ? null : `${directory} ${refusal}`;
}
