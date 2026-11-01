import { test } from "node:test";
import assert from "node:assert/strict";
import { privateToOwner } from "./private-to-owner.ts";

const OWNER = 501;

test("an entry of the owner closed to the group and to everyone else is private", () => {
  assert.equal(privateToOwner({ symbolicLink: false, uid: OWNER, mode: 0o40700 }, OWNER), null);
  assert.equal(privateToOwner({ symbolicLink: false, uid: OWNER, mode: 0o100600 }, OWNER), null);
});

test("a symbolic link is refused even when its own status looks private", () => {
  assert.notEqual(privateToOwner({ symbolicLink: true, uid: OWNER, mode: 0o120700 }, OWNER), null);
});

test("an entry of another account is refused even when it is closed to everyone else", () => {
  assert.notEqual(privateToOwner({ symbolicLink: false, uid: OWNER + 1, mode: 0o40700 }, OWNER), null);
});

test("an entry open to the group or to everyone else is refused, each bit on its own", () => {
  for (const open of [0o070, 0o007, 0o040, 0o004]) {
    assert.notEqual(privateToOwner({ symbolicLink: false, uid: OWNER, mode: 0o40700 | open }, OWNER), null, open.toString(8));
  }
});
