import { constants } from "node:fs";
import { copyFile, link, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import { isEngineConfiguration, isEngineEntry } from "../../ports/staging-rules.ts";
import type { CodeGraphFault } from "../../ports/code-graph.port.ts";

/** Part of the key of a kept index: any change to how a snapshot is staged or indexed changes this value. */
export const STAGING_RULES_VERSION = "8";

class UnstageableEntry extends Error {
  constructor(readonly path: string) {
    super(`${path} is neither a regular file nor a directory`);
    this.name = "UnstageableEntry";
  }
}

export interface StagedSnapshot {
  /** The top-level entries created in the root. */
  entries: readonly string[];
  /** Every file placed, relative to the root with `/` separators. */
  files: readonly string[];
}

/**
 * Links the snapshot's files into `root`, copying across file systems, minus what would configure or seed the engine.
 * Names are compared in lower case, since the engine reads them through the host's file system.
 */
export async function stageSnapshot(snapshot: string, root: string): Promise<Result<StagedSnapshot, CodeGraphFault>> {
  const staged = new Set<string>();
  const files: string[] = [];
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(snapshot, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (isEngineEntry(entry.name.toLowerCase())) continue;
      if (entry.isDirectory()) {
        await mkdir(join(root, path));
        if (relative === "") staged.add(entry.name);
        await walk(path);
      } else if (entry.isFile()) {
        if (isEngineConfiguration(path.toLowerCase())) continue;
        await place(join(snapshot, path), join(root, path));
        files.push(path);
        if (relative === "") staged.add(entry.name);
      } else {
        throw new UnstageableEntry(path);
      }
    }
  }
  if (!isOutside(resolve(snapshot), root)) return stageFailed(`${root} is inside the snapshot ${snapshot}`);
  try {
    await mkdir(root, { recursive: true });
    if ((await readdir(root)).length > 0) return stageFailed(`${root} is not empty`);
    await walk("");
  } catch (error) {
    return stageFailed(error instanceof Error ? error.message : String(error));
  }
  return { ok: true, value: { entries: [...staged], files } };
}

export async function removeStaged(root: string, entries: readonly string[]): Promise<void> {
  await Promise.all(entries.map((name) => rm(join(root, name), { recursive: true, force: true })));
}

function isOutside(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path);
  return fromDirectory.startsWith("..") || isAbsolute(fromDirectory);
}

/** Never replaces a staged file: two names a case-insensitive store folds together fail the staging. */
async function place(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

function stageFailed(detail: string): Result<never, CodeGraphFault> {
  return { ok: false, fault: { kind: "stage-failed", detail } };
}
