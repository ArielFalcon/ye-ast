import { INDEX_STORE_DIRECTORY } from "./code-graph.port.ts";
import { FIXED_LAYER_DIRECTORY } from "./fixed-layer-store.port.ts";

const ENGINE_ENTRIES: ReadonlySet<string> = new Set([".git", ".codegraph", FIXED_LAYER_DIRECTORY, INDEX_STORE_DIRECTORY]);
const ENGINE_CONFIG = "codegraph.json";
const IGNORE_FILE = ".gitignore";

/** True when a segment of the repository-relative `path` is an engine entry: never staged, mirrored or listed. */
export function isEngineEntry(path: string): boolean {
  return path.split("/").some((segment) => ENGINE_ENTRIES.has(segment));
}

/** True for a file that would configure the engine: any `.gitignore` and the root `codegraph.json`, in any case. */
export function isEngineConfiguration(path: string): boolean {
  return path.split("/").at(-1) === IGNORE_FILE || path.toLowerCase() === ENGINE_CONFIG;
}
