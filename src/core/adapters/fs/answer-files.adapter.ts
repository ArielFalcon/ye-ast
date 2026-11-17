import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { privateToOwner } from "../../domain/shared/private-to-owner.ts";
import { usageDiscards } from "../../domain/snapshot/live-retention.ts";
import { ANSWER_FILE_NAMES, type AnswerFiles, type AnswerFolder, type AnswerRetentionPolicy } from "../../ports/answer-files.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import { DEBRIS_STALE_MS } from "../../ports/live-mirror.port.ts";

export interface AnswerFilesDeps {
  /** ye-ast's per-user cache directory; the folders live under its `answers/`. */
  directory: string;
  digest: Digest;
  /** The identity of the engine build, part of every key. */
  engine: string;
  /** Without it nothing is removed. */
  retention?: AnswerRetentionPolicy;
  /** Receives each diagnostic line. */
  report: (line: string) => void;
  now?: () => number;
}

const ANSWERS = "answers";
const BUILD_PREFIX = ".build-";
const PRIVATE = 0o700;
const OWNER_ONLY_FILE = 0o600;
const MAIN_FILE = "answer.json";

export function createAnswerFiles(deps: AnswerFilesDeps): AnswerFiles {
  const root = join(deps.directory, ANSWERS);
  const now = deps.now ?? Date.now;

  async function requirePrivate(directory: string): Promise<void> {
    const ownerUid = process.getuid?.();
    if (ownerUid === undefined) return;
    const status = await lstat(directory);
    const refusal = privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, ownerUid);
    if (refusal !== null) throw new Error(`${directory} ${refusal}`);
  }

  /** Renames a folder built beside it into place; a folder it replaces is first moved aside under a build name, so a killed swap leaves only debris the sweep removes. */
  async function publish(parent: string, folder: string, files: AnswerFolder["files"], replacing: boolean): Promise<void> {
    const building = await mkdtemp(join(parent, BUILD_PREFIX));
    const retired = replacing ? await mkdtemp(join(parent, BUILD_PREFIX)) : null;
    let published = false;
    try {
      for (const name of ANSWER_FILE_NAMES) await writeFile(join(building, name), files[name], { mode: OWNER_ONLY_FILE });
      if (retired !== null) await rename(folder, join(retired, "replaced")).catch(() => undefined);
      try {
        await rename(building, folder);
        published = true;
      } catch (error) {
        if (!(await stat(folder).then(() => true, () => false))) throw error;
      }
    } finally {
      if (!published) await rm(building, { recursive: true, force: true });
      if (retired !== null) await rm(retired, { recursive: true, force: true });
    }
  }

  async function measure(folder: string): Promise<{ bytes: number; lastUsedMs: number | null }> {
    let bytes = 0;
    for (const name of await readdir(folder)) bytes += (await lstat(join(folder, name)).catch(() => null))?.size ?? 0;
    return { bytes, lastUsedMs: await stat(join(folder, MAIN_FILE)).then((status) => status.mtimeMs, () => null) };
  }

  /** Removes the folders the policy names and the build directories a killed write left, once per answer; it never fails the answer it follows. */
  async function sweep(current: string): Promise<void> {
    if (deps.retention === undefined) return;
    try {
      const usage = new Map<string, { bytes: number; lastUsedMs: number | null }>();
      for (const tool of await readdir(root, { withFileTypes: true })) {
        if (!tool.isDirectory()) continue;
        for (const item of await readdir(join(root, tool.name), { withFileTypes: true })) {
          if (!item.isDirectory()) continue;
          const path = join(tool.name, item.name);
          if (!item.name.startsWith(".")) usage.set(path, await measure(join(root, path)));
          else if (item.name.startsWith(BUILD_PREFIX) && now() - (await lstat(join(root, path))).mtimeMs > DEBRIS_STALE_MS) await rm(join(root, path), { recursive: true, force: true });
        }
      }
      for (const scope of usageDiscards(usage, current, deps.retention, now())) await rm(join(root, scope), { recursive: true, force: true });
    } catch {
      return;
    }
  }

  async function keep({ tool, inputs, files }: AnswerFolder): Promise<string | null> {
    try {
      const parent = join(root, tool);
      await mkdir(root, { recursive: true, mode: PRIVATE });
      for (const directory of [deps.directory, root]) await requirePrivate(directory);
      await mkdir(parent, { recursive: true, mode: PRIVATE });
      await requirePrivate(parent);
      const key = deps.digest.of(canonicalJson({ engine: deps.engine, tool, inputs }));
      const folder = join(parent, key);
      const kept = await readFile(join(folder, MAIN_FILE), "utf8").catch(() => undefined);
      if (kept === files[MAIN_FILE]) {
        const used = new Date(now());
        await utimes(join(folder, MAIN_FILE), used, used).catch(() => undefined);
      } else {
        if (kept !== undefined) deps.report(`ye-ast: answer files: ${folder} held other bytes for the same key; replaced by the new ${tool} answer`);
        await publish(parent, folder, files, kept !== undefined);
      }
      await sweep(join(tool, key));
      return folder;
    } catch (error) {
      deps.report(`ye-ast: answer files not written: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return { keep };
}
