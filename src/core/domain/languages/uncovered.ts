import { isJvmTestFile } from "./java.ts";

const UNSUPPORTED_JVM_SOURCE = /\.(kt|kts|groovy|scala)$/;
const GRADLE_BUILD_SCRIPT = /\.gradle\.kts$/;
const GRADLE_BUILD_LOGIC = /(^|\/)buildSrc\//;
const UNCOVERED_LANGUAGE = /\.(js|jsx|mjs|cjs|py|go|rs|rb|php|cs|c|h|cc|cpp|hpp|swift|dart|vue|svelte)$/;

/**
 * Code in a language ye-ast declares no extractor for, so it may hold what an answer cannot read. Gradle build scripts,
 * `buildSrc` and JVM tests declare no entrypoints and are not callers.
 */
export function isUncoveredSource(path: string): boolean {
  if (UNSUPPORTED_JVM_SOURCE.test(path)) return !GRADLE_BUILD_SCRIPT.test(path) && !GRADLE_BUILD_LOGIC.test(path) && !isJvmTestFile(path);
  return UNCOVERED_LANGUAGE.test(path);
}
