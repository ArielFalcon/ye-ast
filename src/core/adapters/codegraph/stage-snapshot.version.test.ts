import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { STAGING_RULES_VERSION } from "./stage-snapshot.ts";

const SOURCE_DIGEST_BY_VERSION: Readonly<Record<string, string>> = {
  "10": "add456f6e3137870aad923a72255e992c69ba2d2a3f0270ab365fd8c33290ebe",
  "2": "f29f8d32090e597644690359faa6980a333ad5cd4a8fda42936cf2a9a62d724e",
  "3": "d8d50ff0b543684a228e16e9c3ed080de1196216a17502f2dab54444618e3896",
  "4": "a4dbe978ca40342805ba6b4b1bb275504f95284bdd8f5f773aa227d724c823ee",
  "5": "fd3e59335f900aba40f6b7c251e0d7cef55a74ff3ae14df8775d8eeba87f92f8",
  "6": "a8c09d6b64608d7e3027d71b94019507b866260fdd92c2c2c1d92506796a87e9",
  "7": "4a194e5800822fc8991a069836108131d20c047a1902b314e8e9e8bdcc3df078",
  "8": "5fdf3273371fcca7ef4f3ce8fed93e7935ca1cd909495991a736b8eecb776654",
  "9": "768a265f7b56105d86c2515f4b29aee7ab7b6ed7d094773bc5e00b225636613e",
};

const INDEX_BUILDING_SOURCES = ["./stage-snapshot.ts", "./index-snapshot.child.ts", "./sync-mirror.child.ts", "./codegraph.adapter.ts", "../../ports/staging-rules.ts"];

test("the staging rules version changes whenever the code that stages or builds an index does", () => {
  const hash = createHash("sha256");
  for (const source of INDEX_BUILDING_SOURCES) hash.update(readFileSync(new URL(source, import.meta.url)));
  const digest = hash.digest("hex");

  assert.equal(digest, SOURCE_DIGEST_BY_VERSION[STAGING_RULES_VERSION], "the index-building sources changed: bump STAGING_RULES_VERSION and record the new digest");
});
