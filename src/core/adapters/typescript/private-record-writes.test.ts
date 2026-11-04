import { test } from "node:test";
import assert from "node:assert/strict";
import { createAngularMetadataReader } from "./angular-metadata.adapter.ts";

async function proofs(source: string) {
  return createAngularMetadataReader().read([
    { path: "package.json", content: JSON.stringify({ dependencies: { "@angular/core": "22.2.4" } }) },
    { path: "src/store.ts", content: "export class Store { start() {} }" },
    { path: "src/owner.ts", content: "import { inject } from '@angular/core'; import { Store } from './store'; export function launch() { inject(Store).start(); }" },
    { path: "src/scratch.ts", content: source },
  ], { memberProofs: { completeSource: true } });
}

test("a private null-prototype record with literal writes cannot mutate the injected receiver", async () => {
  const result = await proofs("export function scratch() { const record = { __proto__: null }; record['entry'] = 1; }");
  assert.equal(result.memberUses?.length, 1);
  assert.equal(result.memberUses?.[0]?.receiver.symbol, "Store");
});

test("a private record dot write does not poison an unrelated method by spelling", async () => {
  const result = await proofs("export function scratch() { const record = { __proto__: null }; record.start = 1; }");
  assert.equal(result.memberUses?.length, 1);
});

test("an unrelated write sharing the class spelling does not imply class binding mutation", async () => {
  for (const source of [
    "export function change(Store: unknown, replacement: unknown) { Store = replacement; }",
    "export function change(other: any) { other.Store = 1; }",
    "import type { Store } from './store'; export function change(other: any, replacement: any) { (other as Store) = replacement; }",
  ]) assert.equal((await proofs(source)).memberUses?.length, 1, source);
});

test("record escapes, captures, shadows, reads and unknown keys retain mutation uncertainty", async () => {
  for (const body of [
    "const record = {}; record['entry'] = 1;",
    "const record = { __proto__: null }; record[key] = 1;",
    "const record = { __proto__: null }; const alias = record; record['entry'] = 1;",
    "const record = { __proto__: null }; record['entry'] = 1; return record;",
    "const record = { __proto__: null }; expose(record); record['entry'] = 1;",
    "const record = { __proto__: null }; const write = () => { record['entry'] = 1; }; write();",
    "const record = { __proto__: null }; { const record = external; record['entry'] = 1; }",
    "const record = { __proto__: null }; record['entry'] = 1; consume(record['entry']);",
    "let record = { __proto__: null }; record['entry'] = 1;",
    "const record = { __proto__: null, ...external }; record['entry'] = 1;",
    "const record = { __proto__: null }; record['__proto__'] = external;",
    "const record = { __proto__: null }; record['entry'] += external;",
    "const record = { __proto__: null }; record['entry'] = (external['start'] = replacement);",
    "const record = { __proto__: null }; record['entry'] = 1; Reflect.set(external, 'start', replacement);",
  ]) {
    const result = await proofs(`export function scratch(key: unknown, external: any) { ${body} }`);
    assert.deepEqual(result.memberUses, [], body);
  }
});
