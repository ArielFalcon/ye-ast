import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredJavaReleases, isJvmBuildFile, sourceGeneratorDeclaration } from "./jvm-build.ts";

function plugin(groupId: string, artifactId: string): string {
  return `<project>
  <build>
    <plugins>
      <plugin>
        <groupId>${groupId}</groupId>
        <artifactId>${artifactId}</artifactId>
      </plugin>
    </plugins>
  </build>
</project>`;
}

test("a Maven or Gradle build file is recognised by its name at any depth, and nothing named like one", () => {
  assert.equal(isJvmBuildFile("pom.xml"), true);
  assert.equal(isJvmBuildFile("services/orders/pom.xml"), true);
  assert.equal(isJvmBuildFile("build.gradle"), true);
  assert.equal(isJvmBuildFile("services/orders/build.gradle.kts"), true);
  assert.equal(isJvmBuildFile("gradle/libs.versions.toml"), true);
  assert.equal(isJvmBuildFile("services/orders/gradle/tools.versions.toml"), true);
  assert.equal(isJvmBuildFile("config/settings.toml"), false);
  assert.equal(isJvmBuildFile("services/orders/mypom.xml"), false);
  assert.equal(isJvmBuildFile("pom.xml.orig"), false);
  assert.equal(isJvmBuildFile("settings.gradle"), false);
  assert.equal(isJvmBuildFile("src/main/java/Build.gradle.java"), false);
});

test("a Maven build declares a source generator through the coordinates of an OpenAPI or Swagger plugin, at the line of its artifact", () => {
  assert.deepEqual(sourceGeneratorDeclaration("pom.xml", plugin("org.openapitools", "openapi-generator-maven-plugin")), { line: 6 });
  assert.deepEqual(sourceGeneratorDeclaration("pom.xml", plugin("io.swagger.codegen.v3", "swagger-codegen-maven-plugin")), { line: 6 });
  assert.deepEqual(sourceGeneratorDeclaration("pom.xml", plugin("io.swagger", "swagger-codegen-maven-plugin")), { line: 6 });
});

test("a Maven build that declares several generators is read at the first", () => {
  const content = `<project>
  <groupId>io.swagger</groupId>
  <artifactId>swagger-codegen-maven-plugin</artifactId>
  <groupId>org.openapitools</groupId>
  <artifactId>openapi-generator-maven-plugin</artifactId>
</project>`;

  assert.deepEqual(sourceGeneratorDeclaration("pom.xml", content), { line: 3 });
  assert.deepEqual(sourceGeneratorDeclaration("pom.xml", content.split("\n").toReversed().join("\n")), { line: 2 });
});

test("a Maven build that pairs the artifact with another group, or declares only a library of the same group, declares none", () => {
  assert.equal(sourceGeneratorDeclaration("pom.xml", plugin("org.apache.maven.plugins", "openapi-generator-maven-plugin")), undefined);
  assert.equal(sourceGeneratorDeclaration("pom.xml", plugin("org.openapitools", "jackson-databind-nullable")), undefined);
  assert.equal(sourceGeneratorDeclaration("pom.xml", plugin("org.springframework.boot", "spring-boot-maven-plugin")), undefined);
});

test("every Gradle form of the OpenAPI generator plugin id declares a source generator, in either DSL", () => {
  assert.deepEqual(sourceGeneratorDeclaration("build.gradle.kts", `plugins {\n  java\n  id("org.openapi.generator") version "7.4.0"\n}`), { line: 3 });
  assert.deepEqual(sourceGeneratorDeclaration("build.gradle", `plugins {\n  id 'org.openapi.generator' version '7.4.0'\n}`), { line: 2 });
  assert.deepEqual(sourceGeneratorDeclaration("build.gradle", `apply plugin: 'org.openapi.generator'`), { line: 1 });
  assert.deepEqual(sourceGeneratorDeclaration("build.gradle.kts", `apply(plugin = "org.openapi.generator")`), { line: 1 });
});

test("a Gradle version catalog or the Swagger generator plugin declares a source generator", () => {
  assert.deepEqual(sourceGeneratorDeclaration("gradle/libs.versions.toml", `[plugins]\nspring-boot = { id = "org.springframework.boot", version = "3.5.0" }\nopenapi = { id = "org.openapi.generator", version = "7.4.0" }`), { line: 3 });
  assert.deepEqual(sourceGeneratorDeclaration("build.gradle", `plugins {\n  id 'org.hidetake.swagger.generator' version '2.19.2'\n}`), { line: 2 });
});

test("a Gradle build that names another plugin, or only the generator's artifact, declares none", () => {
  assert.equal(sourceGeneratorDeclaration("build.gradle.kts", `plugins { id("org.openapi.generator.extra") }`), undefined);
  assert.equal(sourceGeneratorDeclaration("build.gradle", `dependencies { classpath 'org.openapitools:openapi-generator-gradle-plugin:7.4.0' }`), undefined);
  assert.equal(sourceGeneratorDeclaration("build.gradle.kts", `plugins { id("org.springframework.boot") }`), undefined);
});

test("a build file is read only by the rules of its own kind", () => {
  assert.equal(sourceGeneratorDeclaration("build.gradle", plugin("org.openapitools", "openapi-generator-maven-plugin")), undefined);
  assert.equal(sourceGeneratorDeclaration("pom.xml", `id("org.openapi.generator")`), undefined);
});

test("a declaration inside a comment counts: a false positive only adds unknown items, a missed one would hide routes", () => {
  assert.deepEqual(sourceGeneratorDeclaration("build.gradle", `// apply plugin: 'org.openapi.generator'`), { line: 1 });
  assert.deepEqual(
    sourceGeneratorDeclaration("pom.xml", `<!--\n<groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId>\n-->`),
    { line: 2 },
  );
});

test("the release literals of a build file are read, a reference or an expression is not, and another file states none", () => {
  const maven = `<project><properties><java.version>1.8</java.version><maven.compiler.release>21</maven.compiler.release>
    <maven.compiler.source>${"$"}{java.version}</maven.compiler.source></properties>
    <build><plugins><plugin><configuration><release> 17 </release></configuration></plugin></plugins></build></project>`;
  assert.deepEqual(declaredJavaReleases("svc/pom.xml", maven), [8, 21, 17]);
  const gradle = `sourceCompatibility = JavaVersion.VERSION_1_8\nsourceCompatibility = '11'\njava { toolchain { languageVersion = JavaLanguageVersion.of(17) } }\ntasks.withType(JavaCompile) { options.release.set(21) }\nsourceCompatibility = javaVersion`;
  assert.deepEqual(declaredJavaReleases("build.gradle", gradle), [8, 11, 17, 21]);
  assert.deepEqual(declaredJavaReleases("build.gradle.kts", "options.release = 25"), [25]);
  assert.deepEqual(declaredJavaReleases("gradle/libs.versions.toml", "java = '99'"), []);
  assert.deepEqual(declaredJavaReleases("src/App.java", "<release>99</release>"), []);
});
