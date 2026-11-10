import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));
const FRAMEWORKS = "core/adapters/frameworks/";
const ANGULAR_PLUGIN = "core/adapters/frameworks/angular/angular.plugin.ts";
const REGISTRY = "composition/framework-plugins.ts";

/** Each word of a framework's vocabulary, with its one owner, the plugin (ADR-0045 decision 12); `pending` only shrinks. */
const VOCABULARY: readonly { concept: string; pattern: RegExp; pending: readonly string[] }[] = [
  { concept: "the Angular router's package", pattern: /["']@angular\/router["']/, pending: ["core/adapters/typescript/angular-projects.ts"] },
  { concept: "the Angular router's configuration calls", pattern: /["'](?:RouterModule\.)?(?:provideRouter|forRoot|forChild)["']/, pending: ["core/adapters/typescript/consumer-flow.index.ts"] },
  { concept: "the Angular router's module", pattern: /["']RouterModule["']/, pending: ["core/adapters/typescript/consumer-flow.index.ts"] },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [relative(SOURCE, path)] : [];
  });
}

const isProduction = (file: string): boolean => !file.endsWith(".test.ts") && !file.endsWith(".testing.ts");
const holders = (files: readonly string[], pattern: RegExp): string[] => files.filter((file) => pattern.test(readFileSync(join(SOURCE, file), "utf8"))).sort();
const ALL = sourceFiles(SOURCE);

for (const { concept, pattern, pending } of VOCABULARY) {
  test(`${concept} is declared only in its plugin`, () => {
    assert.deepEqual(holders(ALL.filter(isProduction), pattern), [ANGULAR_PLUGIN, ...pending].sort());
  });
}

test("framework code is imported only by the registry: never by a language adapter nor by another composition", () => {
  const outside = ALL.filter((file) => !file.startsWith(FRAMEWORKS));

  assert.deepEqual(holders(outside, /\b(?:from|import)\s*\(?\s*["'][^"']*\/frameworks\//), [REGISTRY]);
});

test("a reader a plugin wraps is built only by the registry", () => {
  assert.deepEqual(holders(ALL.filter(isProduction), /\bcreateAngularRoutesExtractor\b/), [REGISTRY, "core/adapters/typescript/angular-routes.adapter.ts"].sort());
});
