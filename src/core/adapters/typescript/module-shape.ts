import ts from "typescript";
import { defaultExportOf, moduleStatement } from "./import-bindings.ts";
import { hasModifier, hasSyntaxErrors } from "./syntax.ts";

/** The lines a declaration spans in its file. */
export interface RawSpan {
  line: number;
  endLine: number;
}

/**
 * What a module exports under one name: a name it declares or imports, or another module's export it re-exports.
 * `{ local: "default" }` is a default export that declares no name (`export default {}`, `export default class {}`):
 * `default` is a reserved word, so no declaration or import can hold it.
 */
export type RawExport = { local: string } | { module: string; imported: string };

export const ANONYMOUS_DEFAULT = "default";

/** What an import brings in: the module it names and the export it takes there (`default` for a default import, `*` for a namespace). */
export interface RawImport {
  module: string;
  imported: string;
  /** The import binds a type only, so no value exists under the name at run time. */
  typeOnly?: true;
}

/** What a file imports, declares and exports at its top level, as its syntax states it. */
export interface ModuleShape {
  /** Local name → the module and the export of each import; the last import of a name wins. */
  imports: Map<string, RawImport>;
  /** The local names more than one import binds. */
  reimported: ReadonlySet<string>;
  /** The names this file declares at its top level, with the span of each. */
  declared: Map<string, RawSpan>;
  classes: Set<string>;
  /** What the file exports, by exported name, and the modules it re-exports whole (`export * from`). */
  exports: Map<string, RawExport>;
  stars: string[];
}

/** The one reading of a file's imports, top-level declarations and exports; undefined when the file has syntax errors. */
export function moduleShape(tree: ts.SourceFile): ModuleShape | undefined {
  return hasSyntaxErrors(tree) ? undefined : recoveredModuleShape(tree);
}

/** `moduleShape` for a reader that reads a file with syntax errors as far as the parser recovered it. */
export function recoveredModuleShape(tree: ts.SourceFile): ModuleShape {
  const line = (pos: number): number => tree.getLineAndCharacterOfPosition(pos).line + 1;
  const reimported = new Set<string>();
  const shape: ModuleShape = { imports: new Map(), reimported, declared: new Map(), classes: new Set(), exports: new Map(), stars: [] };
  const bind = (local: string, module: string, imported: string, typeOnly: boolean): void => {
    if (shape.imports.has(local)) reimported.add(local);
    shape.imports.set(local, { module, imported, ...(typeOnly ? { typeOnly: true as const } : {}) });
  };
  const declare = (name: ts.Identifier, statement: ts.Statement, node: ts.Node = statement): void => {
    shape.declared.set(name.text, { line: line(name.getStart(tree)), endLine: line(node.end) });
    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && defaultExportOf(statement) === undefined) shape.exports.set(name.text, { local: name.text });
  };
  for (const statement of tree.statements) {
    const held = defaultExportOf(statement);
    if (held !== undefined) shape.exports.set("default", { local: ts.isIdentifier(held) ? held.text : ts.isExpression(held) ? ANONYMOUS_DEFAULT : (held.name?.text ?? ANONYMOUS_DEFAULT) });
    const read = moduleStatement(statement, tree);
    if (read !== undefined) {
      if (read.specifier === undefined || read.form === "import-equals") continue;
      for (const binding of read.bindings) {
        if (read.kind === "import") bind(binding.local!, read.specifier, binding.imported, binding.typeOnly);
        else if (binding.local === undefined) shape.stars.push(read.specifier);
        else if (binding.imported !== "*") shape.exports.set(binding.local, { module: read.specifier, imported: binding.imported });
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) shape.exports.set(element.name.text, { local: (element.propertyName ?? element.name).text });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) declare(declaration.name, statement, declaration);
    } else if (ts.isEnumDeclaration(statement)) {
      declare(statement.name, statement);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declare(statement.name, statement);
      if (ts.isClassDeclaration(statement)) shape.classes.add(statement.name.text);
    }
  }
  return shape;
}
