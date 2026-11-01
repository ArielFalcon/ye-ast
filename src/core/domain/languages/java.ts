const TEST_SOURCE_SET = /(^|\/)src\/(test|testFixtures|[a-z][A-Za-z0-9]*Test)\//;
const MAIN_SOURCE_SET = /(^|\/)src\/main\//;
const TEST_CLASS = /(Test|Tests|IT)\.(java|kt|kts|groovy|scala)$/;

export function isJavaSource(path: string): boolean {
  return path.endsWith(".java");
}

/** A JVM source of a Gradle or Maven test source set, or named like a test class outside the main source set. */
export function isJvmTestFile(path: string): boolean {
  return TEST_SOURCE_SET.test(path) || (!MAIN_SOURCE_SET.test(path) && TEST_CLASS.test(path));
}
