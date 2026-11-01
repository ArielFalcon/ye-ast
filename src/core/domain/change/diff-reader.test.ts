import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiffReader, UnreadableDiff, type FileChange } from "./diff-reader.ts";

function read(diff: string): FileChange[] {
  const reader = createDiffReader();
  for (const line of diff.split("\n")) reader.push(line);
  return reader.finish();
}

const MODIFIED = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,2 +3,3 @@ context",
  "-old",
  "-old2",
  "+new",
  "+new2",
  "+new3",
  "@@ -20 +21 @@",
  "-x",
  "+y",
].join("\n");

test("the added lines of a hunk are the new-side range its header names, a missing count being one line", () => {
  assert.deepEqual(read(MODIFIED), [
    { path: "src/a.ts", deleted: false, binary: false, added: [{ start: 3, end: 5 }, { start: 21, end: 21 }], removals: [], removedNames: [] },
  ]);
});

test("a hunk with no new-side lines marks where lines vanished and adds none", () => {
  const changes = read(["diff --git a/A.java b/A.java", "--- a/A.java", "+++ b/A.java", "@@ -10,3 +9,0 @@", "-a", "-b", "-c", "@@ -30 +26,0 @@", "-d"].join("\n"));
  assert.deepEqual(changes[0]?.added, []);
  assert.deepEqual(changes[0]?.removals.map((removal) => removal.after), [9, 26]);
});

test("the names removed lines declared are carried, a pure deletion or a replaced line alike, and an import carries none", () => {
  const changes = read(
    [
      "diff --git a/A.ts b/A.ts",
      "--- a/A.ts",
      "+++ b/A.ts",
      "@@ -2,4 +1,0 @@",
      '-import { Order } from "./order";',
      "-export function gone(id: string) {",
      "-  return load(id);",
      "-}",
      "@@ -9,2 +5,1 @@",
      "-function replaced() {",
      "-}",
      "+function kept() {}",
      "@@ -20,3 +16,0 @@",
      "---- looks like a file header",
      "-class Old {",
      "-}",
    ].join("\n"),
  );
  assert.deepEqual(changes[0]?.removals, [{ after: 1 }, { after: 16 }]);
  assert.deepEqual(changes[0]?.removedNames, ["gone", "replaced", "Old"]);
  assert.deepEqual(changes[0]?.added, [{ start: 5, end: 5 }]);
});

test("a deleted file is flagged and has no new side", () => {
  const changes = read(["diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b"].join("\n"));
  assert.deepEqual(changes, [{ path: "gone.ts", deleted: true, binary: false, added: [], removals: [{ after: 0 }], removedNames: [] }]);
});

test("a file git reports as binary is flagged and carries no ranges", () => {
  const changes = read(["diff --git a/x.ts b/x.ts", "index 1..2 100644", "Binary files a/x.ts and b/x.ts differ"].join("\n"));
  assert.deepEqual(changes, [{ path: "x.ts", deleted: false, binary: true, added: [], removals: [], removedNames: [] }]);
});

test("a body line that looks like a header neither starts a file nor a hunk", () => {
  const changes = read(
    ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", "--- a/other.ts", "+++ b/other.ts", "-@@ -5 +5 @@", "+@@ -7 +7 @@"].join("\n"),
  );
  assert.deepEqual(changes.map((change) => [change.path, change.added]), [["a.ts", [{ start: 1, end: 2 }]]]);
});

test("a path git quotes is read as UTF-8 and one with a space needs no quotes", () => {
  const diff = ['diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', "@@ -1 +1 @@", "diff --git a/my dir/b.ts b/my dir/b.ts", "@@ -2 +2 @@"].join("\n");
  assert.deepEqual(read(diff).map((change) => change.path), ["café.ts", "my dir/b.ts"]);
});

test("a path that holds a space and a b/ is split where both sides name the same file", () => {
  assert.deepEqual(read(["diff --git a/a b/c.ts b/a b/c.ts", "@@ -1 +1 @@"].join("\n")).map((change) => change.path), ["a b/c.ts"]);
});

test("a diff header the reader cannot split is a typed fault, never a skipped file", () => {
  assert.throws(() => read("diff --git garbage"), UnreadableDiff);
});

test("a name a replaced line declared is removed unless another line of the file declares it again, in any hunk", () => {
  const changes = read(
    [
      "diff --git a/Util.java b/Util.java",
      "--- a/Util.java",
      "+++ b/Util.java",
      "@@ -3,1 +3,1 @@",
      "-  public static String helper() { return \"x\"; }",
      "+  public static String other() { return \"x\"; }",
      "@@ -8,1 +8,1 @@",
      "-  int edited(int a) {",
      "+  int edited(int a, int b) {",
      "@@ -20,1 +20,0 @@",
      "-  void moved() {}",
      "@@ -30,0 +30,1 @@",
      "+  void moved() {}",
      "diff --git a/Other.java b/Other.java",
      "--- a/Other.java",
      "+++ b/Other.java",
      "@@ -1,1 +1,1 @@",
      "-  void lost() {}",
      "+  // gone",
    ].join("\n"),
  );
  assert.deepEqual(changes.map((change) => [change.path, change.removedNames]), [["Util.java", ["helper"]], ["Other.java", ["lost"]]]);
});
