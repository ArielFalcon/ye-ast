import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { indexCacheDirectory } from "./index-cache-directory.ts";

test("XDG_CACHE_HOME names the cache, and an unset or empty one falls back to the home's .cache", () => {
  assert.equal(indexCacheDirectory({ env: { XDG_CACHE_HOME: "/xdg" }, platform: "linux", home: "/home/u" }), join("/xdg", "ye-ast"));
  assert.equal(indexCacheDirectory({ env: { XDG_CACHE_HOME: "" }, platform: "linux", home: "/home/u" }), join("/home/u", ".cache", "ye-ast"));
  assert.equal(indexCacheDirectory({ env: {}, platform: "darwin", home: "/Users/u" }), join("/Users/u", ".cache", "ye-ast"));
});

test("on Windows the cache is under LOCALAPPDATA, and a relative XDG_CACHE_HOME is ignored", () => {
  assert.equal(indexCacheDirectory({ env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", XDG_CACHE_HOME: "/xdg" }, platform: "win32", home: "C:\\Users\\u" }), join("C:\\Users\\u\\AppData\\Local", "ye-ast"));
  assert.equal(indexCacheDirectory({ env: { XDG_CACHE_HOME: "relative" }, platform: "linux", home: "/home/u" }), join("/home/u", ".cache", "ye-ast"));
});

test("without a place to put it there is no cache", () => {
  assert.equal(indexCacheDirectory({ env: {}, platform: "win32", home: "C:\\Users\\u" }), null);
  assert.equal(indexCacheDirectory({ env: {}, platform: "linux", home: "" }), null);
});
