import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { AnswerFiles, AnswerFolder } from "../core/ports/answer-files.port.ts";

/** Answer files that keep their folders in memory: the first answer of a key stays, as in the file adapter. */
export function memoryAnswerFiles(): { files: AnswerFiles; folders: Map<string, AnswerFolder["files"]> } {
  const keys = new Map<string, string>();
  const folders = new Map<string, AnswerFolder["files"]>();
  const files: AnswerFiles = {
    keep: async ({ tool, inputs, files: written }) => {
      const key = canonicalJson({ tool, inputs });
      if (!keys.has(key)) {
        const folder = `/answers/${tool}/${keys.size}`;
        keys.set(key, folder);
        folders.set(folder, written);
      }
      return keys.get(key)!;
    },
  };
  return { files, folders };
}
