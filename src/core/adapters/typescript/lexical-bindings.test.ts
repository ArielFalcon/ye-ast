import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { bindFile } from "./lexical-bindings.ts";

const SOURCE = readFileSync(new URL("./lexical-bindings.ts", import.meta.url), "utf8");
const SYMBOL_LOOKUPS = ["getExportSpecifierLocalTargetSymbol", "getShorthandAssignmentValueSymbol", "getSymbolAtLocation"];

test("the binding resolver asks the checker only for symbols, never for a type (ADR-0029)", () => {
  const asked = [...new Set([...SOURCE.matchAll(/checker\.(\w+)/g)].map((match) => match[1]))].sort();

  assert.ok(asked.length > 0 && asked.every((method) => SYMBOL_LOOKUPS.includes(method!)), asked.join(", "));
  assert.equal(SOURCE.match(/getTypeChecker\(\)/g)?.length, 1);
  assert.deepEqual(SOURCE.match(/\.getType(?!Checker|Count)\w*|getTypeAtLocation|getTypeOf\w*|typeToString|getSignature\w*/g), null);
});

test("asking every name of a file what it binds creates no type, whatever position the name holds (ADR-0029)", () => {
  const bound = bindFile("src/positions.tsx", [
    "export function run(callback: () => void, props: { callback: number }) {",
    "  const { callback: value } = { callback: () => 1 };",
    "  const { props: [first] } = { props: [props] };",
    "  const element = <div callback={callback} />;",
    "  type Alias = typeof props.callback;",
    "  label: for (const key in props) { if (key) break label; }",
    "  return [value, first, element, props.callback, new.target, import.meta] as unknown as Alias;",
    "}",
  ].join("\n"));
  const before = bound.typeCount();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) bound.bindingOf(node);
    node.forEachChild(visit);
  };

  visit(bound.tree);

  assert.equal(bound.typeCount(), before);
});
