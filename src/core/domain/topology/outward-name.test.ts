import { test } from "node:test";
import assert from "node:assert/strict";
import { sortEvidence } from "./outward-name.ts";

test("one line reached two ways is two places, so the library that reached it is not lost", () => {
  const sorted = sortEvidence([
    { path: "src/app/orders.ts", line: 7, via: "com.shop.Orders" },
    { path: "src/app/orders.ts", line: 7, via: "com.shop.Events" },
  ]);

  assert.deepEqual(
    sorted.map((place) => place.via),
    ["com.shop.Orders", "com.shop.Events"],
  );
});
