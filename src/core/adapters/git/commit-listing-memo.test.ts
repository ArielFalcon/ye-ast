import { test } from "node:test";
import assert from "node:assert/strict";
import { createListingMemo, listingCharge, type CommitTree } from "./commit-listing-memo.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

const treeOf = (paths: string[]): CommitTree => ({ files: paths.map((path) => ({ path, blob: "1".repeat(40) })), skipped: [], stop: undefined });
const names = (kept: ReturnType<ReturnType<typeof createListingMemo>["get"]>): string[] | undefined => kept?.tree.files.map((file) => file.path);

test("an admitted listing is answered by repository, sha and entry budget alone", () => {
  const memo = createListingMemo(1_000_000);
  memo.admit("/r", SHA, 10, treeOf(["a"]), new Map());

  assert.deepEqual(names(memo.get("/r", SHA, 10)), ["a"]);
  assert.equal(memo.get("/other", SHA, 10), undefined);
  assert.equal(memo.get("/r", OTHER, 10), undefined);
  assert.equal(memo.get("/r", SHA, 11), undefined);
});

test("what is admitted is a copy, so changing the tree handed in changes nothing kept", () => {
  const memo = createListingMemo(1_000_000);
  const tree = { files: [{ path: "a", blob: "1".repeat(40) }], skipped: [], stop: undefined } as { files: { path: string; blob: string }[]; skipped: []; stop: undefined };
  memo.admit("/r", SHA, 10, tree, new Map());
  tree.files[0]!.path = "changed";
  tree.files.push({ path: "added", blob: "2".repeat(40) });

  assert.deepEqual(names(memo.get("/r", SHA, 10)), ["a"]);
  assert.ok(Object.isFrozen(memo.get("/r", SHA, 10)!.tree.files));
});

test("sizes learned later join the ones kept, and the sizes handed out before stay what they were", () => {
  const memo = createListingMemo(1_000_000);
  memo.admit("/r", SHA, 10, treeOf(["a", "b"]), new Map([["x", 1]]));
  const early = memo.get("/r", SHA, 10)!.sizes;

  memo.admit("/r", SHA, 10, treeOf(["a", "b"]), new Map([["y", 2]]));

  assert.deepEqual([...memo.get("/r", SHA, 10)!.sizes].sort(), [["x", 1], ["y", 2]]);
  assert.deepEqual([...early], [["x", 1]]);
});

test("the least recently used listing leaves first when the charge passes the bound, and a read renews a listing", () => {
  const tree = treeOf(Array.from({ length: 20 }, (_, index) => `src/file-${index}.java`));
  const memo = createListingMemo(listingCharge(tree, 0) * 2);
  memo.admit("/r", SHA, 1, tree, new Map());
  memo.admit("/r", SHA, 2, tree, new Map());
  memo.get("/r", SHA, 1);

  memo.admit("/r", SHA, 3, tree, new Map());

  assert.ok(memo.get("/r", SHA, 1) !== undefined);
  assert.equal(memo.get("/r", SHA, 2), undefined);
  assert.ok(memo.get("/r", SHA, 3) !== undefined);
});

test("a listing over the bound is not admitted and takes no other listing with it", () => {
  const small = treeOf(["a"]);
  const memo = createListingMemo(listingCharge(small, 0));
  memo.admit("/r", SHA, 1, small, new Map());

  memo.admit("/r", SHA, 2, treeOf(Array.from({ length: 50 }, (_, index) => `file-${index}`)), new Map());

  assert.equal(memo.get("/r", SHA, 2), undefined);
  assert.ok(memo.get("/r", SHA, 1) !== undefined);
});

test("sizes that carry an entry past the bound take the whole entry with them", () => {
  const tree = treeOf(["a"]);
  const memo = createListingMemo(listingCharge(tree, 1));
  memo.admit("/r", SHA, 1, tree, new Map([["x", 1]]));

  memo.admit("/r", SHA, 1, tree, new Map([["y", 2]]));

  assert.equal(memo.get("/r", SHA, 1), undefined);
});
