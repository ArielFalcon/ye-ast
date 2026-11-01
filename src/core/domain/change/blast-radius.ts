import { compareText } from "../shared/code-node.ts";
import type { FileChange } from "./diff-reader.ts";

/** The change between a merge base and a head: the files git reports, sorted by path. */
export interface BlastRadius {
  mergeBase: string;
  files: readonly FileChange[];
}

export function blastRadius(mergeBase: string, files: readonly FileChange[]): BlastRadius {
  return { mergeBase, files: files.toSorted((a, b) => compareText(a.path, b.path)) };
}
