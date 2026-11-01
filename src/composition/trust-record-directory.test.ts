import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { trustRecordDirectory } from "./trust-record-directory.ts";

test("XDG_CONFIG_HOME names the record's directory, and an unset or empty one falls back to the home's .config", () => {
  assert.equal(trustRecordDirectory({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", home: "/home/u" }), join("/xdg", "ye-ast"));
  assert.equal(trustRecordDirectory({ env: { XDG_CONFIG_HOME: "" }, platform: "linux", home: "/home/u" }), join("/home/u", ".config", "ye-ast"));
  assert.equal(trustRecordDirectory({ env: {}, platform: "darwin", home: "/Users/u" }), join("/Users/u", ".config", "ye-ast"));
});

test("on Windows the record is under APPDATA, and a relative XDG_CONFIG_HOME is ignored elsewhere", () => {
  assert.equal(trustRecordDirectory({ env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", XDG_CONFIG_HOME: "/xdg" }, platform: "win32", home: "C:\\Users\\u" }), join("C:\\Users\\u\\AppData\\Roaming", "ye-ast"));
  assert.equal(trustRecordDirectory({ env: { XDG_CONFIG_HOME: "relative" }, platform: "linux", home: "/home/u" }), join("/home/u", ".config", "ye-ast"));
});

test("without a place to put it there is no record directory", () => {
  assert.equal(trustRecordDirectory({ env: {}, platform: "win32", home: "C:\\Users\\u" }), null);
  assert.equal(trustRecordDirectory({ env: {}, platform: "linux", home: "" }), null);
});
