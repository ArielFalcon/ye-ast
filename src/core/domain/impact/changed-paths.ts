import { kindOfChangedFile } from "../change/changed-file.ts";
import type { FileChange } from "../change/diff-reader.ts";

/**
 * What the answer did with a changed path. `walked`: its declarations, resources or modules started the walk. `settled`:
 * every hunk changed no token. `test`: a test, never a dependent, so no walk started from it. `outside-scope`: code in a
 * language no extractor reads. `not-read`: nothing a walk could start from (documentation, data, a deleted file that
 * declared no name).
 */
export type ChangedPathDisposition = "walked" | "settled" | "test" | "outside-scope" | "not-read";

export interface ChangedPath {
  path: string;
  disposition: ChangedPathDisposition;
  /** Present when the change deleted the file. */
  deleted?: true;
  /** The names the removed lines of a walked path declared and no added line declares again, without duplicates. */
  removed?: readonly string[];
}

/**
 * The change an impact answer read, one row per changed path, in the path order `blastRadius` gives `files`. `retained` is `files` after the hunks that
 * changed no token were set aside, which is what the walk saw; `walked` says whether a path started a walk.
 */
export function changedPathsOf(files: readonly FileChange[], retained: readonly FileChange[], settled: readonly { file: string }[], walked: (file: FileChange) => boolean): ChangedPath[] {
  const kept = new Map(retained.map((file) => [file.path, file]));
  const settledHunks = Map.groupBy(settled, ({ file }) => file);
  return files.map((file): ChangedPath => {
    const deleted = file.deleted ? { deleted: true as const } : {};
    const seen = kept.get(file.path) ?? file;
    const kind = kindOfChangedFile(file.path);
    if (kind === "test") return { path: file.path, disposition: "test", ...deleted };
    if (kind === "uncovered") return { path: file.path, disposition: "outside-scope", ...deleted };
    if (!walked(seen)) return { path: file.path, disposition: "not-read", ...deleted };
    if (file.hunks.length > 0 && settledHunks.get(file.path)?.length === file.hunks.length) return { path: file.path, disposition: "settled", ...deleted };
    const removed = [...new Set(seen.removedNames)];
    return { path: file.path, disposition: "walked", ...deleted, ...(removed.length === 0 ? {} : { removed }) };
  });
}
