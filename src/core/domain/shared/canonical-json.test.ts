import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "./canonical-json.ts";

test("a value that holds the same members in another key order encodes the same", () => {
  assert.equal(canonicalJson({ walk: { depth: 2 }, exportBudget: null }), canonicalJson({ exportBudget: null, walk: { depth: 2 } }));
  assert.equal(canonicalJson({ budget: undefined }), canonicalJson({}));
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
});
