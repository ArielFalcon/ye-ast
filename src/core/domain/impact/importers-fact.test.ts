import { test } from "node:test";
import assert from "node:assert/strict";
import { unresolvedNamersOf } from "./importers-fact.ts";
import type { UnresolvedUse } from "./impact-cuts.ts";

function use(name: string, file = "src/app/other.ts", line = 3): UnresolvedUse {
  return { name, kind: "calls", file, line };
}

function qualified(name: string, candidates: readonly string[], file = "src/app/other.ts", line = 3): UnresolvedUse {
  return { name, kind: "calls", file, line, candidates };
}

test("a reference names a file only by a whole segment, never by a substring of its stem", () => {
  const namers = unresolvedNamersOf("src/app/date.ts", new Set(["format"]), new Set(["Date::format"]), [use("this.update"), use("today")]);
  assert.deepEqual(namers, []);
  assert.deepEqual(unresolvedNamersOf("src/app/order.ts", new Set(["Order"]), new Set(["Order"]), [use("reorder")]), []);
});

test("a reference through the module a file is named after names it", () => {
  assert.deepEqual(unresolvedNamersOf("src/app/order.ts", new Set(["Order"]), new Set(["Order"]), [use("order.create")]), ["src/app/other.ts"]);
});

test("a bare reference equal to a declared name names the file", () => {
  assert.deepEqual(unresolvedNamersOf("src/app/order.ts", new Set(["Order"]), new Set(["Order"]), [use("Order")]), ["src/app/other.ts"]);
});

test("a qualified reference names a file's declaration only when the index considered that declaration for it", () => {
  const declared = new Set(["resolve"]);
  const qualifiedNames = new Set(["AddressService::resolve"]);
  assert.deepEqual(unresolvedNamersOf("src/app/address.service.ts", declared, qualifiedNames, [qualified("Promise.resolve", [])]), []);
  assert.deepEqual(unresolvedNamersOf("src/app/address.service.ts", declared, qualifiedNames, [qualified("AddressService.resolve", ["AddressService::resolve"])]), ["src/app/other.ts"]);
});

test("a reference of the other runtime never names a file, by declared name or by stem, while one of its own does", () => {
  const declared = new Set(["Configuration"]);
  const references = [use("Configuration", "src/main/java/a/CacheConfiguration.java"), use("configuration.get", "src/main/java/a/AsyncConfiguration.java"), use("Configuration", "src/app/admin/admin.ts")];

  assert.deepEqual(unresolvedNamersOf("src/app/configuration.ts", declared, new Set(["Configuration"]), references), ["src/app/admin/admin.ts"]);
});

test("a reference still names a configuration file it reads", () => {
  assert.deepEqual(unresolvedNamersOf("package.json", new Set(["version"]), new Set(["version"]), [use("version", "src/app/about.ts")]), ["src/app/about.ts"]);
});

test("a file never names itself", () => {
  assert.deepEqual(unresolvedNamersOf("src/app/order.ts", new Set(["Order"]), new Set(["Order"]), [use("Order.create", "src/app/order.ts")]), []);
});

test("the namers of one file are sorted and unique", () => {
  const namers = unresolvedNamersOf("src/app/order.ts", new Set(["Order"]), new Set(["Order"]), [use("Order", "src/app/b.ts"), use("Order", "src/app/a.ts"), use("Order", "src/app/a.ts", 9)]);
  assert.deepEqual(namers, ["src/app/a.ts", "src/app/b.ts"]);
});
