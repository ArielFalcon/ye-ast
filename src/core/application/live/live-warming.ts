import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { exportSelection } from "../../domain/shared/scope.ts";
import { canMoveLiveListing, liveScope } from "../../domain/snapshot/live-export.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { Redaction } from "../../ports/redaction.port.ts";
import { isEngineEntry } from "../../ports/staging-rules.ts";
import type { TreeWatch } from "../../ports/tree-watch.port.ts";
import { trustOf, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";
import type { PrimingTurns } from "./live-priming.ts";
import { openLive, type LiveDeps } from "./live-tree.ts";
import { watchLive, type LiveWatch, type WatchReport } from "./live-watch.ts";

export interface LiveWarmingDeps extends Pick<SnapshotReaderDeps, "trust"> {
  live: LiveDeps;
  matcher: PathMatcher;
  redaction: Redaction;
  treeWatch: TreeWatch;
  turns: PrimingTurns;
  /** Launch priming of `repo`, named `repoId` when given (`primeLive`); never rejects. */
  prime(repo: string, repoId: string | undefined, trigger: "launch" | "watch", signal?: AbortSignal): Promise<void>;
  reportWatch(report: WatchReport): void;
  /** Aborted when the host shuts down: it closes every watcher besides each warming's own signal. */
  closing?: AbortSignal | undefined;
}

/** Why the live mirror could not be built: the kind and detail its build reported, or the thrown error, redacted, as `detail` alone. */
export interface WarmingFault {
  kind?: string;
  detail: string;
}

/**
 * Builds the live mirror of `repo` for the default scope when it is `trusted` and has none, then primes it (ADR-0144
 * decision 7). A trusted repository is also watched from before the build until `signal` or `closing` is aborted, and
 * each change primes it again ahead of the next query (ADR-0152). Resolves once launch priming ended, to why the mirror
 * could not be built, or `null`; it never rejects.
 */
export async function warmLive(deps: LiveWarmingDeps, repo: string, signal?: AbortSignal, repoId?: string): Promise<WarmingFault | null> {
  const trusted = async (): Promise<boolean> => (await trustOf(deps, repo).catch(() => "untrusted")) === "trusted";
  let watching: LiveWatch | undefined;
  try {
    if (!(await trusted())) return null;
    const scope = liveScope();
    const selected = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
    watching = watchLive(repo, {
      treeWatch: deps.treeWatch,
      turns: deps.turns,
      relevant: (path) => canMoveLiveListing(path, selected, isEngineEntry),
      trusted,
      refresh: (stopped) => deps.prime(repo, repoId, "watch", stopped),
      report: deps.reportWatch,
    }, [signal, deps.closing]);
    const warmed = await openLive(deps.live, { repo, scope, selected, store: true, signal }, async () => undefined);
    if (!warmed.ok) return warmed.fault;
    await deps.prime(repo, repoId, "launch", signal);
    return null;
  } catch (error) {
    return { detail: deps.redaction.redactError(error) };
  } finally {
    watching?.launched();
  }
}
