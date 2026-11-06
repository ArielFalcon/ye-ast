import { compareText } from "../shared/code-node.ts";

/**
 * How the live tree keeps its mirrors: RFC-0010 "Retention", RFC-0006's `store` row. The values are configuration, so a
 * host supplies them through composition; the rule below is pure and reads no clock.
 */
export interface LiveRetentionPolicy {
  /** How many mirrors the tree keeps, the scope of the query being answered included. */
  keepScopes: number;
  /** How long a mirror nobody uses may stay. */
  unusedForMs: number;
  /** The logical bytes the whole live tree may occupy. */
  maxBytes: number;
}

/** One scope's mirror as the sweep sees it. */
export interface LiveScopeUsage {
  scope: string;
  /** The logical bytes the mirror's files and its store occupy. */
  bytes: number;
  /** The state file's modification time, in epoch milliseconds; `null` when the scope has no state. */
  lastUsedMs: number | null;
  /** A live process holds the scope's lock. */
  locked: boolean;
  /** The recorded state was built by the engines this process runs. */
  versionsMatch: boolean;
}

export interface LiveSweep {
  scopes: readonly LiveScopeUsage[];
  /** Live-directory entries that belong to no scope: a state file with no directory, a leftover temporary file. */
  debris: readonly string[];
}

/** What the sweep removes: scope identities, in the order they were chosen, and live-directory entry names. */
export interface LiveDiscards {
  scopes: readonly string[];
  debris: readonly string[];
}

const NONE: LiveDiscards = { scopes: [], debris: [] };

function lastUsed(scope: LiveScopeUsage): number {
  return scope.lastUsedMs ?? 0;
}
function leastRecentFirst(a: LiveScopeUsage, b: LiveScopeUsage): number {
  return lastUsed(a) - lastUsed(b) || compareText(a.scope, b.scope);
}

/**
 * What the sweep discards, decided from measurements alone: debris, then a mirror built by other engines, then one
 * unused past the bound, then the count, then the byte cap in least-recently-used order. The scope being answered and
 * any scope another live process holds are never discarded; the byte cap is best effort, so a mirror that is neither
 * can stay over it.
 */
export function retentionDiscards(sweep: LiveSweep, current: string, policy: LiveRetentionPolicy, nowMs: number): LiveDiscards {
  const discarded: string[] = [];
  const discard = (scope: LiveScopeUsage): void => {
    discarded.push(scope.scope);
  };
  const kept: LiveScopeUsage[] = [];
  const candidates: LiveScopeUsage[] = [];
  for (const scope of sweep.scopes) {
    if (scope.scope === current || scope.locked) kept.push(scope);
    else candidates.push(scope);
  }

  const evictable = candidates.filter((scope) => {
    const debris = scope.lastUsedMs === null;
    const rebuilt = !scope.versionsMatch;
    const unused = scope.lastUsedMs !== null && nowMs - scope.lastUsedMs > policy.unusedForMs;
    if (debris || rebuilt || unused) discard(scope);
    return !debris && !rebuilt && !unused;
  });

  const room = Math.max(0, policy.keepScopes - kept.length);
  const byRecency = [...evictable].sort((a, b) => leastRecentFirst(b, a));
  const staying = byRecency.slice(0, room);
  for (const scope of byRecency.slice(room).sort(leastRecentFirst)) discard(scope);

  let total = [...kept, ...staying].reduce((sum, scope) => sum + scope.bytes, 0);
  for (const scope of [...staying].sort(leastRecentFirst)) {
    if (total <= policy.maxBytes) break;
    total -= scope.bytes;
    discard(scope);
  }

  if (discarded.length === 0 && sweep.debris.length === 0) return NONE;
  return { scopes: discarded, debris: [...new Set(sweep.debris)].sort(compareText) };
}
