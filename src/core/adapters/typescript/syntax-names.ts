import ts from "typescript";

/** Every name the file binds in any scope: a variable, a parameter, a function, a class, a type or a destructured key. */
export function declaredNames(tree: ts.SourceFile): ReadonlySet<string> {
  return new Set(declarationCounts(tree).keys());
}

export function declarationCounts(tree: ts.SourceFile): Map<string, number> {
  const names = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    const name = declaredName(node);
    if (name !== undefined) names.set(name, (names.get(name) ?? 0) + 1);
    node.forEachChild(visit);
  };
  visit(tree);
  return names;
}

export function declaredName(node: ts.Node): string | undefined {
  if (
    !ts.isVariableDeclaration(node) &&
    !ts.isParameter(node) &&
    !ts.isBindingElement(node) &&
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isClassDeclaration(node) &&
    !ts.isClassExpression(node) &&
    !ts.isInterfaceDeclaration(node) &&
    !ts.isTypeAliasDeclaration(node) &&
    !ts.isEnumDeclaration(node) &&
    !ts.isModuleDeclaration(node) &&
    !ts.isTypeParameterDeclaration(node) &&
    !ts.isImportEqualsDeclaration(node)
  ) {
    return undefined;
  }
  const name = node.name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}
