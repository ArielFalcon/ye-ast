/**
 * Disposable clones of corpus repositories for the latency bench and the warm differential, and the git and CLI steps
 * a run takes on them. Nothing is written to the corpus repository: a clone shares its objects read-only.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { engineCommand } from "./latency-session.ts";

export function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const run = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

/** A clone of `source` at `sha`, detached, at `destination`. */
export function cloneAt(source: string, sha: string, destination: string, env: NodeJS.ProcessEnv): string {
  git(process.cwd(), ["clone", "--quiet", "--shared", "--no-checkout", source, destination], env);
  git(destination, ["checkout", "--quiet", "--detach", sha], env);
  return destination;
}

/** How far back the first-parent history is searched for commits that hold the queried files. */
const HISTORY_SEARCHED = 200;

/**
 * Up to `count` first-parent commits that end at `sha` and hold every one of `files`, oldest first, so a query asks
 * about the same files at each of them.
 */
export function firstParentCommits(repo: string, sha: string, count: number, files: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const history = git(repo, ["rev-list", "--first-parent", `--max-count=${HISTORY_SEARCHED}`, sha], env).split("\n").filter(Boolean);
  const holding = history.filter((commit) => files.every((file) => spawnSync("git", ["cat-file", "-e", `${commit}:${file}`], { cwd: repo, env }).status === 0));
  return holding.slice(0, count).reverse();
}

/** The repository-relative files the tool calls name, as targets or as files. */
export function namedFiles(calls: readonly { args: Record<string, unknown> }[]): string[] {
  const files = calls.flatMap((call) => [...((call.args.targets as { file?: string }[] | undefined) ?? []).flatMap((target) => target.file ?? []), ...((call.args.files as string[] | undefined) ?? [])]);
  return [...new Set(files)];
}

/** The first Java or TypeScript file the tool calls name: the file a run's edits change. */
export function namedSourceFile(calls: readonly { args: Record<string, unknown> }[]): string | undefined {
  return namedFiles(calls).find((path) => /\.(java|ts)$/u.test(path));
}

/** Declares the trust mode of `repo` the way a user does, with the engine's own `init`, in the run-owned configuration. */
export function declareTrust(engine: string, repo: string, mode: "trusted" | "untrusted", cache: string, env: NodeJS.ProcessEnv): void {
  const run = spawnSync(process.execPath, [...engineCommand(engine), "init", "--trust", mode, "--cache", cache, repo], { cwd: engine, env, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`init --trust ${mode} ${repo}: status ${run.status} signal ${run.signal} ${run.error?.message ?? ""} stdout ${run.stdout.trim()} stderr ${run.stderr.trim()}`);
}

/** A directory only this account reads, as `--cache` requires. */
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
