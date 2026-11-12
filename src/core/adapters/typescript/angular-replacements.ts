import { posix } from "node:path";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { angularBuildContext } from "./angular-build-context.ts";

/** Source paths replaced by Angular or Nx build configuration; undefined when its scope or content is unreadable. */
export function replacedFiles(files: readonly SourceFile[]): ReadonlySet<string> | undefined {
  const replaced = new Set<string>();
  const context = angularBuildContext(files);
  if (context === undefined) return undefined;
  for (const { root, value } of context.documents) {
    const pending = [value];
    for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
      if (typeof value !== "object" || value === null) continue;
      for (const [key, nested] of Object.entries(value)) {
        if (key !== "fileReplacements") {
          pending.push(nested);
          continue;
        }
        if (!Array.isArray(nested)) return undefined;
        for (const entry of nested) {
          const source = (entry as { replace?: unknown } | null)?.replace;
          if (typeof source !== "string") return undefined;
          replaced.add(posix.join(root, source));
        }
      }
    }
  }
  return replaced;
}

