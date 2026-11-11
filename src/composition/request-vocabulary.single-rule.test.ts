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
    pending: [],
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

function importsVerbs(source: string): boolean {
  const named = [...source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*request-summaries(?:\.ts)?["']/gs)]
    .some((match) => (match[1] ?? "").split(",").some((binding) => /^\s*(?:type\s+)?VERBS(?:\s+as\s+\w+)?\s*$/.test(binding)));
  const namespaces = [...source.matchAll(/\bimport\s+\*\s+as\s+(\w+)\s+from\s+["'][^"']*request-summaries(?:\.ts)?["']/g)];
  return named || namespaces.some((match) => new RegExp(`\\b${match[1]}\\s*(?:\\.\\s*VERBS\\b|\\[\\s*["']VERBS["']\\s*\\])`).test(source));
}

test("the request verb vocabulary has no external importers", () => {
  const importers = sourceFiles(SOURCE).filter((file) => importsVerbs(readFileSync(file, "utf8"))).map((file) => relative(SOURCE, file));
  assert.deepEqual(importers, []);
  assert.equal(importsVerbs('import { VERBS as methods } from "./request-summaries.ts";'), true);
  assert.equal(importsVerbs('import { other as VERBS } from "./request-summaries.ts";'), false);
  assert.equal(importsVerbs('import * as requests from "./request-summaries.ts"; requests.VERBS.has("get");'), true);
});

for (const { concept, pattern, owner, pending } of RULES) {
  test(`${concept} lives only in its owner`, () => {
    const holders = sourceFiles(SOURCE)
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(SOURCE, file))
      .sort();

    assert.deepEqual(holders, [owner, ...pending].sort());
  });
}
