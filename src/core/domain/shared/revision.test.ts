import { test } from "node:test";
import assert from "node:assert/strict";
import { isFullObjectId } from "./revision.ts";

const SHA1 = "0123456789abcdef".repeat(2) + "01234567";
const SHA256 = "0123456789abcdef".repeat(4);

test("a full object id is forty hex characters of either case, or sixty-four", () => {
  assert.equal(isFullObjectId(SHA1), true);
  assert.equal(isFullObjectId(SHA1.toUpperCase()), true);
  assert.equal(isFullObjectId(SHA256), true);
  assert.equal(isFullObjectId(SHA1.slice(1)), false);
  assert.equal(isFullObjectId(`${SHA1}0`), false);
  assert.equal(isFullObjectId(SHA256.slice(1)), false);
  assert.equal(isFullObjectId("g".repeat(40)), false);
  assert.equal(isFullObjectId("main"), false);
});
