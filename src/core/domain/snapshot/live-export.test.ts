import { test } from "node:test";
import assert from "node:assert/strict";
import { contentFingerprint } from "../map/entrypoint-map.ts";
import { changedPaths, liveExport, liveScope } from "./live-export.ts";

test("a live export reads as a commit export: a mirrored Java file is written, a README is listed only", () => {
  const exported = liveExport([{ path: "README.md", blob: "1" }, { path: "src/A.java", blob: "2" }], [{ path: "link", reason: "symlink" }]);

  assert.deepEqual(exported.files, [{ path: "README.md", blob: "1", written: false }, { path: "src/A.java", blob: "2", written: true }]);
  assert.equal(contentFingerprint(exported), contentFingerprint({ files: [{ path: "src/A.java", blob: "2", written: true }], skipped: [{ path: "link", reason: "symlink" }] }));
});

test("the changed paths are those whose blob differs plus those only one listing holds", () => {
  const base = [{ path: "a", blob: "1" }, { path: "b", blob: "1" }, { path: "gone", blob: "1" }];
  const live = [{ path: "a", blob: "1" }, { path: "b", blob: "2" }, { path: "added", blob: "1" }];

  assert.deepEqual(changedPaths(base, live), ["added", "b", "gone"]);
  assert.deepEqual(changedPaths(base, base), []);
});

test("the live scope is the declared scope plus the git ignore rule", () => {
  assert.deepEqual(liveScope({ include: ["src/**"] }).ignored, "git");
  assert.deepEqual(liveScope({ include: ["src/**"] }).include, ["src/**"]);
});

test("live export writes JSON module resource candidates", () => {
  assert.equal(liveExport([{ path: "src/data.json", blob: "1" }], []).files[0]?.written, true);
});
