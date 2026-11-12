import { test } from "node:test";
import assert from "node:assert/strict";
import { isAngularTemplate, isAngularWorkspace, nxConfigurationOf, isJsonModuleResource, isModuleConfigFile, isPackageManifest, isTypeScriptSource } from "./typescript.ts";

test("a TypeScript source is a .ts, .mts or .cts file that is neither a declaration file nor a test nor generated output", () => {
  assert.equal(isTypeScriptSource("src/app/app.routes.ts"), true);
  assert.equal(isTypeScriptSource("src/app/app.routes.mts"), true);
  assert.equal(isTypeScriptSource("src/app/app.routes.cts"), true);
  assert.equal(isTypeScriptSource("src/app/app.routes.js"), false);
  assert.equal(isTypeScriptSource("src/app/app.routes.ts.orig"), false);
  assert.equal(isTypeScriptSource("src/types/global.d.ts"), false);
  assert.equal(isTypeScriptSource("src/types/global.d.mts"), false);
});

test("a spec or test file, and anything under a test directory, is not a TypeScript source", () => {
  assert.equal(isTypeScriptSource("src/app/app.routes.spec.ts"), false);
  assert.equal(isTypeScriptSource("src/app/app.routes.test.ts"), false);
  assert.equal(isTypeScriptSource("src/app/__tests__/routes.ts"), false);
  assert.equal(isTypeScriptSource("e2e/src/app.e2e-spec.ts"), false);
  assert.equal(isTypeScriptSource("cypress/e2e/orders.cy.ts"), false);
  assert.equal(isTypeScriptSource("src/app/openapi-spec.ts"), true);
  assert.equal(isTypeScriptSource("src/app/policy.ts"), true);
  assert.equal(isTypeScriptSource("src/app/specs.ts"), true);
  assert.equal(isTypeScriptSource("src/app/latest.ts"), true);
});

test("a file under node_modules is not a TypeScript source, whatever its depth; a folder named like build output is", () => {
  assert.equal(isTypeScriptSource("node_modules/routes.ts"), false);
  assert.equal(isTypeScriptSource("apps/web/node_modules/pkg/routes.ts"), false);
  for (const directory of ["dist", "build", "coverage", "out", "tmp", "vendor"]) assert.equal(isTypeScriptSource(`src/app/${directory}/routes.ts`), true, directory);
  assert.equal(isTypeScriptSource("src/my_node_modules/routes.ts"), true);
});

test("a package.json at any depth, outside node_modules, may name the framework of a project", () => {
  assert.equal(isPackageManifest("package.json"), true);
  assert.equal(isPackageManifest("apps/web/package.json"), true);
  assert.equal(isPackageManifest("xpackage.json"), false);
  assert.equal(isPackageManifest("apps/web/package.json.bak"), false);
  assert.equal(isPackageManifest("node_modules/pkg/package.json"), false);
  assert.equal(isPackageManifest("apps/web/node_modules/pkg/package.json"), false);
});

test("a tsconfig or jsconfig file, with any suffix, at any depth configures module resolution", () => {
  assert.equal(isModuleConfigFile("tsconfig.json"), true);
  assert.equal(isModuleConfigFile("apps/web/tsconfig.app.json"), true);
  assert.equal(isModuleConfigFile("tsconfig.base.json"), true);
  assert.equal(isModuleConfigFile("jsconfig.json"), true);
  assert.equal(isModuleConfigFile("my-tsconfig.json"), false);
  assert.equal(isModuleConfigFile("tsconfig.json.bak"), false);
  assert.equal(isModuleConfigFile("node_modules/pkg/tsconfig.json"), false);
});

test("an Angular template is an .html or .htm file outside node_modules", () => {
  assert.equal(isAngularTemplate("src/app/page.component.html"), true);
  assert.equal(isAngularTemplate("src/app/page.htm"), true);
  assert.equal(isAngularTemplate("src/app/page.html.orig"), false);
  assert.equal(isAngularTemplate("src/app/page.xhtml"), false);
  assert.equal(isAngularTemplate("node_modules/pkg/page.html"), false);
});

test("JSON module resources exclude installed packages and resolver configuration", async () => {
  const { isJsonModuleResource } = await import("./typescript.ts");
  assert.equal(isJsonModuleResource("src/data.json"), true);
  for (const path of ["package.json", "src/tsconfig.app.json", "node_modules/pkg/data.json", "src/data.json.bak"]) assert.equal(isJsonModuleResource(path), false, path);
});

test("an angular.json at any depth, outside node_modules, is an Angular workspace that stays a JSON module resource", () => {
  assert.equal(isAngularWorkspace("angular.json"), true);
  assert.equal(isAngularWorkspace("apps/web/angular.json"), true);
  assert.equal(isAngularWorkspace("my-angular.json"), false);
  assert.equal(isAngularWorkspace("node_modules/pkg/angular.json"), false);
  assert.equal(isJsonModuleResource("angular.json"), true);
});

test("Nx configuration kinds are exact filenames outside installed packages", () => {
  assert.equal(nxConfigurationOf("nested/nx.json"), "workspace");
  assert.equal(nxConfigurationOf("apps/site/project.json"), "project");
  for (const path of ["node_modules/pkg/project.json", "node_modules/nx.json", "project.json.bak", "other-project.json"]) assert.equal(nxConfigurationOf(path), undefined);
});
