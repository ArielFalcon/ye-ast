import { test } from "node:test";
import assert from "node:assert/strict";
import { installPathOf, lockedVersions } from "./installed-packages.ts";

test("an npm lockfile of version 2 or later states versions by install path; an older one states nothing", () => {
  const packages = { "": { name: "app" }, "node_modules/@scope/a": { version: "1.0.0" }, "node_modules/b/node_modules/c": { version: "3.1.0" }, "libs/d": { version: "0.1.0" } };
  assert.deepEqual([...lockedVersions(JSON.stringify({ lockfileVersion: 3, packages }))!], [["@scope/a", "1.0.0"], ["b/node_modules/c", "3.1.0"]]);
  assert.equal(lockedVersions(JSON.stringify({ lockfileVersion: 1, dependencies: { b: { version: "1.0.0" } } })), undefined);
});

test("a path under node_modules belongs to the package installed nearest to it", () => {
  assert.deepEqual(
    ["@scope/a/index.d.ts", "b/node_modules/c/lib/x.d.ts", "b/index.d.ts", "loose.d.ts", ".package-lock.json", "@scope/index.d.ts"].map(installPathOf),
    ["@scope/a", "b/node_modules/c", "b", undefined, undefined, undefined],
  );
});
