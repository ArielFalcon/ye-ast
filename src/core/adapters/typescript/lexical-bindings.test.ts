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
    "  const { other = callback } = {} as { other?: () => void };",
    "  const element = <div callback={callback} />;",
    "  type Alias = typeof props.callback;",
    "  label: for (const key in props) { if (key) break label; }",
    "  return [value, first, other, element, props.callback, new.target, import.meta] as unknown as Alias;",
    "}",
    "export { run as start };",
    "function sloppy(scope: object) { with (scope) { run; } }",
  ].join("\n"));
  const before = bound.typeCount();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) bound.bindingOf(node);
    node.forEachChild(visit);
  };

  visit(bound.tree);

  assert.equal(bound.typeCount(), before);
});

function declarationLine(path: string, lines: readonly string[], name: string, nth: number): number | undefined {
  const bound = bindFile(path, lines.join("\n"));
  const named: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) named.push(node);
    node.forEachChild(visit);
  };
  visit(bound.tree);
  const binding = bound.bindingOf(named[nth]!);
  return binding.kind === "declared" ? bound.tree.getLineAndCharacterOfPosition(binding.declarations[0]!.getStart(bound.tree)).line + 1 : undefined;
}

test("a destructuring default reads the binding it names, while the key and the bound name are no read", () => {
  const lines = ["const fallback = 1;", "function run(fallback: number) {", "  const { fallback: kept = fallback } = {} as { fallback?: number };", "  return kept;", "}"];

  assert.equal(declarationLine("src/defaults.ts", lines, "fallback", 3), 2);
  assert.equal(declarationLine("src/defaults.ts", lines, "fallback", 2), undefined);
});

test("an export specifier reads its local binding", () => {
  assert.equal(declarationLine("src/exports.ts", ["const held = 1;", "export { held as shared };"], "held", 1), 1);
});

test("a name read in the body of a with statement is dynamic, while its object expression keeps its binding", () => {
  const bound = bindFile("src/scope.js", ["var obj = {};", "var held = 1;", "with (obj) { held; }"].join("\n"));
  const names = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.set(node.text, [...(names.get(node.text) ?? []), node]);
    node.forEachChild(visit);
  };
  visit(bound.tree);

  assert.equal(bound.bindingOf(names.get("held")![1]!).kind, "dynamic");
  assert.equal(bound.bindingOf(names.get("obj")![1]!).kind, "declared");
});
