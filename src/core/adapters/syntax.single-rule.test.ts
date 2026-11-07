import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * Each syntax concept of the extractors has one owner module. `pending` lists the copies a later consolidation removes;
 * it only shrinks.
 */
const ADAPTERS = fileURLToPath(new URL("./", import.meta.url));

interface Rule {
  concept: string;
  pattern: RegExp;
  owners: readonly string[];
  pending: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    concept: "parsing a file",
    pattern: /\bts\.createSourceFile\(/,
    owners: ["typescript/source-tree.ts", "typescript/url-define.ts", "typescript/typescript-lib-globals.extract.ts"],
    pending: ["typescript/angular-router.extractor.ts", "typescript/import-origins.adapter.ts", "typescript/lexical-bindings.ts"],
  },
  {
    concept: "a program over a file",
    pattern: /\bts\.createProgram\(/,
    owners: ["typescript/lexical-bindings.ts"],
    pending: [],
  },
  {
    concept: "stripping the wrappers that keep a value",
    pattern: /while\s*\((?:\s*ts\.is(?:Parenthesized|As|Satisfies|TypeAssertion|NonNull)Expression\((\w+)\)\s*\|\|)+[^;]*?\)\s*\1\s*=\s*\1\.expression/,
    /* function-value-calls keeps its own stricter rule: the wrappers that keep both the value and its type. */
    owners: ["typescript/syntax.ts", "typescript/function-value-calls.ts"],
    pending: ["typescript/import-origins.adapter.ts"],
  },
  {
    concept: "the class `this` denotes",
    pattern: /(?:function|const)\s+(?:enclosingClass\w*|thisClass\w*|ownerOfThis)\b/,
    owners: ["typescript/syntax.ts"],
    pending: ["spring/java-receiver-methods.ts", "typescript/http-call-sites.adapter.ts"],
  },
  {
    concept: "recognizing Angular's inject by its spelling instead of its import (the owner is angular-injection.ts)",
    pattern: /(?:getText\([^)]*\)|\.text)\s*[!=]==\s*"inject"/,
    owners: [],
    pending: ["typescript/http-call-sites.adapter.ts"],
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
  });
}

const SOURCES = sourceFiles(ADAPTERS).map((path) => ({ file: relative(ADAPTERS, path), text: readFileSync(path, "utf8") }));

for (const rule of RULES) {
  test(`${rule.concept} lives only in its owner`, () => {
    const holders = SOURCES.filter(({ text }) => rule.pattern.test(text)).map(({ file }) => file).sort();

    assert.deepEqual(holders, [...rule.owners, ...rule.pending].sort());
  });
}
