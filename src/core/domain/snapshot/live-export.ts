import { isJsonModuleResource } from "../languages/typescript.ts";
import type { DeclaredScope, ExportSkipReason } from "../shared/fact.ts";
import { declaredScope, isInMapScope } from "../map/entrypoint-map.ts";
import type { ScopeRequest } from "../shared/scope.ts";
import { compareText } from "../shared/code-node.ts";

interface Blob {
  path: string;
  blob: string;
}

/**
 * The export of a live tree, shaped like a commit's: every mirrored file, whose `written` says what an export would
 * have written, and every skipped entry. `contentFingerprint` and the extraction read it unchanged.
 */
export function liveExport<S extends { path: string; reason: ExportSkipReason }>(manifest: readonly Blob[], skipped: readonly S[]): { files: { path: string; blob: string; written: boolean }[]; skipped: S[] } {
  return { files: manifest.map(({ path, blob }) => ({ path, blob, written: isWritten(path) })), skipped: [...skipped] };
}

/**
 * Whether an export writes this path, which is also the universe of the store a live answer reads. One rule, two
 * consumers: the export marks it `written`, and the mirror copies exactly those paths and no others.
 */
export function isWritten(path: string): boolean {
  return isInMapScope(path) || isJsonModuleResource(path);
}

/** Changes with any change to `isWritten`, so a mirror built under another universe is never reused. */
export const WRITTEN_UNIVERSE_VERSION = "json-resources-v1";

/** The paths whose blob differs between two listings, or that only one of them holds, sorted. */
export function changedPaths(base: readonly Blob[], live: readonly Blob[]): string[] {
  const before = new Map(base.map((file) => [file.path, file.blob]));
  const after = new Map(live.map((file) => [file.path, file.blob]));
  const changed = new Set<string>();
  for (const [path, blob] of after) if (before.get(path) !== blob) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort(compareText);
}

/** The declared scope of a fact over a working tree: git's ignore rules decide what is listed. */
export function liveScope(request?: ScopeRequest): DeclaredScope {
  return { ...declaredScope(request), ignored: "git" };
}
