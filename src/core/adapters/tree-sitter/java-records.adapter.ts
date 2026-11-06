import { isJavaSource } from "../../domain/languages/java.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { UnmodelledConstructsReader } from "../../ports/unmodelled-constructs.port.ts";
import type { JavaParser } from "./java-parser.adapter.ts";

/** The Java sources that declare a `record` at any depth, read with ye-ast's own grammar. */
export function createJavaRecordsReader(parser: JavaParser): UnmodelledConstructsReader {
  return {
    async extract(sources) {
      const files: string[] = [];
      for (const source of sources) {
        if (!isJavaSource(source.path)) continue;
        const parsed = parser.parse(source.content);
        if (!parsed.ok) continue;
        try {
          if (parsed.value.root.descendantsOfType("record_declaration").length > 0) files.push(source.path);
        } finally {
          parsed.value.dispose();
        }
      }
      return files.sort(compareText);
    },
  };
}
