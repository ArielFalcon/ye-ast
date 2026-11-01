import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceReader } from "../../ports/source-reader.port.ts";

/** Reads one file at a time and decodes leniently: a byte that is not UTF-8 becomes U+FFFD, the file is still read. */
export function createFsSourceReader(): SourceReader {
  return {
    async read(root, paths) {
      const files: SourceFile[] = [];
      for (const path of paths) files.push({ path, content: (await readFile(join(root, path))).toString("utf8") });
      return files;
    },
  };
}
