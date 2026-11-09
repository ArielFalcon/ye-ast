import { test } from "node:test";
import assert from "node:assert/strict";
import { selectChange } from "./change-selection.ts";
import type { FileChange } from "./diff-reader.ts";

const matches = (path: string, glob: string): boolean => path.startsWith(glob.replace(/\*\*$/, ""));

function change(path: string): FileChange {
  return { path, deleted: false, binary: false, added: [{ start: 1, end: 1 }], removals: [], removedNames: [], hunks: [{ head: { start: 1, end: 1 }, removedNames: [] }] };
}

test("selectChange keeps only the changed paths a glob selects", () => {
  const files = [change("src/a/one.ts"), change("src/b/two.ts")];
  const selection = selectChange(files, ["src/a/**"], matches);
  assert.deepEqual(selection.files.map((file) => file.path), ["src/a/one.ts"]);
  assert.deepEqual(selection.unmatched, []);
});

test("selectChange reports a glob that selects no changed path", () => {
  const selection = selectChange([change("src/a/one.ts")], ["src/z/**", "src/a/**"], matches);
  assert.deepEqual(selection.unmatched, ["src/z/**"]);
});

test("selectChange reports no unmatched glob when the change is empty", () => {
  const selection = selectChange([], ["src/z/**"], matches);
  assert.deepEqual(selection.files, []);
  assert.deepEqual(selection.unmatched, []);
});

test("selectChange treats no globs as the whole change", () => {
  const files = [change("src/a/one.ts")];
  assert.deepEqual(selectChange(files, undefined, matches), { files, unmatched: [] });
  assert.deepEqual(selectChange(files, [], matches), { files, unmatched: [] });
});
