import ts from "typescript";
import { hasModifier } from "./syntax.ts";
import type { ModuleBinding, ModuleDependency } from "../../domain/impact/module-dependency.ts";

/** One import, `import x = …` or re-export statement as its syntax states it. */
export interface ModuleStatement {
  kind: ModuleDependency["kind"];
  typeOnly: boolean;
  form?: "import-equals";
  /** The module the statement names; absent when it names none by a string literal. */
  specifier?: string;
  bindings: ModuleBinding[];
}

/**
 * The one reading of a module statement's syntax: what it names and the names it binds. A local `export { … }` names no
 * module and is not a module statement.
 */
export function moduleStatement(statement: ts.Statement, tree: ts.SourceFile): ModuleStatement | undefined {
  const binding = (name: ts.Node, imported: string, typeOnly: boolean, local?: string): ModuleBinding => {
    const { line, character } = tree.getLineAndCharacterOfPosition(name.getStart(tree));
    return { ...(local === undefined ? {} : { local }), imported, line: line + 1, column: character + 1, typeOnly };
  };
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const typeOnly = clause?.isTypeOnly === true;
    const bindings: ModuleBinding[] = [];
    if (clause?.name !== undefined) bindings.push(binding(clause.name, "default", typeOnly, clause.name.text));
    const named = clause?.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) bindings.push(binding(named.name, "*", typeOnly, named.name.text));
    else if (named !== undefined) for (const element of named.elements) bindings.push(binding(element.name, (element.propertyName ?? element.name).text, typeOnly || element.isTypeOnly, element.name.text));
    return {
      kind: "import",
      typeOnly: typeOnly || (clause?.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly)),
      ...specifierOf(statement.moduleSpecifier),
      bindings,
    };
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.moduleSpecifier === undefined) return undefined;
    const clause = statement.exportClause;
    const typeOnly = statement.isTypeOnly;
    const bindings = clause === undefined
      ? [binding(statement, "*", typeOnly)]
      : ts.isNamespaceExport(clause)
        ? [binding(clause.name, "*", typeOnly, clause.name.text)]
        : clause.elements.map((element) => binding(element.propertyName ?? element.name, (element.propertyName ?? element.name).text, typeOnly || element.isTypeOnly, element.name.text));
    return {
      kind: "reexport",
      typeOnly: typeOnly || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)),
      ...specifierOf(statement.moduleSpecifier),
      bindings,
    };
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    const reference = statement.moduleReference;
    return {
      kind: "import",
      typeOnly: statement.isTypeOnly,
      form: "import-equals",
      ...(ts.isExternalModuleReference(reference) ? specifierOf(reference.expression) : {}),
      bindings: [binding(statement.name, "*", statement.isTypeOnly, statement.name.text)],
    };
  }
  return undefined;
}

function specifierOf(expression: ts.Expression): { specifier?: string } {
  return ts.isStringLiteral(expression) ? { specifier: expression.text } : {};
}

/** The value a statement exports as default: what `export default` holds, or the class or function it declares. */
export function defaultExportOf(statement: ts.Node): ts.Expression | ts.ClassDeclaration | ts.FunctionDeclaration | undefined {
  if (ts.isExportAssignment(statement)) return statement.isExportEquals ? undefined : statement.expression;
  const declares = (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && hasModifier(statement, ts.SyntaxKind.ExportKeyword) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  return declares ? statement : undefined;
}

/** The name of the declaration a file exports as default, when that export is a named declaration. */
export function defaultDeclarationName(tree: ts.SourceFile): string | undefined {
  const held = tree.statements.map(defaultExportOf).find((value) => value !== undefined);
  return held === undefined || ts.isExpression(held) ? undefined : held.name?.text;
}
