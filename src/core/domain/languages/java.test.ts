import { test } from "node:test";
import assert from "node:assert/strict";
import { isJavaSource, isJvmTestFile } from "./java.ts";

test("a file in a test source set is a test file, whatever its name", () => {
  assert.equal(isJvmTestFile("src/test/java/app/OrderController.java"), true);
  assert.equal(isJvmTestFile("service/src/test/resources/Fixture.java"), true);
  assert.equal(isJvmTestFile("src/integrationTest/java/app/OrderController.java"), true);
  assert.equal(isJvmTestFile("src/functionalTest/kotlin/app/Orders.kt"), true);
  assert.equal(isJvmTestFile("src/testFixtures/java/app/OrderFixture.java"), true);
  assert.equal(isJvmTestFile("mysrc/test/Order.java"), false);
  assert.equal(isJvmTestFile("src/contest/java/app/Order.java"), false);
});

test("a class named like a test is a test file outside the main source set, never inside it", () => {
  assert.equal(isJvmTestFile("app/OrderControllerTest.java"), true);
  assert.equal(isJvmTestFile("app/OrderTests.groovy"), true);
  assert.equal(isJvmTestFile("app/OrderIT.kt"), true);
  assert.equal(isJvmTestFile("src/main/java/app/AbTest.java"), false);
  assert.equal(isJvmTestFile("src/main/kotlin/app/HealthIT.kt"), false);
  assert.equal(isJvmTestFile("app/Latest.java"), false);
  assert.equal(isJvmTestFile("app/TestSupport.java"), false);
});

test("only .java files are Java sources", () => {
  assert.equal(isJavaSource("src/main/java/App.java"), true);
  assert.equal(isJavaSource("src/main/resources/application.yml"), false);
  assert.equal(isJavaSource("src/main/java/App.java.orig"), false);
});
