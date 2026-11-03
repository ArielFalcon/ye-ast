import { test } from "node:test";
import assert from "node:assert/strict";
import { exportSelection, isValidGlob, pathSelection, sortedGlobs } from "./scope.ts";

const prefixed = (path: string, glob: string): boolean => path.startsWith(glob);
const isConfiguration = (path: string): boolean => path.endsWith("package.json");

test("globs are sorted and each is kept once", () => {
  assert.deepEqual(sortedGlobs(["b", "a", "b"]), ["a", "b"]);
  assert.deepEqual(sortedGlobs(undefined), []);
});

test("an empty include selects every path", () => {
  assert.equal(pathSelection({ include: [], exclude: [] }, prefixed)("any/file.java"), true);
});

test("a non-empty include selects only the paths it matches", () => {
  const selected = pathSelection({ include: ["svc-a/"], exclude: [] }, prefixed);
  assert.equal(selected("svc-a/A.java"), true);
  assert.equal(selected("svc-b/B.java"), false);
});

test("an exclude removes a path an include selects", () => {
  const selected = pathSelection({ include: ["svc/"], exclude: ["svc/static/"] }, prefixed);
  assert.equal(selected("svc/A.java"), true);
  assert.equal(selected("svc/static/app.js"), false);
});

test("a glob is valid only as a repository-relative pattern of plain segments joined by slashes", () => {
  for (const glob of ["svc/**", "*.java", "a/b/c.ts"]) assert.equal(isValidGlob(glob), true, glob);
  for (const glob of ["", "./x/**", "/x", "x/", "a//b", "a/./b", "../x", "a/../b", "a\\b"]) assert.equal(isValidGlob(glob), false, glob);
});

test("an export selection adds the configuration an extractor needs to interpret what the caller selected", () => {
  const exported = exportSelection({ include: ["svc/"], exclude: [] }, prefixed, isConfiguration);
  assert.equal(exported("svc/A.java"), true);
  assert.equal(exported("package.json"), true);
  assert.equal(exported("README.md"), false);
});

test("an exclude removes configuration the export selection would otherwise add", () => {
  const exported = exportSelection({ include: ["svc/"], exclude: ["package.json"] }, prefixed, isConfiguration);
  assert.equal(exported("package.json"), false);
  assert.equal(exported("svc/A.java"), true);
});
