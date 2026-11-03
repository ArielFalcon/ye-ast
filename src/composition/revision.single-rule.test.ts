import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/* The one file allowed to declare which values are a commit id; every other module imports `isFullObjectId`. */
const OWNER = "core/domain/shared/revision.ts";
const DECLARES_COMMIT_ID = /\[[^\]]*(?:0-9a-f|a-f0-9)[^\]]*\]\s*\{\s*(?:40|64)\b/i;
const SOURCE = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
  });
}

test("no module outside the rule's owner declares a commit id pattern", () => {
  const declaring = sourceFiles(SOURCE)
    .filter((file) => DECLARES_COMMIT_ID.test(readFileSync(file, "utf8")))
    .map((file) => relative(SOURCE, file))
    .sort();

  assert.deepEqual(declaring, [OWNER]);
});
