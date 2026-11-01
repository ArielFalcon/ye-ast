import { test } from "node:test";
import assert from "node:assert/strict";
import { isSpringConfigFile, profileOfConfigFile, resourcesOfSource } from "./spring-config.ts";

test("a Spring config file is an application file of a module's main resources, at the root or under config/", () => {
  assert.equal(isSpringConfigFile("src/main/resources/application.yml"), true);
  assert.equal(isSpringConfigFile("orders/src/main/resources/config/application-prod.yaml"), true);
  assert.equal(isSpringConfigFile("orders/src/main/resources/application-dev.properties"), true);
  assert.equal(isSpringConfigFile("src/test/resources/application.yml"), false);
  assert.equal(isSpringConfigFile("src/main/resources/bootstrap.yml"), false);
  assert.equal(isSpringConfigFile("src/main/resources/db/application.yml"), false);
  assert.equal(isSpringConfigFile("src/main/resources/application.xml"), true);
  assert.equal(isSpringConfigFile("src/main/resources/application.json"), false);
});

test("a profile file names its profile, and the plain file names none", () => {
  assert.equal(profileOfConfigFile("src/main/resources/application-prod-eu.yml"), "prod-eu");
  assert.equal(profileOfConfigFile("src/main/resources/config/application.properties"), undefined);
});

test("a source of a main source set belongs to the resources of its own module, and any other source to none", () => {
  assert.equal(resourcesOfSource("src/main/java/app/A.java"), "src/main/resources/");
  assert.equal(resourcesOfSource("services/orders/src/main/java/app/A.java"), "services/orders/src/main/resources/");
  assert.equal(resourcesOfSource("src/generated/java/app/A.java"), undefined);
  assert.equal(resourcesOfSource("app/A.java"), undefined);
});
