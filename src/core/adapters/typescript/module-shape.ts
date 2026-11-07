import ts from "typescript";
import { moduleStatement } from "./import-bindings.ts";
import { hasModifier } from "./syntax.ts";

/** The lines a declaration spans in its file. */
export interface RawSpan {
  line: number;
  endLine: number;
}

/** What a module exports under one name: a name it declares or imports, or another module's export it re-exports. */
export type RawExport = { local: string } | { module: string; imported: string };

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
  const diagnostics = (tree as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return undefined;
  const line = (pos: number): number => tree.getLineAndCharacterOfPosition(pos).line + 1;
  const reimported = new Set<string>();
  const shape: ModuleShape = { imports: new Map(), reimported, declared: new Map(), classes: new Set(), exports: new Map(), stars: [] };
  const bind = (local: string, module: string, imported: string, typeOnly: boolean): void => {
    if (shape.imports.has(local)) reimported.add(local);
    shape.imports.set(local, { module, imported, ...(typeOnly ? { typeOnly: true as const } : {}) });
  };
  const declare = (name: ts.Identifier, statement: ts.Statement, node: ts.Node = statement): void => {
    shape.declared.set(name.text, { line: line(name.getStart(tree)), endLine: line(node.end) });
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return;
    shape.exports.set(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : name.text, { local: name.text });
  };
  for (const statement of tree.statements) {
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
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals && ts.isIdentifier(statement.expression)) shape.exports.set("default", { local: statement.expression.text });
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
