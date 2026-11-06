import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import type { Result } from "../../domain/shared/result.ts";
import { retentionDiscards } from "../../domain/snapshot/live-retention.ts";
import type { CodeGraph, CodeGraphFault, IndexSummary } from "../../ports/code-graph.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { IndexCache, IndexDiscard, IndexedSnapshot, IndexRetentionPolicy } from "../../ports/index-cache.port.ts";
import { STAGING_RULES_VERSION } from "./stage-snapshot.ts";
import { SUPPORTED_STORE } from "./store-version.ts";

export interface IndexCacheDeps {
  /** Where the kept indexes live; created for its owner alone when absent. */
  directory: string;
  graph: CodeGraph;
  digest: Digest;
  /** The installed codegraph release. */
  codegraph: string;
  /** Version of the staging rules; the current ones by default. */
  stagingRules?: string;
  /** Without it nothing is removed. */
  retention?: IndexRetentionPolicy;
  /** Receives one event per index retention removes. */
  onDiscard?: (discard: IndexDiscard) => void;
  /** The clock the last use of an index is written from and read against. */
  now?: () => number;
  pid?: () => number;
  isAlive?: (pid: number) => boolean;
}

const INDEXES = "indexes";
const SUMMARY_FILE = "summary.json";
const BUILD_PREFIX = ".build-";
const LEASE_PREFIX = ".lease-";
const LEASING_PREFIX = ".leasing-";
const PRIVATE = 0o700;
const OWNER_ONLY_FILE = 0o600;

type Summary = Omit<IndexSummary, "versions">;
type Entry = { state: "absent" } | { state: "unusable" } | { state: "usable"; indexed: IndexedSnapshot };

export function createIndexCache(deps: IndexCacheDeps): IndexCache {
  const indexes = join(deps.directory, INDEXES);
  const keyOf = (content: string): string =>
    deps.digest.of(JSON.stringify({ content, codegraph: deps.codegraph, store: SUPPORTED_STORE, stagingRules: deps.stagingRules ?? STAGING_RULES_VERSION }));

  async function openEntry(entry: string): Promise<Entry> {
    try {
      await stat(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
      return { state: "unusable" };
    }
    const summary = await readSummary(entry);
    const opened = deps.graph.open(entry);
    if (summary === null || !opened.ok) {
      if (opened.ok) opened.value.close();
      return { state: "unusable" };
    }
    return { state: "usable", indexed: { store: opened.value, summary: { ...summary, versions: opened.value.versions } } };
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async function produce(entry: string, { snapshot, signal, prepare }: Parameters<IndexCache["obtain"]>[0]): Promise<Result<IndexedSnapshot, CodeGraphFault>> {
    for (const directory of [deps.directory, indexes]) {
      const reachable = await reachableByOthers(directory);
      if (reachable !== null) return unavailable(reachable);
    }
    const kept = await openEntry(entry);
    if (kept.state === "usable") return { ok: true, value: kept.indexed };

    const building = await mkdtemp(join(indexes, BUILD_PREFIX));
    let published = false;
    try {
      const prepared = await prepare?.();
      if (prepared !== undefined && !prepared.ok) return prepared;
      const built = await deps.graph.index(snapshot, building, signal);
      if (!built.ok) return built;
      const { versions: _versions, ...summary } = built.value;
      await writeFile(join(building, SUMMARY_FILE), JSON.stringify(summary));

      const stale = join(indexes, `${BUILD_PREFIX}stale-${randomUUID()}`);
      if (kept.state === "unusable") await rename(entry, stale).catch(() => undefined);
      try {
        await rename(building, entry);
        published = true;
      } catch (error) {
        if (!(await exists(entry))) return unavailable(error);
      }
      if (kept.state === "unusable") await rm(stale, { recursive: true, force: true });

      const opened = await openEntry(entry);
      return opened.state === "usable" ? { ok: true, value: opened.indexed } : { ok: false, fault: { kind: "cache-unavailable", detail: `${entry} cannot be opened after it was published` } };
    } catch (error) {
      return unavailable(error);
    } finally {
      if (!published) await rm(building, { recursive: true, force: true });
    }
  }

  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? ((): number => process.pid);
  const isAlive = deps.isAlive ?? processIsAlive;

  async function takeLease(key: string): Promise<{ release: () => void } | null> {
    const leasing = join(indexes, `${LEASING_PREFIX}${randomUUID()}`);
    const lease = join(indexes, `${LEASE_PREFIX}${key}-${pid()}-${randomUUID()}`);
    try {
      await writeFile(leasing, String(pid()), { mode: OWNER_ONLY_FILE, flag: "wx" });
      await rename(leasing, lease);
    } catch {
      await rm(leasing, { force: true });
      return null;
    }
    return { release: () => rmSync(lease, { force: true }) };
  }

  /** The keys an open reader of a live process holds; a lease of a dead process is removed. */
  async function leasedKeys(): Promise<Set<string>> {
    const leased = new Set<string>();
    for (const name of await readdir(indexes)) {
      if (!name.startsWith(LEASE_PREFIX)) continue;
      const holder = Number((await readFile(join(indexes, name), "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) leased.add(name.slice(LEASE_PREFIX.length).split("-")[0]!);
      else if (holder > 0) await rm(join(indexes, name), { force: true });
    }
    return leased;
  }

  async function measureEntry(key: string): Promise<{ bytes: number; lastUsedMs: number | null }> {
    const entry = join(indexes, key);
    const used = await stat(join(entry, SUMMARY_FILE)).then((status) => status.mtimeMs, () => null);
    let bytes = 0;
    for (const file of await readdir(entry, { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (file.isFile()) bytes += (await lstat(join(file.parentPath, file.name)).catch(() => null))?.size ?? 0;
    }
    return { bytes, lastUsedMs: used };
  }

  /** Renames the entry away first so a reader that leased it meanwhile finds it back, and removes it only while no live lease names it. */
  async function discard(key: string): Promise<boolean> {
    const entry = join(indexes, key);
    const removed = join(indexes, `${BUILD_PREFIX}stale-${randomUUID()}`);
    try {
      await rename(entry, removed);
    } catch {
      return false;
    }
    if ((await leasedKeys()).has(key)) {
      const restored = await rename(removed, entry).then(() => true, () => false);
      if (!restored) await rm(removed, { recursive: true, force: true }).catch(() => undefined);
      return false;
    }
    await rm(removed, { recursive: true, force: true });
    return true;
  }

  /** Removes the indexes the policy names, once per obtain; it never fails the obtain it follows. */
  async function sweep(current: string): Promise<void> {
    if (deps.retention === undefined) return;
    try {
      const leased = await leasedKeys();
      const usage = new Map<string, { bytes: number; lastUsedMs: number | null }>();
      for (const item of await readdir(indexes, { withFileTypes: true })) {
        if (item.isDirectory() && !item.name.startsWith(".")) usage.set(item.name, await measureEntry(item.name));
      }
      const scopes = [...usage].map(([scope, { bytes, lastUsedMs }]) => ({ scope, bytes, lastUsedMs, locked: leased.has(scope), versionsMatch: true }));
      const discards = retentionDiscards({ scopes, debris: [] }, current, { keepScopes: Number.POSITIVE_INFINITY, ...deps.retention }, now());
      let retained = scopes.reduce((sum, scope) => sum + scope.bytes, 0);
      for (const key of discards.scopes) {
        if (!(await discard(key))) continue;
        const entryBytes = usage.get(key)!.bytes;
        retained -= entryBytes;
        deps.onDiscard?.({ entryBytes, retainedBytes: retained });
      }
    } catch {
      return;
    }
  }

  async function touch(entry: string): Promise<void> {
    const at = new Date(now());
    await utimes(join(entry, SUMMARY_FILE), at, at).catch(() => undefined);
  }

  async function obtain(request: Parameters<IndexCache["obtain"]>[0]): Promise<Result<IndexedSnapshot, CodeGraphFault>> {
    const key = keyOf(request.content);
    const entry = join(indexes, key);
    try {
      await mkdir(indexes, { recursive: true, mode: PRIVATE });
    } catch (error) {
      return unavailable(error);
    }
    const lease = await takeLease(key);
    const result = await produce(entry, request);
    if (!result.ok) {
      lease?.release();
      return result;
    }
    await touch(entry);
    await sweep(key);
    const { store } = result.value;
    return { ok: true, value: { ...result.value, store: Object.assign(Object.create(store) as typeof store, { close: () => { store.close(); lease?.release(); } }) } };
  }

  return { obtain };
}

/** An entry another account could have written is no fact source, so the cache is refused rather than repaired. */
async function reachableByOthers(directory: string): Promise<string | null> {
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) return null;
  const status = await lstat(directory);
  const refusal = privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, ownerUid);
  return refusal === null ? null : `${directory} ${refusal}`;
}

async function readSummary(entry: string): Promise<Summary | null> {
  try {
    const summary = JSON.parse(await readFile(join(entry, SUMMARY_FILE), "utf8")) as Summary;
    const counts = [summary.filesIndexed, summary.filesSkipped, summary.filesErrored];
    return counts.every(Number.isInteger) && Array.isArray(summary.filesNotIndexed) ? summary : null;
  } catch {
    return null;
  }
}

function unavailable(error: unknown): Result<never, CodeGraphFault> {
  return { ok: false, fault: { kind: "cache-unavailable", detail: error instanceof Error ? error.message : String(error) } };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
