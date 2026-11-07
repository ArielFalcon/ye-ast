import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { createDeclarationLookup } from "./declaration-lookup.ts";
import { moduleShape } from "./module-shape.ts";
import { sourceTree } from "./source-tree.ts";

const FILES: Readonly<Record<string, string>> = {
  "src/index.ts": "export { default as config } from './config';\nexport { default as Page } from './page';",
  "src/config.ts": "export default { base: '/api' };",
  "src/page.ts": "export default class {}",
};

const parse = async (file: string) => (FILES[file] === undefined ? undefined : moduleShape(sourceTree({ path: file, content: FILES[file] }, ts.ScriptTarget.Latest, ts.ScriptKind.TS)));
const fileOf = async (_from: string, specifier: string) => `src/${specifier.slice(2)}.ts`;

test("a default export that declares no name is a declaration only for a lookup that asks for it", async () => {
  const reading = createDeclarationLookup(parse, fileOf, { anonymousDefault: true });
  const naming = createDeclarationLookup(parse, fileOf);

  assert.deepEqual(await Promise.all(["config", "Page"].map((name) => reading("src/index.ts", name))), [{ file: "src/config.ts", name: "default" }, { file: "src/page.ts", name: "default" }]);
  assert.deepEqual(await Promise.all(["config", "Page"].map((name) => naming("src/index.ts", name))), [undefined, undefined]);
});
