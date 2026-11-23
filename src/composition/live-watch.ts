import type { PrimingTurns } from "../core/application/live/live-priming.ts";
import type { PathSelection } from "../core/domain/shared/scope.ts";
import { isEngineEntry } from "../core/ports/staging-rules.ts";
import type { TreeWatch, TreeWatcher } from "../core/ports/tree-watch.port.ts";

const GIT_STATE = new Set([".git/HEAD", ".git/index"]);

/**
 * Whether a change at `path`, relative to a working tree's root, can move the tree's live listing: git's HEAD and index,
 * and a path of the scope's selection that the listing can hold (no engine entry, which keeps the mirror itself out).
 */
export function canMoveLiveListing(path: string, selected: PathSelection): boolean {
  return GIT_STATE.has(path) || (!isEngineEntry(path) && selected(path));
}

export type WatchReport = { outcome: "settled" } | { outcome: "off"; reason: string };

export interface LiveWatchDeps {
  treeWatch: TreeWatch;
  /** The turns launch priming takes: a refresh starts only once no query of the process is in flight. */
  turns: PrimingTurns;
  /** Whether a changed path can move the listing (`canMoveLiveListing` over the declared scope). */
  relevant(path: string): boolean;
  /** Read before each refresh: a repository no longer `trusted` closes the watcher before anything is read. */
  trusted(): Promise<boolean>;
  /** Launch priming of the repository; never rejects. */
  refresh(signal: AbortSignal): Promise<void>;
  report(report: WatchReport): void;
}

export interface LiveWatch {
  /** Launch priming ended: changes seen meanwhile start their refresh now. */
  launched(): void;
}

/**
 * Watches a trusted live tree as a trigger only (ADR-0152): a relevant change marks it dirty and, when no refresh of the
 * watcher runs, starts one that waits for the queries of the process, clears the flag and primes; a change seen during
 * that refresh runs it once more. Until `launched`, launch priming counts as the refresh that runs. The watcher closes
 * when any of `signals` is aborted, when the repository is no longer trusted, or when it fails, and it never answers a
 * query: each query proves freshness itself.
 */
export function watchLive(root: string, deps: LiveWatchDeps, signals: readonly (AbortSignal | undefined)[]): LiveWatch | undefined {
  const stopped = new AbortController();
  let dirty = false;
  let running = true;
  let watcher: TreeWatcher | undefined;
  const close = (reason?: string): void => {
    if (stopped.signal.aborted) return;
    stopped.abort();
    watcher?.close();
    for (const signal of signals) signal?.removeEventListener("abort", stop);
    if (reason !== undefined) deps.report({ outcome: "off", reason });
  };
  const stop = (): void => close();
  const drain = async (): Promise<void> => {
    running = true;
    try {
      while (dirty && !stopped.signal.aborted) {
        await deps.turns.queriesDone(stopped.signal);
        if (stopped.signal.aborted) return;
        if (!(await deps.trusted())) return close("the repository is no longer trusted");
        dirty = false;
        await deps.refresh(stopped.signal);
      }
      if (!stopped.signal.aborted) deps.report({ outcome: "settled" });
    } finally {
      running = false;
    }
  };
  const opened = deps.treeWatch.watch(root, {
    changed(path) {
      if (stopped.signal.aborted || (path !== undefined && !deps.relevant(path))) return;
      dirty = true;
      if (!running) void drain();
    },
    failed: (fault) => close(`${fault.code}: ${fault.detail}`),
  });
  if ("fault" in opened) {
    deps.report({ outcome: "off", reason: `${opened.fault.code}: ${opened.fault.detail}` });
    return undefined;
  }
  watcher = opened;
  for (const signal of signals) signal?.addEventListener("abort", stop, { once: true });
  if (signals.some((signal) => signal?.aborted)) close();
  return {
    launched() {
      running = false;
      if (dirty && !stopped.signal.aborted) void drain();
    },
  };
}
