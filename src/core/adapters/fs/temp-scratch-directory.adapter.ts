import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";

export function createTempScratchDirectory(root: string = tmpdir()): ScratchDirectory {
  return {
    create: () => mkdtemp(join(root, "ye-ast-export-")),
    remove: (path) => rm(path, { recursive: true, force: true }),
  };
}
