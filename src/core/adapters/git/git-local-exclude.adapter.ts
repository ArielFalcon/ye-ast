import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import type { LocalExclude, LocalExcludeFault } from "../../ports/local-exclude.port.ts";
import { defaultGitDeps, type GitDeps } from "./git-vcs.adapter.ts";

export interface LocalExcludeDeps {
  git: Pick<GitDeps, "runGit">;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  appendFile: (path: string, content: string) => Promise<void>;
  lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
  realpath: (path: string) => Promise<string>;
}

export const defaultLocalExcludeDeps: LocalExcludeDeps = { git: defaultGitDeps, readFile, mkdir, appendFile, lstat, realpath };

export function createGitLocalExclude(deps: LocalExcludeDeps = defaultLocalExcludeDeps): LocalExclude {
  return {
    async ensure(repo, lines) {
      const located = await deps.git.runGit(repo, ["rev-parse", "--git-path", "info/exclude", "--git-common-dir"]);
      if (located.code !== 0) return fault("git-failed", located.stderr);
      const [excludePath, commonPath] = located.stdout.toString("utf8").trim().split("\n");
      if (excludePath === undefined || commonPath === undefined) return fault("git-failed", "git named no exclude file");
      const file = resolve(repo, excludePath);

      let content = "";
      try {
        await deps.mkdir(dirname(file), { recursive: true });
        const confined = isInside(await deps.realpath(resolve(repo, commonPath)), await deps.realpath(dirname(file)));
        if (!confined) return fault("refused", `${file} lies outside git's common directory`);
        content = await readHeld(file, deps);
      } catch (error) {
        if (error instanceof SymbolicLinkError) return fault("refused", `${file} is a symbolic link`);
        return fault("unreadable", errorDetail(error));
      }
      const held = new Set(content.split("\n").map((line) => line.replace(/\r$/, "")));
      const absent = lines.filter((line) => !held.has(line));
      if (absent.length === 0) return { ok: true, value: [] };

      try {
        const separator = content === "" || content.endsWith("\n") ? "" : "\n";
        await deps.appendFile(file, `${separator}${absent.join("\n")}\n`);
      } catch (error) {
        return fault("unwritable", errorDetail(error));
      }
      return { ok: true, value: absent };
    },
  };
}

class SymbolicLinkError extends Error {}

async function readHeld(file: string, deps: LocalExcludeDeps): Promise<string> {
  try {
    if ((await deps.lstat(file)).isSymbolicLink()) throw new SymbolicLinkError();
    return await deps.readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}

function isInside(directory: string, path: string): boolean {
  const from = relative(directory, path);
  return from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from);
}

function fault(kind: LocalExcludeFault["kind"], detail: string): Result<never, LocalExcludeFault> {
  return { ok: false, fault: { kind, detail } };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
