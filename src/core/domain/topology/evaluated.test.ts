import { test } from "node:test";
import assert from "node:assert/strict";
import { reachedDiagnostic, undecided, undecidedTarget } from "./evaluated.ts";

test("recursion prevails over disagreement, which prevails over the first cause a reading states", () => {
  const recursive = { cause: "recursive" as const };
  const disagreeing = { cause: "dispatch-disagreement" as const };
  const undecidable = { cause: "destination-undecidable" as const };
  assert.equal(reachedDiagnostic([disagreeing, recursive], true, false).cause, "recursive");
  assert.equal(reachedDiagnostic([undecidable, disagreeing], true, false).cause, "dispatch-disagreement");
  assert.equal(reachedDiagnostic([undecidable, undecidable], false, false).cause, "dispatch-disagreement");
  assert.equal(reachedDiagnostic([{ cause: "source-not-read" }, undecidable], true, false).cause, "source-not-read");
});

test("an undecided value is reported unknown at the call, then where it stopped once, with its cause and sorted alternatives", () => {
  const call = { path: "src/Orders.java", line: 12, endLine: 14 };
  const stop = { path: "src/Urls.java", line: 3 };
  const why = undecided("recursive", [{ path: "src/Orders.java", line: 12, endLine: 13 }, stop], ["http://b", "http://a", "http://b"]);
  assert.deepEqual(undecidedTarget(why, call), {
    target: { status: "unknown", reason: "unresolved", evidence: [call, stop] },
    diagnostic: { cause: "recursive", alternatives: ["http://a", "http://b"] },
  });
  assert.deepEqual(undecidedTarget(undecided("destination-undecidable"), call).diagnostic, { cause: "destination-undecidable" });
});
