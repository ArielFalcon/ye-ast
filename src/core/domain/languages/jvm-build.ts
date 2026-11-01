const BUILD_FILE = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|[^/]+\.versions\.toml)$/;
const MAVEN_BUILD_FILE = /(^|\/)pom\.xml$/;
const MAVEN_COORDINATE = /<(groupId|artifactId)\s*>([^<]*)<\/\1>/g;
const GRADLE_GENERATOR_ID = /["'](org\.openapi\.generator|org\.hidetake\.swagger\.generator)["']/;

/** Plugins that generate Java sources from an OpenAPI or Swagger contract, by Maven coordinates. */
const MAVEN_GENERATORS: readonly { groupId: string; artifactId: string }[] = [
  { groupId: "org.openapitools", artifactId: "openapi-generator-maven-plugin" },
  { groupId: "io.swagger.codegen.v3", artifactId: "swagger-codegen-maven-plugin" },
  { groupId: "io.swagger", artifactId: "swagger-codegen-maven-plugin" },
];

export function isJvmBuildFile(path: string): boolean {
  return BUILD_FILE.test(path);
}

/**
 * The line where a build file names a source generator: the coordinates of a Maven plugin, or a Gradle plugin id
 * (`org.openapi.generator`, `org.hidetake.swagger.generator`) in a build script or a version catalog, where a plugin
 * applied through `alias(...)` is declared. Nothing is executed or resolved: a coordinate given by a property is not
 * recognised, and a match inside a comment counts, since a false positive only adds unknown
 * items while a missed generator would hide routes.
 */
export function sourceGeneratorDeclaration(path: string, content: string): { line: number } | undefined {
  const index = MAVEN_BUILD_FILE.test(path) ? mavenGeneratorIndex(content) : GRADLE_GENERATOR_ID.exec(content)?.index;
  return index === undefined ? undefined : { line: lineAt(content, index) };
}

function mavenGeneratorIndex(content: string): number | undefined {
  const groupIds = new Set<string>();
  const artifactIds = new Map<string, number>();
  for (const match of content.matchAll(MAVEN_COORDINATE)) {
    const value = (match[2] ?? "").trim();
    if (match[1] === "groupId") groupIds.add(value);
    else if (!artifactIds.has(value)) artifactIds.set(value, match.index);
  }
  const found = MAVEN_GENERATORS.flatMap(({ groupId, artifactId }) => (groupIds.has(groupId) ? [artifactIds.get(artifactId)] : []));
  const indexes = found.filter((index) => index !== undefined);
  return indexes.length === 0 ? undefined : Math.min(...indexes);
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let at = content.indexOf("\n"); at !== -1 && at < index; at = content.indexOf("\n", at + 1)) line++;
  return line;
}
