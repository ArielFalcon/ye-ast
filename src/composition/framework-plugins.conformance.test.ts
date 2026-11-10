import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntrypointExtraction } from "../core/ports/entrypoint-extractor.port.ts";
import { composeFrameworkPlugins, frameworkEntrypoints } from "./framework-plugins.ts";

/** RFC-0007 Conformance: each fixture is a minimal repository and the facts the registered plugins read from it. */
const ROUTES = fileURLToPath(new URL("../core/adapters/frameworks/angular/fixtures/routes/", import.meta.url));

for (const name of readdirSync(ROUTES).filter((file) => file.endsWith(".json")).sort()) {
  test(`the Angular route fixture ${name} yields its expected entrypoints`, async () => {
    const fixture: { files: Record<string, string>; expected: EntrypointExtraction } = JSON.parse(readFileSync(join(ROUTES, name), "utf8"));
    const files = Object.entries(fixture.files).map(([path, content]) => ({ path, content }));

    assert.deepEqual(await frameworkEntrypoints(composeFrameworkPlugins(), files), fixture.expected);
  });
}
