import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEntrypoints } from "./angular-build-context.ts";

const file = (path: string, value: unknown) => ({ path, content: JSON.stringify(value) });

test("build entrypoints include workspace-relative configuration overrides", () => {
  const files = [file("web/angular.json", { projects: { app: { root: "apps/app", architect: { build: { builder: "@angular/build:application", options: { browser: "apps/app/src/main.ts" }, configurations: { alternate: { browser: "apps/app/src/other.ts" } } } } } } })];
  assert.deepEqual([...buildEntrypoints(files)!].sort(), ["web/apps/app/src/main.ts", "web/apps/app/src/other.ts"]);
});

test("Nx roots and malformed or unsupported builds cannot invent entrypoints", () => {
  const project = { root: "apps/app", targets: { build: { executor: "@angular/build:application", options: { browser: "apps/app/src/main.ts" } } } };
  assert.deepEqual([...buildEntrypoints([file("nx.json", {}), file("apps/app/project.json", project)])!], ["apps/app/src/main.ts"]);
  assert.equal(buildEntrypoints([file("apps/app/project.json", { ...project, $schema: "../../node_modules/nx/schemas/project-schema.json" })]), undefined);
  assert.equal(buildEntrypoints([{ path: "angular.json", content: "{" }]), undefined);
  assert.equal(buildEntrypoints([file("nx.json", { targetDefaults: { build: { options: { browser: "apps/app/src/other.ts" } } } }), file("apps/app/project.json", project)]), undefined);
  assert.equal(buildEntrypoints([file("angular.json", { projects: { app: { root: "../outside", architect: { build: { builder: "@angular/build:application", options: { browser: "../outside/main.ts" } } } } } })]), undefined);
  assert.equal(buildEntrypoints([file("angular.json", { projects: { app: { root: "", architect: { build: { builder: "custom:build", options: { browser: "src/main.ts" } } } } } })]), undefined);
});

test("Nx defines require consensus across configurations and respect project boundaries", async () => {
  const { buildDefines } = await import("./url-define.ts");
  const files = [file("nx.json", {}), file("apps/app/project.json", { root: "apps/app", targets: { build: { executor: "@angular/build:application", options: { define: { URL: "'https://example.test'" } }, configurations: { prod: {} } } } })];
  assert.equal(buildDefines(files).valueOf("apps/app/src/api.ts", "URL"), "https://example.test");
  assert.equal(buildDefines(files).valueOf("apps/application/src/api.ts", "URL"), undefined);
  const disagree = [files[0]!, file("apps/app/project.json", { root: "apps/app", targets: { build: { executor: "@angular/build:application", options: { define: { URL: "'https://example.test'" } }, configurations: { prod: { define: { URL: "'https://other.test'" } } } } } })];
  assert.equal(buildDefines(disagree).valueOf("apps/app/src/api.ts", "URL"), undefined);
});
