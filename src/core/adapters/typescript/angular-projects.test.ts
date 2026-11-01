import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { angularProjects, projectOf } from "./angular-projects.ts";

const manifest = (path: string, dependencies: Record<string, string>): SourceFile => ({ path, content: JSON.stringify({ dependencies }) });
const ANGULAR = { "@angular/core": "21.0.0" };

test("a project is the directory of each package.json that names @angular/core or @angular/router, outside node_modules", () => {
  const projects = angularProjects([
    manifest("package.json", { "@angular/router": "21.0.0" }),
    manifest("frontend/package.json", ANGULAR),
    manifest("tools/package.json", { lodash: "4.0.0" }),
    manifest("frontend/node_modules/@angular/core/package.json", ANGULAR),
    { path: "broken/package.json", content: "{" },
  ]);
  assert.deepEqual(projects.map((project) => project.directory).sort(), ["", "frontend"]);
  assert.equal(projects.find((project) => project.directory === "")?.dependencies.has("@angular/router"), true);
});

test("a file belongs to the nearest project above it, and a look-alike directory name is no ancestor", () => {
  const projects = angularProjects([manifest("package.json", ANGULAR), manifest("frontend/package.json", ANGULAR), manifest("frontend/libs/x/package.json", { lodash: "4.0.0" })]);
  const at = (path: string): string | undefined => projectOf(path, projects)?.directory;
  assert.equal(at("frontend/libs/x/a.ts"), "frontend");
  assert.equal(at("frontend/src/a.ts"), "frontend");
  assert.equal(at("frontend2/a.ts"), "");
  assert.equal(at("a.ts"), "");
  assert.equal(projectOf("backend/a.ts", angularProjects([manifest("frontend/package.json", ANGULAR)])), undefined);
});
