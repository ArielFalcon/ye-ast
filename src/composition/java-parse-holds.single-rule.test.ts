import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/* Every Java parser composition builds parses through the holds of the snapshot reads (ADR-0040). */
const COMPOSITION = fileURLToPath(new URL("./", import.meta.url));
const PARSER_WITHOUT_HOLDS = /^(?!import\b).*\bcreateJavaParser\b(?!\(holds\))/m;

test("composition builds every Java parser over the snapshot reads' holds", () => {
  const building = readdirSync(COMPOSITION)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".testing.ts"))
    .filter((name) => PARSER_WITHOUT_HOLDS.test(readFileSync(join(COMPOSITION, name), "utf8")))
    .map((name) => relative(COMPOSITION, join(COMPOSITION, name)));

  assert.deepEqual(building, []);
});
