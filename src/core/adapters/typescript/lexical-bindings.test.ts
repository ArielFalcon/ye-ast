import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./lexical-bindings.ts", import.meta.url), "utf8");
const SYMBOL_LOOKUPS = ["getExportSpecifierLocalTargetSymbol", "getShorthandAssignmentValueSymbol", "getSymbolAtLocation"];

test("the binding resolver asks the checker only for symbols, never for a type (ADR-0026)", () => {
  const asked = [...new Set([...SOURCE.matchAll(/checker\.(\w+)/g)].map((match) => match[1]))].sort();

  assert.ok(asked.length > 0 && asked.every((method) => SYMBOL_LOOKUPS.includes(method!)), asked.join(", "));
  assert.equal(SOURCE.match(/getTypeChecker\(\)/g)?.length, 1);
  assert.deepEqual(SOURCE.match(/\.getType(?!Checker)\w*|getTypeAtLocation|getTypeOf\w*|typeToString|getSignature\w*/g), null);
});
