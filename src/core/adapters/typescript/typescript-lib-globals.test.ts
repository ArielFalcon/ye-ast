import { test } from "node:test";
import assert from "node:assert/strict";
import { TYPESCRIPT_LIB_GLOBALS } from "./typescript-lib-globals.ts";
import { libGlobalNames } from "./typescript-lib-globals.extract.ts";

test("the committed table is exactly what the pinned typescript declares", () => {
  assert.deepEqual([...TYPESCRIPT_LIB_GLOBALS], [...libGlobalNames()], "run `node --import tsx scripts/lib-globals.ts` after moving the pin");
});

test("the table holds the names a reference reaches without any import", () => {
  for (const name of ["console", "caches", "String", "window", "document", "Promise"]) assert.ok(TYPESCRIPT_LIB_GLOBALS.includes(name), name);
});
