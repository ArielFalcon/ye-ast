import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";
import type { WarmingFault } from "../core/application/live/live-warming.ts";
import type { DeclaredBuildOutput } from "../core/domain/shared/build-outputs.ts";
import type { WorkerConfiguration } from "../daemon/handshake.ts";
import { runWorkerHost, type ServeConnection } from "../daemon/worker-host.ts";
import { serveDaemonDialect, type CallLines, type LineKind } from "../protocol/daemon-dialect.ts";
import { composeQueries, type CompositionOptions } from "./compose.ts";
import { DAEMON_IDLE_MS } from "./daemon.ts";
import type { QueryConfiguration } from "./daemon-queries.ts";

/** Marks a worker's query line, so a bench or a differential tells which process answered (ADR-0157 decision 6). */
function servedByDaemon(line: string): string {
  try {
    const parsed = JSON.parse(line) as { ye_ast?: Record<string, unknown> };
    return parsed.ye_ast?.event === "query" ? JSON.stringify({ ye_ast: { ...parsed.ye_ast, served: "daemon" } }) : line;
  } catch {
    return line;
  }
}

function strings(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The composition options a client's configuration names, read back from the wire. */
export function compositionOf(configuration: WorkerConfiguration): Pick<CompositionOptions, "indexCache" | "cacheDirectory" | "trustDirectory" | "buildOutputs"> {
  const { indexCache, cacheDirectory, trustDirectory, buildOutputs } = configuration as QueryConfiguration;
  const declared = buildOutputs as { repo?: unknown; outputs?: unknown } | undefined;
  const outputs = Array.isArray(declared?.outputs) ? (declared.outputs as DeclaredBuildOutput[]) : undefined;
  const launch = strings(declared?.repo);
  return {
    ...(strings(indexCache) !== undefined && { indexCache: indexCache! }),
    ...(strings(cacheDirectory) !== undefined && { cacheDirectory: cacheDirectory! }),
    ...(strings(trustDirectory) !== undefined && { trustDirectory: trustDirectory! }),
    ...(launch !== undefined && outputs !== undefined && { buildOutputs: (repo: string) => (repo === launch ? outputs : undefined) }),
  };
}

/**
 * A worker's composition: the client's own options, whose lines reach the client of the call that wrote them, or every
 * listening client when no call did (priming the watcher started), and whose launch priming runs once per repository
 * and name for the worker's life; one that could not build the mirror runs again on the next request.
 */
export function workerConnection(configuration: WorkerConfiguration, signal: AbortSignal): ServeConnection {
  const current = new AsyncLocalStorage<CallLines>();
  const listeners = new Set<CallLines>();
  const route = (kind: LineKind) => (line: string): void => {
    const text = kind === "measure" ? servedByDaemon(line) : line;
    const caller = current.getStore();
    if (caller?.open()) return caller.send(kind, text);
    for (const listener of listeners) if (listener.open()) listener.send(kind, text);
  };
  const options = compositionOf(configuration);
  const queries = composeQueries({ ...options, signal, measure: route("measure"), ...(options.trustDirectory !== undefined && { reportTrustFault: route("diagnostic") }) });
  const warming = new Map<string, Promise<WarmingFault | null>>();
  const families = {
    ...queries,
    warm: (repo: string, repoId: string | undefined) => {
      const key = JSON.stringify([repo, repoId ?? null]);
      const running =
        warming.get(key) ??
        queries.warmLive(repo, signal, repoId).then((fault) => {
          if (fault !== null) warming.delete(key);
          return fault;
        });
      warming.set(key, running);
      return running;
    },
  };
  return (socket: Socket, hooks) =>
    serveDaemonDialect(families, { input: socket, output: socket }, {
      ...hooks,
      within: (lines, call) => current.run(lines, call),
      listen: (lines) => {
        listeners.add(lines);
        return () => listeners.delete(lines);
      },
    });
}

if (import.meta.main) {
  await runWorkerHost({ channel: process, pid: process.pid, idleMs: DAEMON_IDLE_MS, start: (_repo, configuration, signal) => workerConnection(configuration, signal) });
  process.exit(0);
}
