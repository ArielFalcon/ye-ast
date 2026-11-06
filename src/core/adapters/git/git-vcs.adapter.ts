import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, rm, stat, symlink, type FileHandle } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createDiffReader, type FileChange } from "../../domain/change/diff-reader.ts";
import type { Result } from "../../domain/shared/result.ts";
import { isFullObjectId } from "../../domain/shared/revision.ts";
import type { CommitExport, ExportBudget, ExportedFile, ExportPlan, ExportStop, RemoteRef, SkippedEntry, Vcs, VcsChanges, VcsFault } from "../../ports/vcs.port.ts";
import { claimPath, isConfinedPath, type PathClaims } from "./export-path-rules.ts";

export interface GitRun {
  code: number;
  stdout: Buffer;
  stderr: string;
  /** Why the process never ran: a root no command can start in, or a missing `git`. */
  spawnFailure?: "unreadable-root";
}

/** Receives the blobs one after another: `start` of the next comes after `finish` of the previous. */
export interface BlobSink {
  /** `size` is the blob's byte length, or `null` when the object store lacks it, and then nothing else follows. */
  start(index: number, size: number | null): Promise<void>;
  /** A part of the current blob, in order; the parts add up to the announced size and none is the whole blob. */
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<void>;
}

/** Aborting the signal kills the git process. */
export interface GitDeps {
  realpath(path: string): Promise<string>;
  /** For commands with a small answer: the whole output is buffered. */
  runGit(repo: string, args: readonly string[], signal?: AbortSignal): Promise<GitRun>;
  /** Like `runGit`, with the user and system git configuration empty. */
  runIsolatedGit(repo: string, args: readonly string[], signal?: AbortSignal): Promise<GitRun>;
  /**
   * Streams the NUL-separated records of the command's output without buffering it; a record is valid only during the
   * call. When `onRecord` throws, the git process is killed.
   */
  streamRecords(repo: string, args: readonly string[], onRecord: (record: Buffer) => void, signal?: AbortSignal): Promise<GitRun>;
  /**
   * Streams the newline-separated lines of the command's output without buffering it, with the user and system git
   * configuration empty; a line is valid only during the call. When `onLine` throws, the git process is killed.
   */
  streamLines(repo: string, args: readonly string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<GitRun>;
  /**
   * Streams the byte length of each blob, in order, through `cat-file --batch-check`, without its content: `null` for a
   * blob the object store lacks. When `onSize` throws, the git process is killed.
   */
  checkBlobs(repo: string, blobs: readonly string[], onSize: (size: number | null) => void, signal?: AbortSignal): Promise<GitRun>;
  /** Streams the content of each blob, in order, through `cat-file --batch`. When the sink throws, the git process is killed. */
  streamBlobs(repo: string, blobs: readonly string[], sink: BlobSink, signal?: AbortSignal): Promise<GitRun>;
}

/** Thrown by the export's own callbacks to stop git; the fault they carry is the answer. */
class ExportStopped extends Error {
  constructor(readonly fault: VcsFault) {
    super(fault.kind);
    this.name = "ExportStopped";
  }
}

/** Thrown by the export's own callbacks when a budget ran out; the stop is recorded where the export keeps it. */
const UNBOUNDED: ExportBudget = { maxEntries: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY };

class BudgetExhausted extends Error {
  constructor() {
    super("budget exhausted");
    this.name = "BudgetExhausted";
  }
}

class CatFileProtocolError extends Error {
  constructor(answer: string) {
    super(`cat-file answered ${answer}`);
    this.name = "CatFileProtocolError";
  }
}

const MODE = { symlink: "120000", submodule: "160000" } as const;
const REVISION_NOT_FOUND = 1;
/** `git symbolic-ref --quiet` answers a detached head, which no branch names, with exit code 1. */
const HEAD_DETACHED = 1;
const NO_CONFIG_VALUE = 1;
const REMOTE_URL = /^remote\.(.+?)\.url (.*)$/;
const ABORTED_FAULT: VcsFault = { kind: "aborted", detail: "interrupted by the caller" };
export const ABORTED: Result<never, VcsFault> = { ok: false, fault: ABORTED_FAULT };
const SPAWN_FAILED = -1;
const NEWLINE = 10;
const NUL = 0;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export const defaultGitDeps: GitDeps = {
  realpath,
  runGit: (repo, args, signal) => spawnGit(repo, args, readAll, "", false, signal),
  runIsolatedGit: (repo, args, signal) => spawnGit(repo, args, readAll, "", true, signal),
  streamRecords: (repo, args, onRecord, signal) => spawnGit(repo, args, (stdout) => readRecords(stdout, onRecord, NUL), "", false, signal),
  streamLines: (repo, args, onLine, signal) =>
    spawnGit(repo, args, (stdout) => readRecords(stdout, (line) => onLine(line.toString("utf8")), NEWLINE), "", true, signal),
  checkBlobs: (repo, blobs, onSize, signal) =>
    spawnGit(repo, ["cat-file", "--batch-check"], (stdout) => readRecords(stdout, (line) => onSize(blobSize(line)), NEWLINE), `${blobs.join("\n")}\n`, false, signal),
  streamBlobs: (repo, blobs, sink, signal) =>
    spawnGit(repo, ["cat-file", "--batch"], (stdout) => readBatch(stdout, blobs.length, sink), `${blobs.join("\n")}\n`, false, signal),
};

export function createGitVcs(deps: GitDeps = defaultGitDeps): Vcs & VcsChanges {
  async function canonicalRoot(repo: string, signal?: AbortSignal): Promise<Result<string, VcsFault>> {
    if (signal?.aborted) return ABORTED;
    const root = await ensureRepositoryRoot(deps, repo, signal);
    if (signal?.aborted) return ABORTED;
    if (!root.ok) return root;
    try {
      const path = await deps.realpath(repo);
      if (signal?.aborted) return ABORTED;
      return { ok: true, value: path };
    } catch {
      if (signal?.aborted) return ABORTED;
      return { ok: false, fault: { kind: "unreadable", detail: repo } };
    }
  }

  async function resolveCommit(repo: string, revision: string, signal?: AbortSignal): Promise<Result<string, VcsFault>> {
    const root = await ensureRepositoryRoot(deps, repo, signal);
    if (!root.ok) return root;
    const run = await deps.runGit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], signal);
    if (signal?.aborted) return ABORTED;
    if (run.code === REVISION_NOT_FOUND) return { ok: false, fault: { kind: "unknown-revision", detail: revision } };
    if (run.code !== 0) return gitFailed(run);
    return { ok: true, value: run.stdout.toString("utf8").trim() };
  }

  async function listCommit(repo: string, sha: string, plan: ExportPlan, signal?: AbortSignal): Promise<Result<CommitExport, VcsFault>> {
    const resolved = await resolveCommit(repo, sha, signal);
    if (!resolved.ok) return resolved;
    if (resolved.value !== sha) return { ok: false, fault: { kind: "unknown-revision", detail: `${sha} is not a full commit sha` } };

    const files: ExportedFile[] = [];
    const selected: ExportedFile[] = [];
    const skipped: SkippedEntry[] = [];
    const claimed: PathClaims = new Map();
    const { maxEntries, maxBytes } = plan.budget ?? UNBOUNDED;
    let entries = 0;
    let listingStop: ExportStop | undefined;
    const listing = await deps.streamRecords(
      repo,
      ["ls-tree", "-r", "-z", "--full-tree", sha],
      (record) => {
        const entry = parseEntry(record);
        if (entries === maxEntries) {
          listingStop = { at: entry.path, limit: maxEntries };
          throw new BudgetExhausted();
        }
        entries += 1;
        const reason = skipReason(entry, claimed);
        if (reason !== undefined) {
          skipped.push({ path: entry.path, reason });
          return;
        }
        const file: ExportedFile = { path: entry.path, blob: entry.blob, written: false };
        files.push(file);
        if (plan.write(file.path)) selected.push(file);
      },
      signal,
    );
    if (signal?.aborted) return ABORTED;
    if (listingStop === undefined && listing.code !== 0) return gitFailed(listing);

    let failure: VcsFault | undefined;
    let blobStop: ExportStop | undefined;
    let bytes = 0;
    let index = 0;
    const checked = selected.length === 0 ? undefined : await deps.checkBlobs(
      repo,
      selected.map((file) => file.blob),
      (size) => {
        const file = selected[index++];
        if (file === undefined) return;
        if (signal?.aborted) {
          failure = ABORTED_FAULT;
          throw new ExportStopped(ABORTED_FAULT);
        }
        if (size === null) {
          failure = { kind: "object-missing", detail: `${file.blob} of ${file.path} is not in the local object store` };
          throw new ExportStopped(failure);
        }
        if (bytes + size > maxBytes) {
          blobStop = { at: file.path, limit: maxBytes };
          throw new BudgetExhausted();
        }
        bytes += size;
        file.written = true;
      },
      signal,
    );
    if (failure !== undefined) return { ok: false, fault: failure };
    if (signal?.aborted) return ABORTED;
    if (checked !== undefined && blobStop === undefined && checked.code !== 0) return gitFailed(checked);
    const stopped = blobStop ?? listingStop;
    return { ok: true, value: { files, skipped, ...(stopped === undefined ? {} : { stopped }) } };
  }

  async function materializeCommit(repo: string, files: readonly ExportedFile[], destination: string, signal?: AbortSignal): Promise<Result<void, VcsFault>> {
    const written = files.filter((file) => file.written);
    if (written.length === 0) return { ok: true, value: undefined };
    let failure: VcsFault | undefined;
    let output: FileHandle | undefined;
    const guarded = <Args extends unknown[]>(step: (...args: Args) => Promise<void>) => async (...args: Args): Promise<void> => {
      try {
        await step(...args);
      } catch (error) {
        failure = error instanceof ExportStopped ? error.fault : { kind: "export-write-failed", detail: errorDetail(error) };
        throw error;
      }
    };
    const sink: BlobSink = {
      start: guarded(async (index, size) => {
        if (signal?.aborted) throw new ExportStopped(ABORTED_FAULT);
        const file = written[index]!;
        if (size === null) {
          throw new ExportStopped({ kind: "object-missing", detail: `${file.blob} of ${file.path} is not in the local object store` });
        }
        const target = join(destination, file.path);
        await mkdir(dirname(target), { recursive: true });
        output = await open(target, "wx");
      }),
      write: guarded((chunk) => output!.writeFile(chunk)),
      finish: guarded(async () => {
        await output!.close();
        output = undefined;
      }),
    };
    const streamed = await deps.streamBlobs(repo, written.map((file) => file.blob), sink, signal);
    await output?.close().catch(() => undefined);
    if (failure !== undefined) return { ok: false, fault: failure };
    if (signal?.aborted) return ABORTED;
    if (streamed.code !== 0) return gitFailed(streamed);
    return { ok: true, value: undefined };
  }

  async function exportCommit(repo: string, sha: string, destination: string, plan: ExportPlan, signal?: AbortSignal): Promise<Result<CommitExport, VcsFault>> {
    const listed = await listCommit(repo, sha, plan, signal);
    if (!listed.ok) return listed;
    const written = await materializeCommit(repo, listed.value.files, destination, signal);
    return written.ok ? listed : written;
  }

  async function mergeBase(repo: string, first: string, second: string, signal?: AbortSignal): Promise<Result<string, VcsFault>> {
    if (!isFullObjectId(first) || !isFullObjectId(second)) return { ok: false, fault: { kind: "unknown-revision", detail: "a merge base takes full commit shas" } };
    const run = await deps.runIsolatedGit(repo, ["merge-base", "--end-of-options", first, second], signal);
    if (signal?.aborted) return ABORTED;
    if (run.code === REVISION_NOT_FOUND) return { ok: false, fault: { kind: "no-merge-base", detail: `${first} and ${second} share no history` } };
    if (run.code !== 0) return gitFailed(run);
    return { ok: true, value: run.stdout.toString("utf8").trim() };
  }

  async function diffCommits(repo: string, base: string, head: string, signal?: AbortSignal): Promise<Result<readonly FileChange[], VcsFault>> {
    if (!isFullObjectId(base) || !isFullObjectId(head)) return { ok: false, fault: { kind: "unknown-revision", detail: "a diff takes full commit shas" } };
    const reader = createDiffReader();
    const run = await deps.streamLines(repo, [...DIFF_ARGUMENTS, base, head], (line) => reader.push(line), signal);
    if (signal?.aborted) return ABORTED;
    if (run.code !== 0) return gitFailed(run);
    return { ok: true, value: reader.finish() };
  }

  async function diffDirectories(base: string, head: string, signal?: AbortSignal): Promise<Result<readonly FileChange[], VcsFault>> {
    const reader = createDiffReader();
    const scratch = await mkdtemp(join(tmpdir(), "ye-ast-diff-"));
    try {
      await symlink(base, join(scratch, BASE_LINK));
      await symlink(head, join(scratch, HEAD_LINK));
      const run = await deps.streamLines(
        scratch,
        ["-c", "core.attributesFile=/dev/null", "diff", "--no-index", ...DIFF_OPTIONS, `${BASE_LINK}/`, `${HEAD_LINK}/`],
        (line) => reader.push(line.startsWith(DIFF_HEADER) ? stripLinkNames(line) : line),
        signal,
      );
      if (signal?.aborted) return ABORTED;
      if (run.code !== 0 && (run.code !== DIFFERENCES_FOUND || GIT_ERROR.test(run.stderr))) return gitFailed(run);
      return { ok: true, value: reader.finish() };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** `remote.<name>.url` under an empty configuration: the repository's own remotes, never a rewrite of the machine's. */
  async function remotes(repo: string, signal?: AbortSignal): Promise<Result<readonly RemoteRef[], VcsFault>> {
    const run = await deps.runIsolatedGit(repo, ["config", "--get-regexp", "^remote\\..*\\.url$"], signal);
    if (signal?.aborted) return ABORTED;
    if (run.code !== 0 && run.code !== NO_CONFIG_VALUE) return gitFailed(run);
    return { ok: true, value: parseRemotes(run.stdout.toString("utf8")) };
  }

  async function headBranch(repo: string, signal?: AbortSignal): Promise<Result<string | undefined, VcsFault>> {
    const run = await deps.runGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
    if (signal?.aborted) return ABORTED;
    if (run.code === HEAD_DETACHED) return { ok: true, value: undefined };
    if (run.code !== 0) return gitFailed(run);
    return { ok: true, value: run.stdout.toString("utf8").trim() };
  }

  async function repositoryName(repo: string, signal?: AbortSignal): Promise<Result<string, VcsFault>> {
    const root = await ensureRepositoryRoot(deps, repo, signal);
    if (!root.ok) return root;
    const run = await deps.runGit(repo, ["worktree", "list", "--porcelain", "-z"], signal);
    if (signal?.aborted) return ABORTED;
    if (run.code !== 0) return gitFailed(run);
    const main = mainWorktreeOf(run.stdout.toString("utf8"));
    if (main === undefined) return { ok: false, fault: { kind: "git-failed", detail: "git listed no worktree" } };
    return { ok: true, value: basename(main) };
  }

  return { canonicalRoot, resolveCommit, exportCommit, listCommit, materializeCommit, mergeBase, diffCommits, diffDirectories, remotes, headBranch, repositoryName };
}

/**
 * The first record `git worktree list --porcelain -z` states: the main worktree, which every linked worktree of the
 * repository shares, so its directory name is the name of the repository itself. NUL-separated records leave the path
 * unquoted, whatever characters it holds.
 */
function mainWorktreeOf(output: string): string | undefined {
  const record = output.split("\0").find((field) => field.startsWith("worktree "));
  const path = record?.slice("worktree ".length);
  return path === undefined || path === "" ? undefined : path;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseRemotes(output: string): RemoteRef[] {
  return output
    .split("\n")
    .flatMap((line) => {
      const match = REMOTE_URL.exec(line);
      return match === null ? [] : [{ name: match[1] ?? "", url: match[2] ?? "" }];
    })
    .filter((remote) => remote.name !== "" && remote.url !== "")
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.url, b.url));
}

/** Fails with `not-repository-root` when `repo` is a subdirectory of its repository. */
export async function ensureRepositoryRoot(deps: Pick<GitDeps, "runGit">, repo: string, signal?: AbortSignal): Promise<Result<void, VcsFault>> {
  const prefix = await deps.runGit(repo, ["rev-parse", "--show-prefix"], signal);
  if (signal?.aborted) return ABORTED;
  if (prefix.code !== 0) return gitFailed(prefix);
  const subdirectory = prefix.stdout.toString("utf8").trim();
  if (subdirectory !== "") {
    return { ok: false, fault: { kind: "not-repository-root", detail: `the path is ${subdirectory} inside its repository; pass the repository root` } };
  }
  return { ok: true, value: undefined };
}

const BASE_LINK = "base";
const HEAD_LINK = "head";
const DIFFERENCES_FOUND = 1;
const DIFF_HEADER = "diff --git ";
const GIT_ERROR = /^(error|fatal):/m;
const LINK_NAMES = `(?:${BASE_LINK}|${HEAD_LINK})`;
const FIRST_PATH = new RegExp(`^${DIFF_HEADER}("?)([ab])/${LINK_NAMES}/`);
const SECOND_PATH = new RegExp(` ("?)([ab])/${LINK_NAMES}/`);

/** Rewrites `a/base/x b/head/x` to `a/x b/x`, so the paths are relative to each directory as in a commit diff. */
function stripLinkNames(header: string): string {
  return header.replace(FIRST_PATH, `${DIFF_HEADER}$1$2/`).replace(SECOND_PATH, " $1$2/");
}

/** Every option that changes the hunks is given, so no configuration of the machine or the repository decides them. */
const DIFF_OPTIONS: readonly string[] = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--text",
  "--unified=0",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

const DIFF_ARGUMENTS: readonly string[] = ["diff-tree", "-r", "-p", ...DIFF_OPTIONS];

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function gitFailed(run: GitRun): Result<never, VcsFault> {
  return run.spawnFailure === "unreadable-root" ? { ok: false, fault: { kind: "unreadable", detail: run.stderr } } : { ok: false, fault: { kind: "git-failed", detail: run.stderr } };
}

interface ListedEntry {
  mode: string | undefined;
  blob: string;
  path: string;
  /** False when the name is not valid UTF-8, and `path` holds its lossy decoding. */
  validName: boolean;
}

function parseEntry(record: Buffer): ListedEntry {
  const tab = record.indexOf("\t");
  const [mode, , blob] = record.subarray(0, tab).toString("utf8").split(" ");
  const name = record.subarray(tab + 1);
  const decoded = decodeStrict(name);
  return { mode, blob: blob!, path: decoded ?? name.toString("utf8"), validName: decoded !== null };
}

function skipReason(entry: ListedEntry, claimed: PathClaims): SkippedEntry["reason"] | undefined {
  if (entry.mode === MODE.symlink) return "symlink";
  if (entry.mode === MODE.submodule) return "submodule";
  if (!entry.validName || !isConfinedPath(entry.path)) return "unsafe-path";
  if (!claimPath(claimed, entry.path)) return "collision";
  return undefined;
}

function decodeStrict(bytes: Buffer): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

async function readAll(stdout: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdout) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readRecords(stdout: AsyncIterable<Buffer>, onRecord: (record: Buffer) => void, delimiter: number): Promise<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const chunk of stdout) {
    let start = 0;
    for (let end = chunk.indexOf(delimiter); end >= 0; end = chunk.indexOf(delimiter, start)) {
      onRecord(pending.length === 0 ? chunk.subarray(start, end) : Buffer.concat([pending, chunk.subarray(start, end)]));
      pending = Buffer.alloc(0);
      start = end + 1;
    }
    pending = Buffer.concat([pending, chunk.subarray(start)]);
  }
  return Buffer.alloc(0);
}

/** The length a `cat-file --batch-check` line states, or `null` for a blob the object store lacks. */
function blobSize(line: Buffer): number | null {
  const fields = line.toString("utf8").split(" ");
  if (fields[1] === "missing") return null;
  if (fields[1] !== "blob") throw new CatFileProtocolError(fields.join(" "));
  return Number(fields[2]);
}

async function readBatch(stdout: AsyncIterable<Buffer>, count: number, sink: BlobSink): Promise<Buffer> {
  let index = 0;
  let header = Buffer.alloc(0);
  let size: number | null = null;
  let received = 0;
  for await (const chunk of stdout) {
    let offset = 0;
    while (offset < chunk.length && index < count) {
      if (size === null) {
        const newline = chunk.indexOf(NEWLINE, offset);
        if (newline < 0) {
          header = Buffer.concat([header, chunk.subarray(offset)]);
          break;
        }
        const fields = Buffer.concat([header, chunk.subarray(offset, newline)]).toString("utf8").split(" ");
        header = Buffer.alloc(0);
        offset = newline + 1;
        if (fields[1] === "missing") {
          await sink.start(index, null);
          index += 1;
          continue;
        }
        if (fields[1] !== "blob") throw new CatFileProtocolError(fields.join(" "));
        size = Number(fields[2]);
        received = 0;
        await sink.start(index, size);
      }
      const taken = Math.min(chunk.length - offset, size + 1 - received);
      const content = Math.min(taken, Math.max(0, size - received));
      if (content > 0) await sink.write(chunk.subarray(offset, offset + content));
      received += taken;
      offset += taken;
      if (received === size + 1) {
        await sink.finish();
        index += 1;
        size = null;
      }
    }
  }
  return Buffer.alloc(0);
}

/**
 * Git never fetches: `GIT_NO_LAZY_FETCH` (git 2.44) stops a partial clone from fetching missing objects, and an empty
 * `GIT_ALLOW_PROTOCOL` refuses every transport, which also holds on a git that ignores the first. An isolated run also
 * empties the user and system configuration, so neither the machine nor its owner changes what git answers; the export
 * and the revision lookup keep them, because a host may rely on a global `safe.directory`.
 */
export function gitEnvironment(host: NodeJS.ProcessEnv = process.env, isolated = false): NodeJS.ProcessEnv {
  const inherited = Object.entries(host).filter(([name]) => !name.startsWith("GIT_"));
  return {
    ...Object.fromEntries(inherited),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    ...(isolated ? { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" } : {}),
  };
}

function spawnGit(
  repo: string,
  args: readonly string[],
  consume: (stdout: AsyncIterable<Buffer>) => Promise<Buffer>,
  stdin: string,
  isolated: boolean,
  signal?: AbortSignal,
): Promise<GitRun> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("git", args, { cwd: repo, env: gitEnvironment(process.env, isolated), stdio: ["pipe", "pipe", "pipe"], signal });
  } catch (error) {
    return failedSpawn(error, repo);
  }
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => undefined);
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? SPAWN_FAILED));
  });
  child.stdin.end(stdin);
  const consumed = consume(child.stdout).catch((error: unknown) => {
    child.kill();
    throw error;
  });
  return Promise.allSettled([consumed, exited]).then(async ([consumption, exit]) => {
    if (consumption.status === "rejected") return failedRun(consumption.reason);
    if (exit.status === "rejected") return failedSpawn(exit.reason, repo);
    return { code: exit.value, stdout: consumption.value, stderr: Buffer.concat(stderr).toString("utf8") };
  });
}

/** A process that never ran: its root is unreadable, or the machine has no `git` to start. */
async function failedSpawn(reason: unknown, repo: string): Promise<GitRun> {
  return (await startsInRoot(repo)) ? failedRun(reason) : { code: SPAWN_FAILED, stdout: Buffer.alloc(0), stderr: repo, spawnFailure: "unreadable-root" };
}

/** Whether a process can start in `path`: the only thing a spawn failure cannot tell from a missing binary. */
async function startsInRoot(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function failedRun(reason: unknown): GitRun {
  return { code: SPAWN_FAILED, stdout: Buffer.alloc(0), stderr: String(reason) };
}
