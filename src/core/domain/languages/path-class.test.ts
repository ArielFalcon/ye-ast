import { test } from "node:test";
import assert from "node:assert/strict";
import { classOfPath } from "./path-class.ts";

test("a language no reader reads is an unrelated uncovered source, even in a test source set", () => {
  assert.deepEqual(classOfPath("src/test/tools/seed.py"), { kind: "uncovered-source", family: "unrelated" });
});

test("a JVM sibling of Java is a test, build configuration, or an uncovered JVM source", () => {
  assert.deepEqual(classOfPath("src/test/kotlin/app/OrdersTest.kt"), { kind: "test" });
  assert.deepEqual(classOfPath("build.gradle.kts"), { kind: "build-configuration" });
  assert.deepEqual(classOfPath("service/settings.gradle.kts"), { kind: "build-configuration" });
  assert.deepEqual(classOfPath("buildSrc/src/main/groovy/Conventions.groovy"), { kind: "build-configuration" });
  assert.deepEqual(classOfPath("mybuildSrc/Conventions.kt"), { kind: "uncovered-source", family: "jvm" });
  assert.deepEqual(classOfPath("scripts/release.main.kts"), { kind: "uncovered-source", family: "jvm" });
  assert.deepEqual(classOfPath("src/main/scala/app/Orders.scala"), { kind: "uncovered-source", family: "jvm" });
});

test("a source a pack reads keeps its language, even as build logic", () => {
  assert.deepEqual(classOfPath("buildSrc/src/main/java/Conventions.java"), { kind: "source", language: "java" });
  assert.deepEqual(classOfPath("src/app/orders.ts"), { kind: "source", language: "typescript" });
  assert.deepEqual(classOfPath("src/test/java/app/OrdersTest.java"), { kind: "test" });
  assert.deepEqual(classOfPath("src/app/orders.spec.ts"), { kind: "test" });
});

test("a build file in any DSL is build configuration, and anything else is other", () => {
  assert.deepEqual(classOfPath("pom.xml"), { kind: "build-configuration" });
  assert.deepEqual(classOfPath("settings.gradle"), { kind: "build-configuration" });
  assert.deepEqual(classOfPath("gradle/libs.versions.toml"), { kind: "build-configuration" });
  assert.deepEqual(classOfPath("README.md"), { kind: "other" });
});
