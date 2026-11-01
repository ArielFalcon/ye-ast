import { isJavaSource, isJvmTestFile } from "../languages/java.ts";
import { isTypeScriptSource, isTypeScriptTestFile } from "../languages/typescript.ts";
import { isUncoveredSource } from "../languages/uncovered.ts";

/**
 * `test`: a test, never a caller. `source`: a Java or TypeScript module the index describes. `uncovered`: code in a
 * language ye-ast declares no extractor for. `other`: anything else, which holds no code the walk could miss.
 */
export type ChangedFileKind = "test" | "source" | "uncovered" | "other";

export function kindOfChangedFile(path: string): ChangedFileKind {
  if (isJvmTestFile(path) || isTypeScriptTestFile(path)) return "test";
  if (isJavaSource(path) || isTypeScriptSource(path)) return "source";
  if (isUncoveredSource(path)) return "uncovered";
  return "other";
}
