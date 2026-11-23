import { randomUUID } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";

export interface DaemonLockDeps {
  pid: number;
  /** True when the daemon of the holder's pid runs: the pid is alive and the daemon answers. */
  running(holder: number): Promise<boolean>;
}

export interface DaemonLock {
  /** Removes the pid file when it still names this holder. */
  release(): Promise<void>;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function created(file: string, text: string): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await link(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

function holderPid(text: string): number | null {
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the pid file that makes one daemon per installation: created whole and linked into place, so no reader sees
 * it half written. A holder that is unreadable or whose daemon does not run is stale and removed only while it reads the
 * same; a running holder is another daemon, and the answer is `null`.
 */
export async function takeDaemonLock(file: string, record: { version: string }, deps: DaemonLockDeps): Promise<DaemonLock | null> {
  const text = JSON.stringify({ pid: deps.pid, version: record.version });
  for (;;) {
    if (await created(file, text)) {
      return {
        release: async () => {
          if ((await readFile(file, "utf8").catch(() => null)) === text) await rm(file, { force: true });
        },
      };
    }
    const holder = await readFile(file, "utf8").catch(() => null);
    if (holder === null) continue;
    const pid = holderPid(holder);
    if (pid !== null && (await deps.running(pid))) return null;
    if ((await readFile(file, "utf8").catch(() => null)) === holder) await rm(file, { force: true });
  }
}
