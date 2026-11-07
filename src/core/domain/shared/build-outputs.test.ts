import { test } from "node:test";
import assert from "node:assert/strict";
import { installVerdict } from "./build-outputs.ts";

test("a package read at a version its install path does not lock makes the directory unusable, naming each such package", () => {
  const locked = new Map([["a", "1.0.0"], ["b", "2.0.0"]]);
  assert.deepEqual(installVerdict(locked, [{ path: "a", version: "1.0.0" }], "unused"), { usable: true, verified: true });
  assert.deepEqual(installVerdict(locked, [{ path: "c", version: "1.0.0" }, { path: "b", version: "2.1.0" }, { path: "a", version: "1.0.0" }, { path: "d", version: undefined }], "unused"), {
    usable: false,
    reason: "stale",
    stale: [{ path: "b", installed: "2.1.0", locked: "2.0.0" }, { path: "c", installed: "1.0.0" }, { path: "d" }],
  });
});

test("without a lockfile the one switch decides between using the directory unverified and leaving it unused", () => {
  const installed = [{ path: "a", version: "1.0.0" }];
  assert.deepEqual(installVerdict(undefined, installed, "use-unverified"), { usable: true, verified: false });
  assert.deepEqual(installVerdict(undefined, installed, "unused"), { usable: false, reason: "no-lockfile" });
});
