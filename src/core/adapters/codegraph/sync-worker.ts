import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";
import type { StoredFiles } from "./mirror-files.ts";
import type { StoredVersions } from "./store-version.ts";

/** One line on the worker's stdin. `reopen` drops the open store first, so the sync starts from what is on disk. */
export type WorkerRequest = { op: "sync"; paths: readonly string[]; reopen: boolean } | { op: "release" };

export type SyncAnswer =
  | ({ kind: "synced"; filesFailed: readonly string[]; stored: StoredVersions; codegraph: string | null } & StoredFiles)
  | { kind: "stage-failed" | "failed" | "unreadable"; detail: string }
  | { kind: "locked" };

/** One line on the worker's stdout per request, in request order. */
export type WorkerAnswer = SyncAnswer | { kind: "released" };

export interface WorkerLaunch {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

export type SpawnWorker = (launch: WorkerLaunch) => ChildProcess;

/** `null`: the worker died or answered nothing readable, so the caller runs this one sync in a child of its own. */
type Outcome<A> = A | "aborted" | null;

export interface SyncWorkers {
  sync(root: string, paths: readonly string[], launch: () => Promise<WorkerLaunch>, signal?: AbortSignal): Promise<Outcome<SyncAnswer>>;
  /** Closes the store the root's worker holds, so a rebuild replaces it without an open handle. */
  release(root: string, signal?: AbortSignal): Promise<"aborted" | undefined>;
  /** Ends every worker's input; each closes its store and exits once its request in flight is answered. */
  close(): void;
}

interface Worker {
  child: ChildProcess;
  dead: boolean;
  /** The store generation as this worker's last answer left it. */
  generation: string;
  settle: ((outcome: Outcome<WorkerAnswer>) => void) | null;
}

type Handle = { ref?(): void; unref?(): void } | null;

/**
 * One long-lived child per mirror root, asked one request at a time. The child keeps the engine, its grammars and the
 * open store between syncs; it is idle and unreferenced between requests, so it never keeps the host process alive.
 */
export function createSyncWorkers(spawnWorker: SpawnWorker, shutdown?: AbortSignal): SyncWorkers {
  const workers = new Map<string, Worker>();
  const queues = new Map<string, Promise<unknown>>();

  function serialized<T>(root: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(root) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    queues.set(root, tail);
    void tail.then(() => {
      if (queues.get(root) === tail) queues.delete(root);
    });
    return run;
  }

  function retire(root: string, worker: Worker): void {
    worker.dead = true;
    if (workers.get(root) === worker) workers.delete(root);
    worker.child.kill();
    worker.settle?.(null);
  }

  function start(root: string, launch: WorkerLaunch): Worker {
    const child = spawnWorker(launch);
    const worker: Worker = { child, dead: false, generation: "", settle: null };
    let buffered = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        const answer = parsed(line);
        if (answer === null) retire(root, worker);
        else worker.settle?.(answer);
      }
    });
    const lost = () => retire(root, worker);
    child.on("error", lost).on("exit", lost);
    child.stdin?.on("error", lost);
    hold(worker, false);
    workers.set(root, worker);
    return worker;
  }

  function ask(worker: Worker, request: WorkerRequest, root: string, signal?: AbortSignal): Promise<Outcome<WorkerAnswer>> {
    if (worker.dead) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise<Outcome<WorkerAnswer>>((resolve) => {
      const onAbort = () => {
        settle("aborted");
        retire(root, worker);
      };
      const settle = (outcome: Outcome<WorkerAnswer>) => {
        worker.settle = null;
        signal?.removeEventListener("abort", onAbort);
        if (!worker.dead) hold(worker, false);
        resolve(outcome);
      };
      worker.settle = settle;
      signal?.addEventListener("abort", onAbort, { once: true });
      hold(worker, true);
      worker.child.stdin?.write(`${JSON.stringify(request)}\n`);
    });
  }

  function close(): void {
    for (const [root, worker] of workers) {
      workers.delete(root);
      worker.child.stdin?.end();
    }
  }

  shutdown?.addEventListener("abort", close, { once: true });

  return {
    sync: (root, paths, launch, signal) =>
      serialized(root, async () => {
        if (signal?.aborted) return "aborted";
        const running = workers.get(root);
        const worker = running ?? start(root, await launch());
        const outcome = await ask(worker, { op: "sync", paths, reopen: running !== undefined && foreignWriter(worker, root) }, root, signal);
        if (outcome === null || outcome === "aborted") return outcome;
        if (outcome.kind === "released") {
          retire(root, worker);
          return null;
        }
        worker.generation = storeGeneration(root);
        return outcome;
      }),
    release: (root, signal) =>
      serialized(root, async () => {
        const worker = workers.get(root);
        if (worker === undefined) return undefined;
        return (await ask(worker, { op: "release" }, root, signal)) === "aborted" ? "aborted" : undefined;
      }),
    close,
  };
}

/** True when the store changed since this worker's last answer: another process or a rebuild wrote it. */
function foreignWriter(worker: Worker, root: string): boolean {
  return worker.generation !== storeGeneration(root);
}

/**
 * The identity and last write of the store's database and its write-ahead log. Every committed write by any connection
 * changes one of them; readers change neither.
 */
export function storeGeneration(root: string): string {
  return ["codegraph.db", "codegraph.db-wal"]
    .map((name) => {
      try {
        const { ino, size, mtimeNs } = statSync(join(root, INDEX_STORE_DIRECTORY, name), { bigint: true });
        return `${ino}:${size}:${mtimeNs}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

function hold(worker: Worker, held: boolean): void {
  const { child } = worker;
  for (const handle of [child, child.stdin, child.stdout] as Handle[]) {
    if (held) handle?.ref?.();
    else handle?.unref?.();
  }
}

function parsed(line: string): WorkerAnswer | null {
  try {
    const answer = JSON.parse(line) as WorkerAnswer;
    return typeof answer === "object" && answer !== null && typeof answer.kind === "string" ? answer : null;
  } catch {
    return null;
  }
}
