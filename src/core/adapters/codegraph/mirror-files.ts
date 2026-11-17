import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import type { CodeGraph as SdkGraph } from "@colbymchenry/codegraph";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CodeGraphFault } from "../../ports/code-graph.port.ts";
import { isEngineEntry } from "../../ports/staging-rules.ts";

type Sdk = typeof import("@colbymchenry/codegraph");

export interface StoredFiles {
  filesNotIndexed: readonly string[];
  filesUnparsed: readonly string[];
  filesStored: number;
}

/** Every regular file of `root` outside the engine entries; any entry other than a regular file or a directory is `stage-failed`. */
export async function listMirror(root: string): Promise<Result<readonly string[], CodeGraphFault>> {
  const files: string[] = [];
  try {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name).slice(root.length + 1).split(sep).join("/");
      if (isEngineEntry(path)) continue;
      if (entry.isFile()) files.push(path);
      else if (!entry.isDirectory()) return { ok: false, fault: { kind: "stage-failed", detail: `${path} is neither a regular file nor a directory` } };
    }
  } catch (error) {
    return { ok: false, fault: { kind: "stage-failed", detail: error instanceof Error ? error.message : String(error) } };
  }
  return { ok: true, value: files };
}

export function unindexedFiles(sdk: Sdk, staged: readonly string[], indexed: readonly { path: string }[]): readonly string[] {
  const stored = new Set(indexed.map((file) => file.path));
  return staged.filter((path) => !stored.has(path) && sdk.isLanguageSupported(sdk.detectLanguage(path))).sort(compareText);
}

/** What the store holds of `files` after a sync of `synced`: the supported files it left out and the synced paths it does not parse. */
export function storedFiles(sdk: Sdk, graph: SdkGraph, files: readonly string[], synced: readonly string[]): StoredFiles {
  const indexed = graph.getFiles();
  const filesUnparsed = synced.filter((path) => !sdk.isLanguageSupported(sdk.detectLanguage(path))).sort(compareText);
  return { filesNotIndexed: unindexedFiles(sdk, files, indexed), filesUnparsed, filesStored: indexed.length };
}
