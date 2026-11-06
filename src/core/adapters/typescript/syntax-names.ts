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

function declaredName(node: ts.Node): string | undefined {
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

/** The names a script's top-level statements declare, the bindings of its variable statements included: in a file with no import or export they are global. */
export function scriptGlobalNames(tree: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  for (const statement of tree.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bind(declaration.name);
    else {
      const name = declaredName(statement);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

export function isStatic(member: ts.Node): boolean {
  return ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}
