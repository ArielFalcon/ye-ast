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

test("a changed template changes the content digest, and the same template gives the same digest", () => {
  assert.notEqual(contentFingerprint(exportOf("blob-1")), contentFingerprint(exportOf("blob-2")));
  assert.equal(contentFingerprint(exportOf("blob-1")), contentFingerprint(exportOf("blob-1")));
});

test("a template the export left out is a not-exported cut", () => {
  const cuts = exportCuts(exportOf("blob-1", { skipped: [{ path: "src/app/big.component.html", reason: "too-large" }] }));
  assert.deepEqual(cuts, [{ kind: "not-exported", at: ["src/app/big.component.html"] }]);
});

test("a source in a language with no extractor is a no-extractor cut, as impact cuts it", () => {
  const exported = exportOf("b1", { files: [{ path: "web/src/app/app.routes.js", blob: "b1", written: false }] });

  assert.deepEqual(exportCuts(exported), [{ kind: "no-extractor", at: ["web/src/app/app.routes.js"] }]);
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
