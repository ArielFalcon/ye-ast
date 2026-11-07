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
    pending: ["typescript/lexical-bindings.ts"],
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
    pending: [],
  },
  {
    concept: "the class `this` denotes",
    pattern: /(?:function|const)\s+(?:enclosingClass\w*|thisClass\w*|ownerOfThis)\b/,
    owners: ["typescript/syntax.ts"],
    pending: [],
  },
  {
    concept: "recognizing Angular's inject by its spelling instead of its import (the owner is angular-injection.ts)",
    pattern: /(?:getText\([^)]*\)|\.text)\s*[!=]==\s*"inject"/,
    owners: [],
    pending: [],
  },
  {
    concept: "reading the bindings of an import statement",
    pattern: /\.importClause\b/,
    owners: ["typescript/import-bindings.ts"],
    pending: [],
  },
  {
    concept: "the value a TypeScript statement exports as default",
    pattern: /SyntaxKind\.DefaultKeyword/,
    /* module-dependencies fingerprints every modifier of a declaration; import-origins reads `export default interface`, a type. */
    owners: ["typescript/import-bindings.ts", "typescript/module-dependencies.adapter.ts", "typescript/import-origins.adapter.ts"],
    pending: [],
  },
  {
    concept: "whether a TypeScript file parsed without syntax errors",
    pattern: /\.parseDiagnostics\b/,
    owners: ["typescript/syntax.ts"],
    pending: ["typescript/import-origins.adapter.ts"],
  },
  {
    concept: "parsing Java sources into files of a project",
    pattern: /(?<!JSON)\.parse\(\s*(?:source|file)\.content\s*\)/,
    /* The tree-sitter readers parse one file at a time for a per-file answer and build no project. */
    owners: ["spring/java-project.ts", "tree-sitter/java-member-names.adapter.ts", "tree-sitter/java-records.adapter.ts", "tree-sitter/java-trivia.adapter.ts"],
    pending: ["spring/spring-payload-shapes.adapter.ts"],
  },
  {
    concept: "the Java type `this` and `super` denote, read from the type body around a node",
    pattern: /enclosingBody\([^)]*\)\??\.parent/,
    owners: ["spring/java-project.ts"],
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

const SOURCES = sourceFiles(ADAPTERS).map((path) => ({ file: relative(ADAPTERS, path), text: readFileSync(path, "utf8") }));

for (const rule of RULES) {
  test(`${rule.concept} lives only in its owner`, () => {
    const holders = SOURCES.filter(({ text }) => rule.pattern.test(text)).map(({ file }) => file).sort();

    assert.deepEqual(holders, [...rule.owners, ...rule.pending].sort());
  });
}
