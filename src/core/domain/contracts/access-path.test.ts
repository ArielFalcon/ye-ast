import assert from "node:assert/strict";
import test from "node:test";
import { formatAccessPath, parseAccessPath, relatePaths, rewritePath } from "./access-path.ts";

const path = (text: string) => {
  const parsed = parseAccessPath(text);
  assert.notEqual(parsed, undefined, text);
  return parsed!;
};

test("an access path round-trips through its text, with array elements as []", () => {
  for (const text of ["", "a", "a.b", "[].owner.name", "items[].tags[]", "a[][].b"]) assert.equal(formatAccessPath(path(text)), text);
  assert.deepEqual(path("items[].name"), ["items", "[]", "name"]);
});

test("text that is not an access path is refused", () => {
  for (const text of ["a..b", ".a", "a.", "a.[]", "a[", "a]"]) assert.equal(parseAccessPath(text), undefined, text);
});

test("a read relates to the changed path as exact, beyond it, containing it, or disjoint", () => {
  const changed = path("address");
  assert.equal(relatePaths(path("address"), changed), "exact");
  assert.equal(relatePaths(path("address.city"), changed), "beyond");
  assert.equal(relatePaths(path(""), changed), "contains");
  assert.equal(relatePaths(path("name"), changed), "disjoint");
  assert.equal(relatePaths(path("addresses"), changed), "disjoint");
  assert.equal(relatePaths(path("[].address"), path("address")), "disjoint");
});

test("a rewrite carries the changed path to where the projection puts it, and drops it when the projection leaves it out", () => {
  const strip = [{ from: path("body"), to: path("") }];
  assert.deepEqual(rewritePath(path("body.owner.name"), strip), [path("owner.name")]);
  const rename = [
    { from: path("address"), to: path("addr") },
    { from: path("name"), to: path("label") },
  ];
  assert.deepEqual(rewritePath(path("address.city"), rename), [path("addr.city")]);
  assert.deepEqual(rewritePath(path("phone"), rename), []);
  assert.deepEqual(rewritePath(path("[].owner"), [{ from: path("[]"), to: path("") }]), [path("owner")]);
});
