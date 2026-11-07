import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { configurationOf } from "./application-config.ts";

const yaml = (content: string, path = "src/main/resources/application.yml"): SourceFile => ({ path, content });

test("the keys under a prefix are listed in their canonical spelling with their lines, by the key's segments and not by its text", () => {
  const { keys, undecided } = configurationOf([yaml("spring:\n  jackson:\n    Time_Zone: UTC\n    serialization:\n      indent-output: true\n  jacksonx: 1\nother: jackson\n")]).keysUnder("spring.jackson");
  assert.deepEqual(keys.map(({ key, evidence }) => `${key}@${evidence.line}`), ["spring.jackson.timezone@3", "spring.jackson.serialization.indentoutput@5"]);
  assert.deepEqual(undecided, []);
});

test("a condition that cannot place a document under one profile does not hide its keys", () => {
  const { keys, undecided } = configurationOf([yaml("spring:\n  config:\n    activate:\n      on-profile: dev\n  jackson:\n    locale: en\n", "src/main/resources/application-secret.yml")]).keysUnder("spring.jackson");
  assert.deepEqual(keys.map(({ key }) => key), ["spring.jackson.locale"]);
  assert.deepEqual(undecided, []);
});

test("a file the keys cannot be read from is a place that may declare any key", () => {
  const { undecided } = configurationOf([yaml("spring:\n  config:\n    import: optional:file:extra.yml\n"), yaml("a: [", "src/main/resources/config/application-dev.yml")]).keysUnder("spring.jackson");
  assert.deepEqual(undecided.map(({ path }) => path), ["src/main/resources/application.yml", "src/main/resources/config/application-dev.yml"]);
});

test("an alias or a merge key on the way to a prefix, or below it, leaves its keys undecided at that place", () => {
  const alias = "defaults: &settings\n  jackson:\n    default-property-inclusion: non_null\nspring: *settings\n";
  const merge = "defaults: &defaults\n  jackson:\n    default-property-inclusion: non_null\nspring:\n  <<: *defaults\n";
  const below = "shared: &shared\n  indent-output: true\nspring:\n  jackson:\n    serialization: *shared\n";
  for (const [label, content] of [["alias", alias], ["merge", merge], ["below", below]] as const) {
    const { undecided } = configurationOf([yaml(content)]).keysUnder("spring.jackson");
    assert.equal(undecided.length, 1, label);
    assert.equal(undecided[0]?.path, "src/main/resources/application.yml", label);
  }
  assert.deepEqual(configurationOf([yaml("shared: &shared\n  a: 1\nother: *shared\nspring:\n  jackson:\n    locale: en\n")]).keysUnder("spring.jackson").undecided, []);
});

test("a key an alias may hold is undecided for valueOf, and one it cannot reach keeps its value", () => {
  const files = [yaml("base: &base\n  context-path: /api\nserver:\n  servlet: *base\nspring:\n  application:\n    name: app\n")];
  assert.deepEqual(configurationOf(files).valueOf("server.servlet.context-path"), { status: "undecided" });
  assert.deepEqual(configurationOf(files).valueOf("spring.application.name"), { status: "found", value: "app" });
});
