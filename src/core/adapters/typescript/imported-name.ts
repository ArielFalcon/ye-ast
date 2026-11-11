import ts from "typescript";
import type { ImportedName } from "../../ports/router-vocabulary.port.ts";
import type { RawImport } from "./module-shape.ts";

export function importedNameOf(expression: ts.Expression, imports: ReadonlyMap<string, RawImport>, declared?: ReadonlyMap<string, number>, usage: "value" | "type" = "value"): ImportedName | undefined {
  const members: string[] = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) { members.unshift(current.name.text); current = current.expression; }
  if (!ts.isIdentifier(current)) return undefined;
  const binding = imports.get(current.text);
  if ((usage === "value" && binding?.typeOnly === true) || (binding !== undefined && declared?.has(current.text) === true)) return undefined;
  return { ...(binding === undefined ? {} : { binding: { module: binding.module, imported: binding.imported } }), members };
}
