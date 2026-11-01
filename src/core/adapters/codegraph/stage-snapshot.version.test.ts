import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { STAGING_RULES_VERSION } from "./stage-snapshot.ts";

const SOURCE_DIGEST_BY_VERSION: Readonly<Record<string, string>> = {
  "2": "f29f8d32090e597644690359faa6980a333ad5cd4a8fda42936cf2a9a62d724e",
  "3": "d8d50ff0b543684a228e16e9c3ed080de1196216a17502f2dab54444618e3896",
  "4": "a4dbe978ca40342805ba6b4b1bb275504f95284bdd8f5f773aa227d724c823ee",
  "5": "fd3e59335f900aba40f6b7c251e0d7cef55a74ff3ae14df8775d8eeba87f92f8",
};

const INDEX_BUILDING_SOURCES = ["./stage-snapshot.ts", "./index-snapshot.child.ts", "./sync-mirror.child.ts", "./codegraph.adapter.ts", "../../ports/staging-rules.ts"];

test("the staging rules version changes whenever the code that stages or builds an index does", () => {
  const hash = createHash("sha256");
  for (const source of INDEX_BUILDING_SOURCES) hash.update(readFileSync(new URL(source, import.meta.url)));
  const digest = hash.digest("hex");

  assert.equal(digest, SOURCE_DIGEST_BY_VERSION[STAGING_RULES_VERSION], "the index-building sources changed: bump STAGING_RULES_VERSION and record the new digest");
});
