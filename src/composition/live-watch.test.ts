import { test } from "node:test";
import assert from "node:assert/strict";
import { canMoveLiveListing } from "./live-watch.ts";

test("a change moves the live listing only at git's HEAD or index, or at a selected path outside the engine's own entries", () => {
  const selected = (path: string): boolean => !path.startsWith("excluded/");
  const moves = (path: string): boolean => canMoveLiveListing(path, selected);
  assert.deepEqual(
    [".git/HEAD", ".git/index", "src/App.java", ".git/objects/ab/cd", ".git/refs/heads/main", ".ye-ast-graph/live/s/src/App.java", "web/.codegraph/db", ".ye-ast/entrypoints.json", "excluded/App.java", "src/.git-notes"].map(moves),
    [true, true, true, false, false, false, false, false, false, true],
  );
});
