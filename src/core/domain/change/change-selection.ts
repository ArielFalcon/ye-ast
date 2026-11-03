import type { FileChange } from "./diff-reader.ts";
import { pathSelection } from "../shared/scope.ts";
import { compareText } from "../shared/code-node.ts";

/**
 * The changed paths a `changed` request selects, and the globs that selected none. An empty change reports no unmatched
 * glob: nothing was selected because nothing changed, not because the request was wrong.
 */
export interface ChangeSelection {
  files: readonly FileChange[];
  unmatched: readonly string[];
}

/** The selection over the change: the changed paths the globs select, and the globs that select none of them. */
export function selectChange(files: readonly FileChange[], globs: readonly string[] | undefined, matches: (path: string, glob: string) => boolean): ChangeSelection {
  if (globs === undefined || globs.length === 0) return { files, unmatched: [] };
  const selected = pathSelection({ include: globs, exclude: [] }, matches);
  return {
    files: files.filter((file) => selected(file.path)),
    unmatched: files.length === 0 ? [] : [...new Set(globs)].filter((glob) => !files.some((file) => matches(file.path, glob))).sort(compareText),
  };
}
