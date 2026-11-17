import { test } from "node:test";
import assert from "node:assert/strict";
import { containsSecrets, sanitizeText } from "./pattern-redaction.adapter.ts";

const BASE_LENGTH = 25_000;
const FLOOR_MS = 5;
const MAX_GROWTH = 8;

const BASE64_LOOKING = "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3a";

/** One long unbroken input per shape; each pins the pattern that rescans the same run from every start. */
const SHAPES: Array<{ name: string; unit: string; prefix?: string }> = [
  { name: "a long identifier run after a path", unit: "a", prefix: "/x/y/" },
  { name: "a keyword repeated inside one run", unit: "password" },
  { name: "dotted words that never reach an at sign", unit: "a." },
  { name: "a token prefix repeated without dots", unit: "eyJ" },
  { name: "an upper-case credential keyword repeated", unit: "KEY" },
  { name: "a data prefix repeated without a semicolon", unit: "data:" },
  { name: "base64-looking segments of one dotted path", unit: `${BASE64_LOOKING}.` },
  { name: "long words joined by underscores", unit: "someVeryLongCamelCaseIdentifierNameThatIsFortyChars_" },
  { name: "private key headers repeated without an end", unit: "-----BEGIN A PRIVATE KEY-----" },
];

function build(shape: { unit: string; prefix?: string }, length: number): string {
  return `${shape.prefix ?? ""}${shape.unit.repeat(Math.ceil(length / shape.unit.length))}1`;
}

function bestOf(runs: number, work: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

for (const shape of SHAPES) {
  test(`redaction time grows linearly with the input: ${shape.name}`, () => {
    const small = build(shape, BASE_LENGTH);
    const large = build(shape, BASE_LENGTH * 4);
    for (const [label, redact] of [["sanitizeText", (text: string) => sanitizeText(text, "model")], ["containsSecrets", (text: string) => containsSecrets(text, "model")]] as const) {
      const before = bestOf(3, () => redact(small));
      const after = bestOf(3, () => redact(large));
      assert.ok(after <= MAX_GROWTH * Math.max(before, FLOOR_MS), `${label}: ${before.toFixed(1)} ms at ${small.length} characters, ${after.toFixed(1)} ms at ${large.length}`);
    }
  });
}
