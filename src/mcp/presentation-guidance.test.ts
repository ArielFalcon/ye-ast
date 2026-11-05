import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryRecovery, literalSelection } from "./presentation-guidance.ts";

test("category recovery separates recorded full facts from investigation evidence", () => {
  assert.equal(categoryRecovery({ full: "includes every origin" }), 'mode: "full" includes every origin');
  assert.equal(categoryRecovery({ details: "lists paths", full: "retains all recorded names" }), 'mode "details" lists paths; mode: "full" retains all recorded names');
});
test("literal selectors retain escaped coordinates and owner namespaces", () => {
  const select = {kind:"cut-places",owner:{kind:"read",repo:'a"b',index:2},cutIndex:3} as const;
  assert.deepEqual(JSON.parse(literalSelection(select)), select);
});

test("selection guidance agrees with schema capabilities and actual recovery availability", async () => {
  const { canSelect } = await import("./presentation-guidance.ts");
  const select = {kind:"cut-places",owner:{kind:"read",repo:"r",index:0},cutIndex:0} as const;
  assert.equal(canSelect({tool:"outline"}, select, true), false);
  assert.equal(canSelect({tool:"impact"}, select, false), false);
  assert.equal(canSelect({tool:"impact"}, select, true), true);
  assert.equal(canSelect({tool:"impact",recovery:{version:1,status:"unavailable",reason:"deadline"}},select,true),false);
});
