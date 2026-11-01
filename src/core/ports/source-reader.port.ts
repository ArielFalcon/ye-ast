import type { SourceFile } from "./entrypoint-extractor.port.ts";

export interface SourceReader {
  /** Reads the files at `paths`, relative to `root`, in the order given. A file that cannot be read rejects. */
  read(root: string, paths: readonly string[]): Promise<readonly SourceFile[]>;
}
