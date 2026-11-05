import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/* The one file allowed to declare which values are a commit id; every other module imports `isFullObjectId`. */
const OWNER = "core/domain/shared/revision.ts";
const DECLARES_COMMIT_ID = /\[[^\[\]\r\n]*(?:0-9a-f|a-f0-9)[^\[\]\r\n]*\]\s*\{\s*(?:40|64)\b/gi;
const SOURCE = fileURLToPath(new URL("../", import.meta.url));

function declaresCommitId(source: string): boolean {
  for (const pattern of source.matchAll(DECLARES_COMMIT_ID)) {
    // A required literal namespace denotes a digest, never a bare Git id. Still inspect every other pattern.
    if (!/\/\^[a-z][a-z0-9-]*:$/i.test(source.slice(0, pattern.index))) return true;
  }
  return false;
}

test("commit rule detection distinguishes required digest namespaces and still scans the rest of a module", () => {
  const digest = "const declaration = /^ws-r1:[0-9a-f]{64}$/;";
  const wrappedDigest = 'const schema = z.union([\n  z.string().regex(/^mcp-r1:[0-9a-f]{64}$/),\n]);';
  assert.equal(declaresCommitId(digest), false);
  assert.equal(declaresCommitId(wrappedDigest), false);
  for (const source of [
    "const id = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;",
    "const id = /^[a-f0-9]{64}$/i;",
    'const id = new RegExp("^[0-9a-f]{40}$");',
  ]) {
    assert.equal(declaresCommitId(source), true);
    assert.equal(declaresCommitId(`${digest}\n${source}`), true);
    assert.equal(declaresCommitId(`${wrappedDigest}\n${source}`), true);
  }
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
  });
}

test("no module outside the rule's owner declares a commit id pattern", () => {
  const declaring = sourceFiles(SOURCE)
    .filter((file) => declaresCommitId(readFileSync(file, "utf8")))
    .map((file) => relative(SOURCE, file))
    .sort();

  assert.deepEqual(declaring, [OWNER]);
});
