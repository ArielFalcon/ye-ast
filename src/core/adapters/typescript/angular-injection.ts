import ts from "typescript";
import type { RawImport } from "./module-shape.ts";
import { unwrapped } from "./syntax.ts";

export const ANGULAR_CORE = "@angular/core";

/** The names a file binds as the recognizer reads them: its imports, and how often each name is declared anywhere in it. */
export interface FileNames {
  imports: ReadonlyMap<string, RawImport>;
  declared: ReadonlyMap<string, number>;
}

/**
 * The export of `@angular/core` an expression names: `inject` for an imported `inject` under any local name, or for
 * `core.inject` through a namespace import. A name the file also declares may shadow the import, so it names none.
 */
export function angularCoreExport(expression: ts.Expression, names: FileNames): string | undefined {
  const named = unwrapped(expression);
  if (ts.isIdentifier(named)) {
    const bound = importOf(named, names);
    return bound?.module === ANGULAR_CORE && bound.imported !== "*" ? bound.imported : undefined;
  }
  if (!ts.isPropertyAccessExpression(named) || !ts.isIdentifier(named.expression)) return undefined;
  const bound = importOf(named.expression, names);
  return bound?.module === ANGULAR_CORE && bound.imported === "*" ? named.name.text : undefined;
}

/** The token an Angular `inject(…)` call asks for: its first argument. */
export function injectedToken(expression: ts.Expression, names: FileNames): ts.Expression | undefined {
  const call = unwrapped(expression);
  return ts.isCallExpression(call) && angularCoreExport(call.expression, names) === "inject" ? call.arguments[0] : undefined;
}

function importOf(name: ts.Identifier, names: FileNames): RawImport | undefined {
  return names.declared.has(name.text) ? undefined : names.imports.get(name.text);
}

/** The class an Angular `inject(X)` call asks for, by the name `X` is written with. */
export function injectedClass(expression: ts.Expression, names: FileNames): string | undefined {
  const token = injectedToken(expression, names);
  return token !== undefined && ts.isIdentifier(token) ? token.text : undefined;
}
