import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_SITE_CAUSES } from "./call-site.ts";
import { SUMMARY_CAUSES } from "./request-summary.ts";

test("a summary cause is one of the call-site causes, so no call-site cause is added or renamed", () => {
  assert.deepEqual([...SUMMARY_CAUSES].sort(), ["destination-undecidable", "dispatch-disagreement", "recursive", "source-not-read"]);
  for (const cause of SUMMARY_CAUSES) assert.ok(CALL_SITE_CAUSES.includes(cause));
});
