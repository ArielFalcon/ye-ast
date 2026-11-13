import { isJvmTestFile } from "./java.ts";
import { isJvmBuildFile } from "./jvm-build.ts";
import { LANGUAGE_PROFILES, type LanguageProfile } from "./profiles.ts";
import { isTypeScriptTestFile } from "./typescript.ts";

const JVM_SOURCE_WITHOUT_READER = /\.(kt|kts|groovy|scala)$/;
const GRADLE_BUILD_SCRIPT = /\.gradle(\.kts)?$/;
const GRADLE_BUILD_LOGIC = /(^|\/)buildSrc\//;
const LANGUAGE_WITHOUT_READER = /\.(js|jsx|mjs|cjs|py|go|rs|rb|php|cs|c|h|cc|cpp|hpp|swift|dart|vue|svelte)$/;

/**
 * The one class of a snapshot's path (ADR-0072 decision 1). `source`: a pack reads it. `uncovered-source`: no reader
 * reads it; `jvm` when it shares the type system of a read language, so its types may take part in that language's
 * proofs, `unrelated` otherwise. `build-configuration`: it configures a build and declares no type of the program,
 * whatever language it is written in. `test`: a test of the program. `other`: anything else.
 */
export type PathClass =
  | { kind: "source"; language: LanguageProfile["language"] }
  | { kind: "uncovered-source"; family: "jvm" | "unrelated" }
  | { kind: "build-configuration" }
  | { kind: "test" }
  | { kind: "other" };

/**
 * A language no reader reads is uncovered wherever it sits, tests included. A JVM sibling of Java is a test in a test
 * source set and build configuration as a Gradle script or under `buildSrc`. A source a pack reads outside the tests
 * keeps its language, so a Java file of build logic stays one.
 */
export function classOfPath(path: string): PathClass {
  if (LANGUAGE_WITHOUT_READER.test(path)) return { kind: "uncovered-source", family: "unrelated" };
  if (JVM_SOURCE_WITHOUT_READER.test(path)) return isJvmTestFile(path) ? { kind: "test" } : isBuildConfiguration(path) ? { kind: "build-configuration" } : { kind: "uncovered-source", family: "jvm" };
  if (isJvmTestFile(path) || isTypeScriptTestFile(path)) return { kind: "test" };
  const language = LANGUAGE_PROFILES.find((profile) => profile.reads(path))?.language;
  if (language !== undefined) return { kind: "source", language };
  return isBuildConfiguration(path) ? { kind: "build-configuration" } : { kind: "other" };
}

/** A JVM source no reader reads, whose classes may extend or implement any type of the Java sources. */
export function isUncoveredJvmSource(path: string): boolean {
  const pathClass = classOfPath(path);
  return pathClass.kind === "uncovered-source" && pathClass.family === "jvm";
}

function isBuildConfiguration(path: string): boolean {
  return isJvmBuildFile(path) || GRADLE_BUILD_SCRIPT.test(path) || GRADLE_BUILD_LOGIC.test(path);
}
