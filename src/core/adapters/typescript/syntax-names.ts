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

/**
 * The declarations of the innermost type scope around a type name that declares it: a type parameter, an `infer` of the
 * conditional whose true branch holds the name, a mapped type's key, or a declaration among the statements of an
 * enclosing block, namespace or the file. None when no scope declares it, so the file's imports and the globals answer.
 */
export function typeScopeOf(name: ts.Identifier): ts.Node[] | undefined {
  let inner: ts.Node = name;
  for (let scope = name.parent; scope !== undefined; inner = scope, scope = scope.parent) {
    const declared: ts.Node[] = [];
    if ("typeParameters" in scope) for (const parameter of (scope.typeParameters as ts.NodeArray<ts.TypeParameterDeclaration> | undefined) ?? []) if (parameter.name.text === name.text) declared.push(parameter);
    if (ts.isMappedTypeNode(scope) && scope.typeParameter.name.text === name.text) declared.push(scope.typeParameter);
    if (ts.isConditionalTypeNode(scope) && inner === scope.trueType) declared.push(...inferredIn(scope.extendsType, name.text));
    if (ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isSourceFile(scope)) declared.push(...scope.statements.filter((statement) => typeDeclarationName(statement) === name.text));
    if (declared.length > 0) return declared;
  }
  return undefined;
}

function inferredIn(node: ts.Node, name: string): ts.TypeParameterDeclaration[] {
  if (ts.isInferTypeNode(node)) return node.typeParameter.name.text === name ? [node.typeParameter] : [];
  return node.getChildren().flatMap((child) => inferredIn(child, name));
}

/** The name a statement declares a type, function or namespace under. */
export function typeDeclarationName(statement: ts.Statement): string | undefined {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) return statement.name.text;
  if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name !== undefined) return statement.name.text;
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) return statement.name.text;
  return undefined;
}
