import { test } from "node:test";
import assert from "node:assert/strict";
import { createPathMatcher } from "./path-matcher.adapter.ts";

const matcher = createPathMatcher();

test("a glob matches whole segments of a repository path and a look-alike prefix does not match", () => {
  assert.equal(matcher.matches("service/src/main/resources/static/app.js", "service/src/main/resources/static/**"), true);
  assert.equal(matcher.matches("service/src/main/resources/static-assets/app.js", "service/src/main/resources/static/**"), false);
});

test("a star never matches a dot-prefixed segment", () => {
  assert.equal(matcher.matches("vendor/.hidden/a.js", "vendor/**"), false);
  assert.equal(matcher.matches("vendor/lib/a.js", "vendor/**"), true);
});
