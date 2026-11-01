import { test } from "node:test";
import assert from "node:assert/strict";
import { createDynamicLoadReader } from "./dynamic-loads.adapter.ts";

const SOURCE = [
  "const lazy = () => import('./app.component');",
  "export async function load(name: string) {",
  "  return import(name);",
  "}",
  "const legacy = require('./legacy.js');",
  "const other = require(prefix + '/x');",
  "const tpl = import(`./tpl`);",
  "import { A } from './static';",
  "const plain = other('here');",
  "type Mapbox = (typeof import('mapbox-gl'))['default'];",
  "type Late = (typeof import(name))['x'];",
].join("\n");

test("every dynamic load of a source is one entry with its 1-based line and its specifier only when it is a literal", async () => {
  const loads = await createDynamicLoadReader().extract([{ path: "src/app.ts", content: SOURCE }]);
  assert.deepEqual(loads, [
    { file: "src/app.ts", line: 1, specifier: "./app.component" },
    { file: "src/app.ts", line: 3 },
    { file: "src/app.ts", line: 5, specifier: "./legacy.js" },
    { file: "src/app.ts", line: 6 },
    { file: "src/app.ts", line: 7, specifier: "./tpl" },
    { file: "src/app.ts", line: 10, specifier: "mapbox-gl" },
    { file: "src/app.ts", line: 11 },
  ]);
});
