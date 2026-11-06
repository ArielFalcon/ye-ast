import { test } from "node:test";
import assert from "node:assert/strict";
import { contentFingerprint, declaredScope, exportCuts, isInMapScope, type MapExport } from "./entrypoint-map.ts";

const exportOf = (blob: string, overrides: Partial<MapExport> = {}): MapExport => ({
  files: [{ path: "src/app/page.component.html", blob, written: true }],
  skipped: [],
  ...overrides,
});

test("an Angular template is in the map's scope, so the export writes it for the relation reader", () => {
  assert.equal(isInMapScope("src/app/page.component.html"), true);
  assert.equal(isInMapScope("docs/notes.md"), false);
});

test("a JVM test source is outside the map's scope, so no fact reads it; a main source is in", () => {
  assert.equal(isInMapScope("src/test/java/app/OrderTest.java"), false);
  assert.equal(isInMapScope("src/main/java/app/Order.java"), true);
});

test("an Angular workspace is in the map's scope, so the relation reader sees the sources it replaces at build time", () => {
  assert.equal(isInMapScope("angular.json"), true);
  assert.equal(isInMapScope("src/app/data.json"), false);
});

test("a changed template changes the content digest, and the same template gives the same digest", () => {
  assert.notEqual(contentFingerprint(exportOf("blob-1")), contentFingerprint(exportOf("blob-2")));
  assert.equal(contentFingerprint(exportOf("blob-1")), contentFingerprint(exportOf("blob-1")));
});

test("a template the export left out is a not-exported cut", () => {
  const cuts = exportCuts(exportOf("blob-1", { skipped: [{ path: "src/app/big.component.html", reason: "too-large" }] }));
  assert.deepEqual(cuts, [{ kind: "not-exported", at: ["src/app/big.component.html"] }]);
});

test("a JVM source no extractor parses, which Spring could still read, is a no-extractor cut", () => {
  const files = ["src/main/kotlin/Order.kt", "src/Order.java"].map((path) => ({ path, blob: "b1", written: false }));

  assert.deepEqual(exportCuts(exportOf("b1", { files })), [{ kind: "no-extractor", at: ["src/main/kotlin/Order.kt"] }]);
});

test("a source in a language no declared framework reads is outside the declared scope, so it is no cut", () => {
  const paths = ["ios/App/AppDelegate.swift", "scripts/inject-env.mjs", "eslint.config.js", "web/src/app/app.routes.js", "src/Order.java"];
  const exported = exportOf("b1", { files: paths.map((path) => ({ path, blob: "b1", written: false })) });

  assert.deepEqual(exportCuts(exported), []);
});

test("a repository that holds no source of a declared language cuts every source it cannot read", () => {
  const files = ["app.py", "src/Order.kt"].map((path) => ({ path, blob: "b1", written: false }));

  assert.deepEqual(exportCuts(exportOf("b1", { files })), [
    { kind: "no-extractor", at: ["app.py"] },
    { kind: "no-extractor", at: ["src/Order.kt"] },
  ]);
});

test("the declared scope keeps the map's languages and frameworks and carries the requested globs sorted, each once", () => {
  assert.deepEqual(declaredScope({ include: ["b/**", "a/**", "b/**"], exclude: ["z/**"] }), {
    languages: ["java", "typescript"],
    frameworks: ["angular", "spring"],
    include: ["a/**", "b/**"],
    exclude: ["z/**"],
  });
  assert.deepEqual(declaredScope(), { languages: ["java", "typescript"], frameworks: ["angular", "spring"], include: [], exclude: [] });
});
