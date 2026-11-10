import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));
const OWNER = "core/adapters/typescript/request-summaries.ts";

/** Each concept of "is this call a request", with its one owner; `pending` lists copies a later consolidation removes and only shrinks. */
const RULES: readonly { concept: string; pattern: RegExp; owner: string; pending: readonly string[] }[] = [
  {
    concept: "a call is a request by the client name its callee spells",
    pattern: /\.text === "(?:fetch|httpResource)"|"httpResource"\)/,
    owner: OWNER,
    pending: ["core/adapters/typescript/consumer-flow.walker.ts", "core/adapters/typescript/request-origins.adapter.ts"],
  },
  { concept: "the verbs of the client vocabulary", pattern: /new Set\(\["get", "head", "post"/, owner: OWNER, pending: [] },
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
