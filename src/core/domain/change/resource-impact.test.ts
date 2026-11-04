import { test } from "node:test";
import assert from "node:assert/strict";
import { resourceImpact, type ResourceOwner } from "./resource-impact.ts";
import type { FileChange } from "./diff-reader.ts";

const before: ResourceOwner = { file: "src/page.ts", name: "Page", line: 2, resources: ["src/old.html", "src/old.scss"] };
const after: ResourceOwner = { ...before, line: 20, resources: ["src/new.html"] };
const deleted = (path: string, removedNames: string[] = []): FileChange => ({ path, deleted: true, binary: false, added: [], removals: [], removedNames });

test("a deleted resource follows its surviving owner's current identity and line", () => {
  const result = resourceImpact([after], [before], [deleted("src/old.html"), deleted("src/old.scss")]);
  assert.deepEqual(result.owners.get("src/old.html"), [{ file: "src/page.ts", name: "Page", line: 20 }]);
  assert.deepEqual(result.owners.get("src/old.scss"), result.owners.get("src/old.html"));
  assert.ok(result.covered.has("src/old.html"));
  assert.ok(result.covered.has("src/new.html"));
});

test("a retired resource is covered only when every lost owner is in the selected declaration removals", () => {
  const other: ResourceOwner = { ...before, file: "src/other.ts" };
  const removal = deleted(before.file, [before.name]);
  const partial = resourceImpact([], [before, other], [deleted("src/old.html"), removal]);
  assert.equal(partial.covered.has("src/old.html"), false);
  const covered = resourceImpact([], [before, other], [deleted("src/old.html"), removal, deleted(other.file, [other.name])]);
  assert.ok(covered.covered.has("src/old.html"));
  assert.equal(covered.owners.has("src/old.html"), false);
});

test("a current claimant cannot hide an unaccounted former owner of a deleted resource", () => {
  const current = { ...after, resources: ["src/old.html"] };
  const lost = { ...before, file: "src/lost.ts" };
  const result = resourceImpact([current], [before, lost], [deleted("src/old.html")]);
  assert.equal(result.covered.has("src/old.html"), false);
  assert.equal(result.owners.get("src/old.html")?.length, 1);
});

test("an orphan that still exists or an owner moved by name alone is not proven covered", () => {
  const edited = { ...deleted("src/old.html"), deleted: false, added: [{ start: 1, end: 1 }] };
  assert.equal(resourceImpact([after], [before], [edited]).covered.has(edited.path), false);
  const renamed = resourceImpact([{ ...after, file: "src/new/page.ts" }], [before], [deleted("src/old.html")]);
  assert.equal(renamed.covered.has("src/old.html"), false);
  assert.equal(renamed.owners.has("src/old.html"), false);
});
