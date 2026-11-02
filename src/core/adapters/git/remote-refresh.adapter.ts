import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import type { RemoteBranch, RemoteFreshness, RemoteListing } from "../../domain/topology/remote-snapshot.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { RefreshedRemote, RemoteRefresh, RemoteRefreshRequest } from "../../ports/remote-refresh.port.ts";
import { gitEnvironment } from "./git-vcs.adapter.ts";

/** The transports a refresh may use; only these two reach the network (ADR-0016 decision 6). */
export const DEFAULT_PROTOCOLS = "https:ssh";

/** Names the process refreshing one mirror; its liveness decides whether the mirror answers or waits. */
export const REFRESH_LOCK_SUFFIX = ".lock";

const MIRRORS_DIRECTORY = "remotes";
const LISTING_FILE = "ye-ast-listing.json";
const LISTING_VERSION = 1;
const HEADS = "refs/heads/";
const YE_AST_HEADS = "refs/ye-ast/heads/";
const YE_AST_SEED = "refs/ye-ast/seed/";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_POLL_MS = 50;
const SPAWN_FAILED = -1;
const SHALLOW_CHECK = ["rev-parse", "--is-shallow-repository"];
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

export interface RemoteGitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one git command: the seam a test replaces to pin an argument list without spawning. */
export type RunRemoteGit = (cwd: string, args: readonly string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<RemoteGitRun>;

export interface RemoteRefreshDeps {
  /** ye-ast's own cache directory: the mirror lives at `<cacheDirectory>/remotes/<digest of the url>`. */
  cacheDirectory: string;
  digest: Digest;
  pid: () => number;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => Date;
  /** The transports git may use; `https:ssh` by default, never wider. */
  protocols?: string;
  /** The account the mirror directories must belong to; `undefined` where the platform has no such notion. */
  ownerUid?: number;
  runGit?: RunRemoteGit;
}

const getuid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);
const defaultOwnerUid = getuid();

export const defaultRemoteRefreshDeps: Omit<RemoteRefreshDeps, "cacheDirectory" | "digest"> = {
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
  now: () => new Date(),
  protocols: DEFAULT_PROTOCOLS,
  ...(defaultOwnerUid === undefined ? {} : { ownerUid: defaultOwnerUid }),
  runGit: spawnRemoteGit,
};

/**
 * Builds the environment of one refresh on top of the plain git environment: every inherited `GIT_*` variable is
 * dropped, no transport but the requested ones is allowed, and git can never prompt.
 */
export function remoteRefreshEnvironment(host: NodeJS.ProcessEnv = process.env, protocols: string = DEFAULT_PROTOCOLS): NodeJS.ProcessEnv {
  return { ...gitEnvironment(host, false), GIT_ALLOW_PROTOCOL: protocols, GIT_TERMINAL_PROMPT: "0" };
}

/** The exact fetch of ADR-0016 decision 6, for one branch, into the mirror's own refs. */
export function fetchArguments(url: string, branch: string): readonly string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "transfer.credentialsInUrl=die",
    "-c", "transfer.fsckObjects=true",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--porcelain",
    "--end-of-options",
    url,
    `+${HEADS}${branch}:${YE_AST_HEADS}${branch}`,
  ];
}

/** Copies the local seed's branches into the mirror's own namespace, so every ref stays under `refs/ye-ast/`. */
function seedArguments(seed: string): readonly string[] {
  return ["-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--no-recurse-submodules", "--end-of-options", seed, `+${HEADS}*:${YE_AST_SEED}*`];
}

/**
 * Refreshes declared remotes into full bare mirrors under `<cacheDirectory>/remotes/`, keyed by a digest of the URL
 * and shared across workspaces. A refresh takes a lock beside the mirror, lists the remote, fetches the shas the mirror
 * lacks and records the listing it verified; a query that finds a live holder answers the recorded listing with
 * freshness `refresh-in-progress`. A failure is the remote's freshness, never a fault.
 */
export function createRemoteRefresh(deps: RemoteRefreshDeps): RemoteRefresh {
  const runGit: RunRemoteGit = deps.runGit ?? spawnRemoteGit;
  const environment = remoteRefreshEnvironment(process.env, deps.protocols ?? DEFAULT_PROTOCOLS);
  // The seed is local; only the local transport is allowed for it, so the network stays closed while the mirror is seeded.
  const seedEnvironment: NodeJS.ProcessEnv = { ...environment, GIT_ALLOW_PROTOCOL: "file" };
  const ownerUid = deps.ownerUid ?? getuid();

  const root = deps.cacheDirectory;
  const mirrors = join(root, MIRRORS_DIRECTORY);

  async function inspect(path: string): Promise<"absent" | "private" | "refused"> {
    let status: Stats;
    try {
      status = await lstat(path);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "absent" : "refused";
    }
    if (status.isSymbolicLink() || ownerUid !== undefined) {
      const refusal = privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, ownerUid ?? status.uid);
      if (refusal !== null) return "refused";
    }
    return status.isDirectory() ? "private" : "refused";
  }

  async function ensurePrivateDirectory(path: string): Promise<boolean> {
    const presence = await inspect(path);
    if (presence === "refused") return false;
    if (presence === "private") return true;
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return false;
    }
    return (await inspect(path)) === "private";
  }

  /** Ensures the cache chain exists and is private; safe to race, since a directory creation that loses is re-inspected. */
  async function prepareStore(signal?: AbortSignal): Promise<"ready" | "failed" | "deadline"> {
    try {
      await mkdir(deps.cacheDirectory, { recursive: true, mode: DIRECTORY_MODE });
    } catch {
      return "failed";
    }
    for (const directory of [root, mirrors]) {
      if (!(await ensurePrivateDirectory(directory))) return "failed";
      if (signal?.aborted) return "deadline";
    }
    return "ready";
  }

  /** Runs under the lock: creates the mirror, seeds it from the local clone, and refuses a shallow one. */
  async function prepareMirror(mirror: string, seed: string | undefined, signal?: AbortSignal): Promise<"ready" | "failed" | "deadline"> {
    const presence = await inspect(mirror);
    if (presence === "refused") return "failed";
    if (presence === "absent") {
      let seedFrom: string | undefined;
      if (seed !== undefined) {
        const source = await runGit(seed, SHALLOW_CHECK, seedEnvironment, signal);
        if (signal?.aborted) return "deadline";
        if (source.code === 0 && source.stdout.trim() === "true") return "failed";
        if (source.code === 0) seedFrom = seed;
      }
      const initialized = await runGit(mirrors, ["init", "--bare", "--quiet", mirror], environment, signal);
      if (signal?.aborted) return "deadline";
      if (initialized.code !== 0) return "failed";
      await chmod(mirror, DIRECTORY_MODE).catch(() => undefined);
      if (seedFrom !== undefined) {
        // Seeding is an optimization: when it fails the mirror stays empty and the remote's own fetch follows.
        await runGit(mirror, seedArguments(seedFrom), seedEnvironment, signal);
        if (signal?.aborted) return "deadline";
      }
      return (await inspect(mirror)) === "private" ? "ready" : "failed";
    }
    const shallow = await runGit(mirror, SHALLOW_CHECK, environment, signal);
    if (signal?.aborted) return "deadline";
    if (shallow.code !== 0) return "failed";
    if (shallow.stdout.trim() === "true") {
      await rm(mirror, { recursive: true, force: true }).catch(() => undefined);
      return "failed";
    }
    return "ready";
  }

  async function createLock(file: string, pid: number): Promise<boolean> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, String(pid), { mode: FILE_MODE, flag: "wx" });
      await link(temporary, file);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
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

  async function acquireLock(file: string, signal?: AbortSignal): Promise<"held" | "busy" | "deadline"> {
    const pid = deps.pid();
    for (;;) {
      if (signal?.aborted) return "deadline";
      if (await createLock(file, pid)) return "held";
      const holder = await readHolder(file);
      if (holder !== null && holder.pid !== null && deps.isAlive(holder.pid)) return "busy";
      if (holder !== null) {
        const again = await readHolder(file);
        if (again !== null && again.text === holder.text) await rm(file, { force: true }).catch(() => undefined);
      }
      await deps.sleep(LOCK_POLL_MS, signal);
    }
  }

  async function releaseLock(file: string): Promise<void> {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text?.trim() === String(deps.pid())) await rm(file, { force: true });
  }

  async function readRecord(mirror: string): Promise<RecordedListing | undefined> {
    let text: string;
    try {
      text = await readFile(join(mirror, LISTING_FILE), "utf8");
    } catch {
      return undefined;
    }
    try {
      return parseRecord(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  async function writeRecord(mirror: string, listing: RemoteListing, verifiedAt: string): Promise<void> {
    const file = join(mirror, LISTING_FILE);
    const temporary = join(mirror, `.${randomUUID()}.tmp`);
    const record = { version: LISTING_VERSION, branches: listing.branches, ...(listing.defaultBranch === undefined ? {} : { defaultBranch: listing.defaultBranch }), verifiedAt };
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async function unverified(url: string, mirror: string, reason: UnverifiedReason): Promise<RefreshedRemote> {
    const record = await readRecord(mirror);
    const freshness: RemoteFreshness = record === undefined
      ? { status: "unverified", reason }
      : { status: "unverified", reason, lastVerifiedAt: record.verifiedAt };
    return {
      url,
      ...(record === undefined ? {} : { listing: record.listing }),
      freshness,
      ...((await isDirectory(mirror)) ? { mirror } : {}),
    };
  }

  async function refreshMirror(url: string, mirror: string, signal?: AbortSignal): Promise<RefreshedRemote> {
    const listed = await runGit(mirror, ["ls-remote", "--symref", "--end-of-options", url], environment, signal);
    if (signal?.aborted) return unverified(url, mirror, "deadline");
    if (listed.code !== 0) return unverified(url, mirror, "failed");
    const listing = parseListing(listed.stdout);
    for (const branch of listing.branches) {
      if (signal?.aborted) return unverified(url, mirror, "deadline");
      const held = await runGit(mirror, ["cat-file", "-e", branch.sha], environment, signal);
      if (signal?.aborted) return unverified(url, mirror, "deadline");
      if (held.code === 0) continue;
      const valid = await runGit(mirror, ["check-ref-format", "--branch", branch.name], environment, signal);
      if (signal?.aborted) return unverified(url, mirror, "deadline");
      if (valid.code !== 0) continue;
      const fetched = await runGit(mirror, fetchArguments(url, branch.name), environment, signal);
      if (signal?.aborted) return unverified(url, mirror, "deadline");
      if (fetched.code !== 0) return unverified(url, mirror, "failed");
    }
    const verifiedAt = deps.now().toISOString();
    await writeRecord(mirror, listing, verifiedAt);
    return { url, listing, freshness: { status: "verified" }, mirror };
  }

  async function refreshOne(request: RemoteRefreshRequest, signal?: AbortSignal): Promise<RefreshedRemote> {
    const key = deps.digest.of(request.url);
    const mirror = join(mirrors, key);
    const lockFile = join(mirrors, `${key}${REFRESH_LOCK_SUFFIX}`);
    if (signal?.aborted) return unverified(request.url, mirror, "deadline");
    try {
      const store = await prepareStore(signal);
      if (store === "deadline") return unverified(request.url, mirror, "deadline");
      if (store === "failed") return unverified(request.url, mirror, "failed");
      const lock = await acquireLock(lockFile, signal);
      if (lock === "deadline") return unverified(request.url, mirror, "deadline");
      if (lock === "busy") return unverified(request.url, mirror, "refresh-in-progress");
      try {
        const prepared = await prepareMirror(mirror, request.seed, signal);
        if (prepared === "deadline") return unverified(request.url, mirror, "deadline");
        if (prepared === "failed") return unverified(request.url, mirror, "failed");
        return await refreshMirror(request.url, mirror, signal);
      } finally {
        await releaseLock(lockFile);
      }
    } catch {
      return unverified(request.url, mirror, "failed");
    }
  }

  return {
    async refresh(requests, signal) {
      const pending = new Map<string, Promise<RefreshedRemote>>();
      const answers = requests.map((request) => {
        let answer = pending.get(request.url);
        if (answer === undefined) {
          answer = refreshOne(request, signal);
          pending.set(request.url, answer);
        }
        return answer;
      });
      return Promise.all(answers);
    },
  };
}

type UnverifiedReason = Extract<RemoteFreshness, { status: "unverified" }>["reason"];

interface RecordedListing {
  listing: RemoteListing;
  verifiedAt: string;
}

/** Reads the branches and the default branch a `--symref` listing states, ignoring HEAD and every non-branch ref. */
function parseListing(output: string): RemoteListing {
  const branches: RemoteBranch[] = [];
  let defaultBranch: string | undefined;
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const left = line.slice(0, tab);
    const right = line.slice(tab + 1);
    if (left.startsWith("ref: ")) {
      const target = left.slice("ref: ".length);
      if (right === "HEAD" && target.startsWith(HEADS)) defaultBranch = target.slice(HEADS.length);
      continue;
    }
    if (!right.startsWith(HEADS) || !FULL_SHA.test(left)) continue;
    const name = right.slice(HEADS.length);
    if (name !== "") branches.push({ name, sha: left });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { branches, ...(defaultBranch === undefined ? {} : { defaultBranch }) };
}

function parseRecord(value: unknown): RecordedListing | undefined {
  if (!isRecord(value) || value.version !== LISTING_VERSION || typeof value.verifiedAt !== "string") return undefined;
  const { branches, defaultBranch } = value;
  if (!Array.isArray(branches) || !branches.every(isBranch)) return undefined;
  if (defaultBranch !== undefined && typeof defaultBranch !== "string") return undefined;
  return { listing: { branches, ...(defaultBranch === undefined ? {} : { defaultBranch }) }, verifiedAt: value.verifiedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBranch(value: unknown): value is RemoteBranch {
  return isRecord(value) && typeof value.name === "string" && typeof value.sha === "string";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Runs git with the caller's environment, stdin an ended pipe and no terminal, buffering both streams. The child is
 * detached, so it owns a session of its own and inherits no controlling terminal; aborting the signal kills it, and a
 * process that never started answers `SPAWN_FAILED`.
 */
function spawnRemoteGit(cwd: string, args: readonly string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<RemoteGitRun> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], signal, detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", () => resolve({ code: SPAWN_FAILED, stdout: "", stderr: "" }));
    child.on("close", (code) =>
      resolve({ code: code ?? SPAWN_FAILED, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
    child.stdin.end();
  });
}
