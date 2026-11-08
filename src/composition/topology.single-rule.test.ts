import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));
/** Each rule: the one file that owns it and the files that still write it out; `pending` only shrinks. */
const RULES: readonly { concept: string; pattern: RegExp; owner: string; pending: readonly string[] }[] = [
  {
    concept: "the place of a call site",
    owner: "core/domain/topology/call-site.ts",
    pattern: /\{\s*repo:\s*(\w+)\.repo,\s*file:\s*\1\.file,\s*line:\s*\1\.line,\s*symbol:\s*\1\.symbol\s*\}/,
    pending: [],
  },
  {
    concept: "the order of call sites",
    owner: "core/domain/topology/call-site.ts",
    pattern: /a\.(?:from\.)?line - b\.(?:from\.)?line \|\| compareText\(a\.(?:from\.)?symbol, b\.(?:from\.)?symbol\)/,
    pending: [],
  },
  {
    concept: "reading the scheme and authority a URL starts with",
    owner: "core/domain/topology/path-template.ts",
    pattern: /\\\/\\\/\(?\[\^\/\?#\]\*/,
    pending: [],
  },
  {
    concept: "the HTTP methods a route serves and a request names",
    owner: "core/domain/entrypoints/http-route.ts",
    pattern: /"GET",\s*"HEAD",\s*"POST"/,
    pending: [],
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
  });
}

for (const { concept, pattern, owner, pending } of RULES) {
  test(`${concept} lives only in its owner`, () => {
    const holders = sourceFiles(SOURCE)
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(SOURCE, file))
      .sort();

    assert.deepEqual(holders, [owner, ...pending].sort());
  });
}
