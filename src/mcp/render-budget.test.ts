import { test } from "node:test";
import { strict as assert } from "node:assert";
import { boundedText } from "./render-budget.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

const fact = { status: "complete", value: {}, snapshot: {} } as unknown as Fact<object>;
const context = { tool: "entrypoints" } as const;
const render = (_fact: Fact<object>, mode: string) => mode === "summary" ? "é".repeat(1500) : "x".repeat(10000);

test("a bound chooses a complete summary with its note or refuses", () => {
  const result = boundedText(render, fact, "details", context, { bytes: 4000 });
  assert.equal(result.kind, "text");
  if (result.kind !== "text") return;
  assert.ok(result.text.startsWith("é".repeat(1500)));
  assert.ok(Buffer.byteLength(result.text) <= 4000);
  assert.equal(boundedText(render, fact, "details", context, { bytes: 3000 }).kind, "refused");
  assert.equal(boundedText(render, fact, "details", context, { bytes: 0 }).kind, "refused");
  assert.deepEqual(boundedText(render, fact, "details", context, undefined), { kind: "text", text: "x".repeat(10000) });
});
