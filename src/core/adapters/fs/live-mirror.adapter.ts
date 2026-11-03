import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats, Dirent, Stats } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import type { Result } from "../../domain/shared/result.ts";
import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";
import { isEngineConfiguration, isEngineEntry } from "../../ports/staging-rules.ts";
import type { LiveMirror, MirrorEntry, MirrorFault, MirrorLocation, MirrorLock, MirrorReconciliation, MirrorScopeUsage, MirrorState, MirrorUsage } from "../../ports/live-mirror.port.ts";
import type { SkippedEntry } from "../../ports/vcs.port.ts";

export const LIVE_DIRECTORY = "live";
export const STATE_SUFFIX = ".state.json";
const INDEX_TREE_DIRECTORY = "index-tree";
const LOCK_SUFFIX = ".lock";
const TEMPORARY_SUFFIX = ".tmp";
/**
 * How old a leftover temporary file must be before the sweep calls it debris: a sibling between writing one and linking
 * or renaming it is still using it, and removing that one would fail its query.
 */
const TEMPORARY_STALE_MS = 60 * 60 * 1000;
/**
 * Version 2 adds the index tree: the store moved from the mirror root to `indexRoot`, so a version 1 state records a
 * full build of a store that no longer exists and is discarded, which rebuilds the scope once.
 */
const STATE_FORMAT_VERSION = 2;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_POLL_MS = 50;
const SKIP_REASONS: ReadonlySet<string> = new Set(["symlink", "submodule", "unsafe-path", "collision"]);

export interface LiveMirrorDeps {
  /** The account the mirror directories must belong to; `undefined` where the platform has no such notion, which skips the ownership and mode checks. */
  ownerUid: number | undefined;
  pid: () => number;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  /** The clock the sweep's touch reads. */
  now: () => number;
}

export const defaultLiveMirrorDeps: LiveMirrorDeps = {
  ownerUid: process.getuid?.(),
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
          return { ok: true, value: { path, size: held.bytes, mtimeNs: current.mtimeNs.toString(), blob: held.blob } };
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
      const temporary = join(dirname(file), `.${randomUUID()}${TEMPORARY_SUFFIX}`);
      try {
        await writeFile(temporary, `${JSON.stringify({ version: STATE_FORMAT_VERSION, ...state }, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
        await rename(temporary, file);
        return { ok: true, value: undefined };
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        return fault("write-failed", error);
      }
    },

    async reconcile(location, paths, manifest, force, signal) {
      const prepared = await prepare(location, "root", true);
      if (!prepared.ok) return prepared;
      const root = rootOf(location);
      const old = new Map(manifest.map((entry) => [entry.path, entry]));
      const forced = new Set(force);
      const skipped: SkippedEntry[] = [];
      const kept: MirrorEntry[] = [];
      const pending: { path: string; stat: BigIntStats }[] = [];
      const directories = new Map<string, "ok" | "link" | "missing">();

      for (const { path, submodule } of paths) {
        if (signal?.aborted) return aborted();
        if (isEngineEntry(path) && !unsafe(path)) continue;
        if (submodule) { skipped.push({ path, reason: "submodule" }); continue; }
        if (unsafe(path)) { skipped.push({ path, reason: "unsafe-path" }); continue; }
        const parents = await parentState(location.repo, path, directories);
        if (parents === "link") { skipped.push({ path, reason: "symlink" }); continue; }
        if (parents === "missing") continue;
        let status: BigIntStats;
        try {
          status = await lstat(join(location.repo, path), { bigint: true });
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) continue;
          return fault("unreadable", error, path);
        }
        if (status.isSymbolicLink()) { skipped.push({ path, reason: "symlink" }); continue; }
        if (!status.isFile()) { skipped.push({ path, reason: "unsafe-path" }); continue; }
        const previous = old.get(path);
        if (previous !== undefined && !forced.has(path) && previous.size === Number(status.size) && previous.mtimeNs === status.mtimeNs.toString()) kept.push(previous);
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
        const entry = await capture(location.repo, root, path, stat, !configuration);
        if (!entry.ok) return entry;
        next.push(entry.value);
        if (configuration) {
          await rm(join(root, path), { force: true });
          await prune(root, path);
        } else if (old.get(path)?.blob !== entry.value.blob) changed.add(path);
      }

      const reconciliation: MirrorReconciliation = {
        manifest: next.sort((a, b) => compare(a.path, b.path)),
        skipped: skipped.sort((a, b) => compare(a.path, b.path)),
        changed: [...changed].sort(compare),
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
      for (const { path, submodule } of paths) {
        if (signal?.aborted) return aborted();
        if (isEngineEntry(path) || submodule || unsafe(path) || skippedOthers.has(path)) continue;
        listed.add(path);
        const status = (await parentState(location.repo, path, directories)) === "ok" ? await lstat(join(location.repo, path), { bigint: true }).catch(() => null) : null;
        const previous = known.get(path);
        if (previous !== undefined) {
          if (status === null || !status.isFile() || previous.size !== Number(status.size) || previous.mtimeNs !== status.mtimeNs.toString()) changed.add(path);
        } else if (skippedLinks.has(path)) {
          if (status?.isFile()) changed.add(path);
        } else if (status !== null) {
          changed.add(path);
        }
      }
      for (const entry of manifest) if (!listed.has(entry.path)) changed.add(entry.path);
      return { ok: true, value: [...changed].sort(compare) };
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

    async discard(location) {
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
        if (entry.name.endsWith(TEMPORARY_SUFFIX)) {
          const status = await lstat(join(live, entry.name)).catch(() => null);
          if (status !== null && now - status.mtimeMs > TEMPORARY_STALE_MS) debris.push(entry.name);
        }
      }
      for (const scope of [...states.keys()]) {
        if (directories.includes(scope)) continue;
        states.delete(scope);
        debris.push(`${scope}${STATE_SUFFIX}`);
      }

      const scopes: MirrorScopeUsage[] = [];
      for (const scope of [...directories].sort(compare)) {
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
      return { ok: true, value: { scopes, debris: debris.sort(compare) } };
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
      try {
        for (const entry of entries) {
          if (entry === "" || entry === "." || entry === ".." || /[/\\\0]/.test(entry)) continue;
          const status = await lstat(join(live, entry)).catch(() => null);
          if (status === null || !status.isFile()) continue;
          await rm(join(live, entry), { force: true });
        }
        return { ok: true, value: undefined };
      } catch (error) {
        return fault("write-failed", error);
      }
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
  let total = 0;
  try {
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const status = await lstat(join(entry.parentPath, entry.name)).catch(() => null);
      if (status !== null && status.isFile()) total += status.size;
    }
  } catch {
    return 0;
  }
  return total;
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

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino;
}

function unsafe(path: string): boolean {
  return path === "" || path.startsWith("/") || /[\0\\]/.test(path) || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  return isRecord(value) && typeof value.path === "string" && Number.isSafeInteger(value.size) && typeof value.mtimeNs === "string" && /^\d+$/.test(value.mtimeNs) && typeof value.blob === "string";
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
