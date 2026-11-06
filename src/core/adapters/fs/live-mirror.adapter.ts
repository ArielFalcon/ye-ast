import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats, Dirent, Stats } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import type { Result } from "../../domain/shared/result.ts";
import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";
import { isEngineConfiguration, isEngineEntry } from "../../ports/staging-rules.ts";
import { DEBRIS_STALE_MS } from "../../ports/live-mirror.port.ts";
import type { LiveMirror, MirrorEntry, MirrorFault, MirrorLocation, MirrorLock, MirrorReconciliation, MirrorScopeUsage, MirrorState, MirrorUsage } from "../../ports/live-mirror.port.ts";
import type { SkippedEntry } from "../../ports/vcs.port.ts";
import { compareText } from "../../domain/shared/code-node.ts";

const LIVE_DIRECTORY = "live";
const STATE_SUFFIX = ".state.json";
const INDEX_TREE_DIRECTORY = "index-tree";
const LOCK_SUFFIX = ".lock";
const TEMPORARY_SUFFIX = ".tmp";
const STATE_TEMPORARY = /^(.*)\.state\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
/** A state of another format version is discarded, which rebuilds its scope once. */
const STATE_FORMAT_VERSION = 4;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_POLL_MS = 50;
/** Stats in flight at once: a bound on open requests to the file system, not a rule over the size of the tree. */
const STAT_CONCURRENCY = 32;
const SKIP_REASONS: ReadonlySet<string> = new Set(["symlink", "submodule", "unsafe-path", "collision"]);

export interface LiveMirrorDeps {
  /** The account the mirror directories must belong to; `undefined` where the platform has no such notion, which skips the ownership and mode checks. */
  ownerUid: number | undefined;
  /**
   * Whether the export writes a path: the mirror copies exactly those and fingerprints the rest without keeping them,
   * since no query reads them. The host names the rule; the adapter never decides what content matters. `true` when no
   * host names one, which copies more and never fewer.
   */
  writes: (path: string) => boolean;
  pid: () => number;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  renameState: (from: string, to: string) => Promise<void>;
  /** The clock the sweep's touch reads. */
  now: () => number;
}

export const defaultLiveMirrorDeps: LiveMirrorDeps = {
  ownerUid: process.getuid?.(),
  writes: () => true,
  pid: () => process.pid,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errorCode(error) !== "ESRCH";
    }
  },
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
  copyFile: (from, to) => copyFile(from, to, constants.COPYFILE_FICLONE),
  renameState: rename,
  now: Date.now,
};

type Failure = Result<never, MirrorFault>;
type Level = "live" | "root" | "store";

/**
 * Keeps each scope's mirror at `<repo>/.ye-ast-graph/live/<scope>/`, its lock at `<scope>.lock` and its state at
 * `<scope>.state.json` beside it, outside the engine's store, which a full build deletes. A directory on the way
 * that is a symbolic link or open to other accounts is refused, never repaired. The source of a copy is never followed
 * through a link: a link, or a link in any parent directory, is skipped as `symlink`, and a file whose stat changes
 * while it is copied is copied once more, then refused as `unreadable`.
 */
export function createLiveMirror(deps: LiveMirrorDeps = defaultLiveMirrorDeps): LiveMirror {
  const storeOf = (location: MirrorLocation): string => join(location.repo, INDEX_STORE_DIRECTORY);
  const liveOf = (location: MirrorLocation): string => join(storeOf(location), LIVE_DIRECTORY);
  const rootOf = (location: MirrorLocation): string => join(liveOf(location), location.scope);
  const indexRootOf = (location: MirrorLocation): string => join(rootOf(location), INDEX_STORE_DIRECTORY, INDEX_TREE_DIRECTORY);
  const lockOf = (location: MirrorLocation): string => join(liveOf(location), `${location.scope}.lock`);
  const stateOf = (location: MirrorLocation): string => join(liveOf(location), `${location.scope}${STATE_SUFFIX}`);

  async function inspect(path: string): Promise<Result<"absent" | "private", MirrorFault>> {
    let status: Stats;
    try {
      status = await lstat(path);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? { ok: true, value: "absent" } : fault("unreadable", error);
    }
    const refusal = status.isSymbolicLink() || deps.ownerUid !== undefined
      ? privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, deps.ownerUid ?? status.uid)
      : null;
    if (refusal !== null) return { ok: false, fault: { kind: "refused", detail: `${path} ${refusal}` } };
    return status.isDirectory() ? { ok: true, value: "private" } : { ok: false, fault: { kind: "refused", detail: `${path} is not a directory` } };
  }

  async function prepare(location: MirrorLocation, level: Level, create: boolean): Promise<Result<boolean, MirrorFault>> {
    if (location.scope === "" || location.scope === "." || location.scope === ".." || /[/\\\0]/.test(location.scope)) {
      return { ok: false, fault: { kind: "refused", detail: `the scope ${JSON.stringify(location.scope)} is not one path segment` } };
    }
    const chain = [storeOf(location), liveOf(location), rootOf(location), join(rootOf(location), INDEX_STORE_DIRECTORY)].slice(0, level === "live" ? 2 : level === "root" ? 3 : 4);
    for (const path of chain) {
      let presence = await inspect(path);
      if (!presence.ok) return presence;
      if (presence.value === "absent") {
        if (!create) return { ok: true, value: false };
        try {
          await mkdir(path, { mode: DIRECTORY_MODE });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") return fault("write-failed", error);
        }
        presence = await inspect(path);
        if (!presence.ok) return presence;
      }
    }
    return { ok: true, value: true };
  }

  async function tryCreateLock(file: string, pid: number): Promise<Result<boolean, MirrorFault>> {
    const temporary = `${file}.${randomUUID()}${TEMPORARY_SUFFIX}`;
    try {
      await writeFile(temporary, String(pid), { mode: FILE_MODE, flag: "wx" });
      await link(temporary, file);
      return { ok: true, value: true };
    } catch (error) {
      return errorCode(error) === "EEXIST" ? { ok: true, value: false } : fault("write-failed", error);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async function readHolder(file: string): Promise<{ text: string; pid: number | null } | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
    return { text, pid: /^[1-9]\d*$/.test(text.trim()) ? Number(text.trim()) : null };
  }

  async function readRecord(file: string): Promise<MirrorState | null> {
    try {
      return parseState(JSON.parse(await readFile(file, "utf8")));
    } catch {
      return null;
    }
  }

  async function liveDirectory(repo: string): Promise<Result<string | null, MirrorFault>> {
    const store = join(repo, INDEX_STORE_DIRECTORY);
    const presence = await inspect(store);
    if (!presence.ok) return presence;
    if (presence.value === "absent") return { ok: true, value: null };
    const live = join(store, LIVE_DIRECTORY);
    const found = await inspect(live);
    if (!found.ok) return found;
    return { ok: true, value: found.value === "absent" ? null : live };
  }

  async function discard(location: MirrorLocation): Promise<Result<void, MirrorFault>> {
    const prepared = await prepare(location, "root", false);
    if (!prepared.ok) return prepared;
    if (!prepared.value) return { ok: true, value: undefined };
    try {
      await rm(stateOf(location), { force: true });
      await rm(rootOf(location), { recursive: true, force: true });
      return { ok: true, value: undefined };
    } catch (error) {
      return fault("write-failed", error);
    }
  }

  async function whileIdle(location: MirrorLocation, action: () => Promise<Result<void, MirrorFault>>): Promise<Result<void, MirrorFault>> {
    const prepared = await prepare(location, "live", false);
    if (!prepared.ok) return prepared;
    if (!prepared.value) return { ok: true, value: undefined };
    const file = lockOf(location);
    const pid = deps.pid();
    const created = await tryCreateLock(file, pid);
    if (!created.ok) return created;
    if (!created.value) return { ok: true, value: undefined };
    try {
      try {
        return await action();
      } finally {
        await lockHeld(file, pid).release();
      }
    } catch (error) {
      return fault("write-failed", error);
    }
  }

  async function capture(repo: string, root: string, path: string, before: BigIntStats, copy: boolean): Promise<Result<MirrorEntry, MirrorFault>> {
    const source = join(repo, path);
    let current = before;
    for (let attempt = 0; attempt < 2; attempt++) {
      const destination = join(root, path);
      const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
      try {
        let held: { blob: string; bytes: number };
        if (copy) {
          await mkdir(dirname(destination), { recursive: true, mode: DIRECTORY_MODE });
          await deps.copyFile(source, temporary);
          held = await hashFile(temporary);
        } else {
          held = await hashFile(source);
        }
        const after = await lstat(source, { bigint: true });
        if (!after.isFile()) return { ok: false, fault: { kind: "unreadable", detail: `${path} is no longer a regular file` } };
        if (held.bytes === Number(current.size) && sameFile(current, after)) {
          if (copy) await rename(temporary, destination);
          return { ok: true, value: { path, size: held.bytes, mtimeNs: current.mtimeNs.toString(), ctimeNs: current.ctimeNs.toString(), ino: current.ino.toString(), blob: held.blob } };
        }
        current = after;
      } catch (error) {
        return fault("unreadable", error, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return { ok: false, fault: { kind: "unreadable", detail: `${path} changed while it was being copied` } };
  }

  async function prune(root: string, path: string): Promise<void> {
    for (let directory = dirname(join(root, path)); directory.length > root.length; directory = dirname(directory)) {
      try {
        await rmdir(directory);
      } catch {
        return;
      }
    }
  }

  return {
    root: rootOf,

    indexRoot: indexRootOf,

    async lock(location, signal) {
      const prepared = await prepare(location, "live", true);
      if (!prepared.ok) return prepared;
      const file = lockOf(location);
      const pid = deps.pid();
      for (;;) {
        if (signal?.aborted) return { ok: false, fault: { kind: "aborted", detail: `waiting for ${file} was aborted` } };
        const created = await tryCreateLock(file, pid);
        if (!created.ok) return created;
        if (created.value) return { ok: true, value: lockHeld(file, pid) };
        const holder = await readHolder(file);
        if (holder === null) continue;
        if (holder.pid === null || !deps.isAlive(holder.pid)) {
          const again = await readHolder(file);
          if (again !== null && again.text === holder.text) await rm(file, { force: true }).catch(() => undefined);
          continue;
        }
        await deps.sleep(LOCK_POLL_MS, signal);
      }
    },

    async readState(location) {
      const prepared = await prepare(location, "live", false);
      if (!prepared.ok) return prepared;
      if (!prepared.value) return { ok: true, value: null };
      return { ok: true, value: await readRecord(stateOf(location)) };
    },

    async writeState(location, state) {
      const prepared = await prepare(location, "live", true);
      if (!prepared.ok) return prepared;
      const file = stateOf(location);
      const temporary = `${file}.${randomUUID()}${TEMPORARY_SUFFIX}`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: STATE_FORMAT_VERSION, ...state }, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
        await deps.renameState(temporary, file);
        return { ok: true, value: undefined };
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        return fault("write-failed", error);
      }
    },

    async reconcile(location, paths, manifest, signal) {
      const prepared = await prepare(location, "root", true);
      if (!prepared.ok) return prepared;
      const root = rootOf(location);
      const old = new Map(manifest.map((entry) => [entry.path, entry]));
      const skipped: SkippedEntry[] = [];
      const kept: MirrorEntry[] = [];
      const pending: { path: string; stat: BigIntStats }[] = [];
      const directories = new Map<string, "ok" | "link" | "missing">();

      const statable: string[] = [];
      for (const { path, submodule } of paths) {
        if (isEngineEntry(path) && !unsafe(path)) continue;
        if (submodule) { skipped.push({ path, reason: "submodule" }); continue; }
        if (unsafe(path)) { skipped.push({ path, reason: "unsafe-path" }); continue; }
        statable.push(path);
      }
      const probes = await mapBounded(statable, STAT_CONCURRENCY, (path) => (signal?.aborted ? null : probe(location.repo, path, directories)));

      for (const [index, path] of statable.entries()) {
        if (signal?.aborted) return aborted();
        const found = probes[index]!;
        if (found.parents === "link") { skipped.push({ path, reason: "symlink" }); continue; }
        if (found.parents === "missing") continue;
        if (found.failure !== undefined) {
          if (["ENOENT", "ENOTDIR"].includes(errorCode(found.failure) ?? "")) continue;
          return fault("unreadable", found.failure, path);
        }
        const status = found.status!;
        if (status.isSymbolicLink()) { skipped.push({ path, reason: "symlink" }); continue; }
        if (!status.isFile()) { skipped.push({ path, reason: "unsafe-path" }); continue; }
        const previous = old.get(path);
        if (previous !== undefined && matches(previous, status)) kept.push(previous);
        else pending.push({ path, stat: status });
      }

      const present = new Set([...kept.map((entry) => entry.path), ...pending.map((entry) => entry.path)]);
      const changed = new Set<string>();
      for (const entry of manifest) {
        if (present.has(entry.path) || isEngineEntry(entry.path)) continue;
        await rm(join(root, entry.path), { force: true });
        await prune(root, entry.path);
        if (!isEngineConfiguration(entry.path)) changed.add(entry.path);
      }

      const next = [...kept];
      for (const { path, stat } of pending) {
        if (signal?.aborted) return aborted();
        const configuration = isEngineConfiguration(path);
        const entry = await capture(location.repo, root, path, stat, deps.writes(path) && !configuration);
        if (!entry.ok) return entry;
        next.push(entry.value);
        if (configuration) {
          await rm(join(root, path), { force: true });
          await prune(root, path);
        } else if (old.get(path)?.blob !== entry.value.blob) changed.add(path);
      }

      const reconciliation: MirrorReconciliation = {
        manifest: next.sort((a, b) => compareText(a.path, b.path)),
        skipped: skipped.sort((a, b) => compareText(a.path, b.path)),
        changed: [...changed].sort(compareText),
      };
      return { ok: true, value: reconciliation };
    },

    async changedSince(location, paths, { manifest, skipped }, signal) {
      const known = new Map(manifest.map((entry) => [entry.path, entry]));
      const skippedLinks = new Set(skipped.filter((entry) => entry.reason === "symlink").map((entry) => entry.path));
      const skippedOthers = new Set(skipped.filter((entry) => entry.reason !== "symlink").map((entry) => entry.path));
      const listed = new Set<string>();
      const changed = new Set<string>();
      const directories = new Map<string, "ok" | "link" | "missing">();
      const candidates = paths.filter(({ path, submodule }) => !(isEngineEntry(path) || submodule || unsafe(path) || skippedOthers.has(path)));
      const statuses = await mapBounded(candidates, STAT_CONCURRENCY, async ({ path }) =>
        signal?.aborted ? null : (await parentState(location.repo, path, directories)) === "ok" ? await lstat(join(location.repo, path), { bigint: true }).catch(() => null) : null,
      );
      if (signal?.aborted) return aborted();
      for (const [index, { path }] of candidates.entries()) {
        listed.add(path);
        const status = statuses[index]!;
        const previous = known.get(path);
        if (previous !== undefined) {
          if (status === null || !status.isFile() || !matches(previous, status)) changed.add(path);
        } else if (skippedLinks.has(path)) {
          if (status?.isFile()) changed.add(path);
        } else if (status !== null) {
          changed.add(path);
        }
      }
      for (const entry of manifest) if (!listed.has(entry.path)) changed.add(entry.path);
      return { ok: true, value: [...changed].sort(compareText) };
    },

    async materialize(location, paths, destination, signal) {
      const prepared = await prepare(location, "root", false);
      if (!prepared.ok) return prepared;
      if (!prepared.value) return { ok: true, value: undefined };
      const root = rootOf(location);
      for (const path of paths) {
        if (signal?.aborted) return aborted();
        if (unsafe(path) || isEngineEntry(path)) continue;
        const source = join(root, path);
        try {
          const status = await lstat(source);
          if (!status.isFile()) continue;
          await mkdir(dirname(join(destination, path)), { recursive: true, mode: DIRECTORY_MODE });
          await deps.copyFile(source, join(destination, path));
        } catch (error) {
          if (errorCode(error) !== "ENOENT") return fault("write-failed", error, path);
        }
      }
      return { ok: true, value: undefined };
    },

    async prune(location, paths, signal) {
      const prepared = await prepare(location, "root", false);
      if (!prepared.ok) return prepared;
      if (!prepared.value) return { ok: true, value: undefined };
      const root = indexRootOf(location);
      try {
        for (const path of paths) {
          if (signal?.aborted) return aborted();
          if (unsafe(path) || isEngineEntry(path)) continue;
          await rm(join(root, path), { force: true });
          await prune(root, path);
        }
        return { ok: true, value: undefined };
      } catch (error) {
        return fault("write-failed", error);
      }
    },

    discard,

    async discardIfIdle(location) {
      return whileIdle(location, () => discard(location));
    },

    async usage(repo) {
      const found = await liveDirectory(repo);
      if (!found.ok) return found;
      if (found.value === null) return { ok: true, value: { scopes: [], debris: [] } };
      const live = found.value;
      let entries: Dirent[];
      try {
        entries = await readdir(live, { withFileTypes: true });
      } catch (error) {
        return fault("unreadable", error);
      }

      const directories: string[] = [];
      const states = new Map<string, number>();
      const debris: string[] = [];
      const now = deps.now();
      for (const entry of entries) {
        if (entry.isDirectory()) {
          directories.push(entry.name);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(STATE_SUFFIX)) {
          const scope = entry.name.slice(0, -STATE_SUFFIX.length);
          const status = await lstat(join(live, entry.name)).catch(() => null);
          if (status !== null) states.set(scope, status.mtimeMs);
          continue;
        }
        if (STATE_TEMPORARY.test(entry.name)) {
          const status = await lstat(join(live, entry.name)).catch(() => null);
          if (status !== null && now - status.mtimeMs > DEBRIS_STALE_MS) debris.push(entry.name);
        }
      }
      for (const scope of [...states.keys()]) {
        if (directories.includes(scope)) continue;
        states.delete(scope);
        debris.push(`${scope}${STATE_SUFFIX}`);
      }

      const scopes: MirrorScopeUsage[] = [];
      for (const scope of [...directories].sort(compareText)) {
        const location: MirrorLocation = { repo, scope };
        const record = await readRecord(stateOf(location));
        const holder = await readHolder(lockOf(location));
        const manifestBytes = record === null ? 0 : record.manifest.reduce((sum, entry) => sum + entry.size, 0);
        scopes.push({
          scope,
          versions: record?.versions ?? null,
          bytes: manifestBytes + (await directoryBytes(join(rootOf(location), INDEX_STORE_DIRECTORY))),
          lastUsedMs: states.get(scope) ?? null,
          locked: holder !== null && holder.pid !== null && deps.isAlive(holder.pid),
        });
      }
      return { ok: true, value: { scopes, debris: debris.sort(compareText) } };
    },

    async touch(location) {
      const prepared = await prepare(location, "live", false);
      if (!prepared.ok) return prepared;
      if (!prepared.value) return { ok: true, value: undefined };
      const at = new Date(deps.now());
      try {
        await utimes(stateOf(location), at, at);
        return { ok: true, value: undefined };
      } catch (error) {
        return errorCode(error) === "ENOENT" ? { ok: true, value: undefined } : fault("write-failed", error);
      }
    },

    async discardDebris(repo, entries) {
      const found = await liveDirectory(repo);
      if (!found.ok) return found;
      if (found.value === null) return { ok: true, value: undefined };
      const live = found.value;
      for (const entry of entries) {
        if (entry === "" || entry === "." || entry === ".." || /[/\\\0]/.test(entry)) continue;
        const temporary = STATE_TEMPORARY.exec(entry);
        const scope = temporary?.[1] ?? (entry.endsWith(STATE_SUFFIX) ? entry.slice(0, -STATE_SUFFIX.length) : null);
        if (scope === null || scope === "" || scope === "." || scope === "..") continue;
        const location = { repo, scope };
        const removed = await whileIdle(location, async () => {
          try {
            const status = await lstat(join(live, entry)).catch((error: unknown) => {
              if (errorCode(error) === "ENOENT") return null;
              throw error;
            });
            if (status === null || !status.isFile()) return { ok: true, value: undefined };
            if (temporary !== null) {
              if (deps.now() - status.mtimeMs <= DEBRIS_STALE_MS) return { ok: true, value: undefined };
            } else {
              const root = await prepare(location, "root", false);
              if (!root.ok) return root;
              if (root.value) return { ok: true, value: undefined };
            }
            await rm(join(live, entry), { force: true });
            return { ok: true, value: undefined };
          } catch (error) {
            return fault("write-failed", error);
          }
        });
        if (!removed.ok) return removed;
      }
      return { ok: true, value: undefined };
    },
  };
}

function lockHeld(file: string, pid: number): MirrorLock {
  return {
    async release() {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text?.trim() === String(pid)) await rm(file, { force: true });
    },
  };
}

/** The bytes a directory's regular files occupy, from `readdir` and `stat` alone; a directory that cannot be read counts as none. */
async function directoryBytes(directory: string): Promise<number> {
  try {
    const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
    const sizes = await mapBounded(files, STAT_CONCURRENCY, async (entry) => {
      const status = await lstat(join(entry.parentPath, entry.name)).catch(() => null);
      return status !== null && status.isFile() ? status.size : 0;
    });
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}

/** Runs `work` over `items` with at most `limit` in flight and answers in the order of `items`. */
async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R> | R): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface Probe {
  parents: "ok" | "link" | "missing";
  status?: BigIntStats;
  failure?: unknown;
}

async function probe(repo: string, path: string, directories: Map<string, "ok" | "link" | "missing">): Promise<Probe> {
  const parents = await parentState(repo, path, directories);
  if (parents !== "ok") return { parents };
  try {
    return { parents, status: await lstat(join(repo, path), { bigint: true }) };
  } catch (failure) {
    return { parents, failure };
  }
}

async function parentState(repo: string, path: string, cache: Map<string, "ok" | "link" | "missing">): Promise<"ok" | "link" | "missing"> {
  let directory = repo;
  for (const segment of path.split("/").slice(0, -1)) {
    directory = join(directory, segment);
    let state = cache.get(directory);
    if (state === undefined) {
      state = await lstat(directory).then(
        (status) => (status.isSymbolicLink() ? "link" : status.isDirectory() ? "ok" : "missing"),
        () => "missing" as const,
      );
      cache.set(directory, state);
    }
    if (state !== "ok") return state;
  }
  return "ok";
}

async function hashFile(file: string): Promise<{ blob: string; bytes: number }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await handle.stat();
    const hash = createHash("sha1").update(`blob ${size}\0`);
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    return { blob: hash.digest("hex"), bytes: bytes === size ? bytes : -1 };
  } finally {
    await handle.close();
  }
}

/** A user tool can set a modification time back but not the status-change time, and a replaced file has another inode. */
function matches(entry: MirrorEntry, status: BigIntStats): boolean {
  return entry.size === Number(status.size) && entry.mtimeNs === status.mtimeNs.toString() && entry.ctimeNs === status.ctimeNs.toString() && entry.ino === status.ino.toString();
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino;
}

function unsafe(path: string): boolean {
  return path === "" || path.startsWith("/") || /[\0\\]/.test(path) || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function parseState(value: unknown): MirrorState | null {
  if (!isRecord(value) || value.version !== STATE_FORMAT_VERSION) return null;
  const { versions, manifest, skipped, notHeld, indexed, fullBuildStateId, stateId, pending } = value;
  if (!isRecord(versions) || typeof versions.codegraph !== "string" || typeof versions.store !== "string" || typeof versions.staging !== "string") return null;
  if (!Array.isArray(manifest) || !manifest.every(isEntry) || !Array.isArray(skipped) || !skipped.every(isSkipped)) return null;
  if (!isStrings(notHeld) || !isStrings(indexed) || !isStrings(pending) || typeof fullBuildStateId !== "string" || typeof stateId !== "string") return null;
  return {
    versions: { codegraph: versions.codegraph, store: versions.store, staging: versions.staging },
    manifest, skipped, notHeld, indexed, fullBuildStateId, stateId, pending,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEntry(value: unknown): value is MirrorEntry {
  return isRecord(value) && typeof value.path === "string" && Number.isSafeInteger(value.size) && typeof value.mtimeNs === "string" && /^\d+$/.test(value.mtimeNs) && typeof value.ctimeNs === "string" && /^\d+$/.test(value.ctimeNs) && typeof value.ino === "string" && /^\d+$/.test(value.ino) && typeof value.blob === "string";
}

function isSkipped(value: unknown): value is SkippedEntry {
  return isRecord(value) && typeof value.path === "string" && typeof value.reason === "string" && SKIP_REASONS.has(value.reason);
}

function aborted(): Failure {
  return { ok: false, fault: { kind: "aborted", detail: "the reconciliation was aborted" } };
}

function fault(kind: MirrorFault["kind"], error: unknown, path?: string): Failure {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, fault: { kind, detail: path === undefined ? message : `${path}: ${message}` } };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
