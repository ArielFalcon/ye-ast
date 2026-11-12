import ts from "typescript";

/** The expression inside parentheses, type assertions and non-null, which leave its value unchanged. */
export function unwrapped(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  return inner;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

export function isStatic(member: ts.Node): boolean {
  return hasModifier(member, ts.SyntaxKind.StaticKeyword);
}

/**
 * The class whose instance `this` denotes at `node`. Arrow functions keep the `this` around them; an instance method,
 * accessor, constructor or property initializer binds it to its class; any other function, an object literal's method,
 * a static member and a static block bind it to something else, so no class answers.
 */
export function thisClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isClassLike(at)) return at;
    if (ts.isArrowFunction(at)) continue;
    if (ts.isClassStaticBlockDeclaration(at)) return undefined;
    if (ts.isPropertyDeclaration(at) && isStatic(at)) return undefined;
    if (ts.isFunctionLike(at)) {
      const member = ts.isMethodDeclaration(at) || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at) || ts.isConstructorDeclaration(at);
      return member && ts.isClassLike(at.parent) && !isStatic(at) ? at.parent : undefined;
    }
  }
  return undefined;
}

/** Whether the parser met a syntax error in the file, so its tree does not state what the source means. */
export function hasSyntaxErrors(tree: ts.SourceFile): boolean {
  return (tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0;
}

export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function typeName(node: ts.TypeNode): string | undefined {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
}

/** The parameters of a class's constructors, the parameter properties among them. */
export function constructorParameters(classDeclaration: ts.ClassDeclaration): readonly ts.ParameterDeclaration[] {
  return classDeclaration.members.flatMap((member) => (ts.isConstructorDeclaration(member) ? member.parameters : []));
}

/** Every name a binding pattern binds, through nested destructuring. */
export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

/** The expression an object literal states for a key written as a name or a string, a shorthand's name included. */
export function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    const key = property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
    if (key !== name) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
}

const OWN_BINDINGS = new WeakMap<ts.Node, ReadonlyMap<string, Binding>>();

/** A name a node itself binds: the declaration that binds it, and what it is initialized to when a variable states it. */
export interface Binding {
  declaration: ts.Node;
  initializer?: ts.Expression;
}

/**
 * The names a node itself binds, the first declaration of each winning: a block's `let`, `const`, functions and
 * classes, a function's parameters and the `var`s of its body, a named function or class expression, a catch clause's
 * variable, a loop's variables.
 */
export function ownBindings(node: ts.Node): ReadonlyMap<string, Binding> {
  const cached = OWN_BINDINGS.get(node);
  if (cached !== undefined) return cached;
  const own = new Map<string, Binding>();
  const bind = (name: ts.BindingName, declaration: ts.Node, initializer?: ts.Expression): void => {
    for (const text of bindingNames(name)) {
      if (!own.has(text)) own.set(text, ts.isIdentifier(name) && initializer !== undefined ? { declaration, initializer } : { declaration });
    }
  };
  if (ts.isBlock(node) || ts.isCaseBlock(node)) {
    const statements = ts.isBlock(node) ? node.statements : node.clauses.flatMap((clause) => [...clause.statements]);
    for (const statement of statements) {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) for (const declaration of statement.declarationList.declarations) bind(declaration.name, declaration, declaration.initializer);
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) bind(statement.name, statement);
    }
  }
  if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name !== undefined) bind(node.name, node);
  if ((ts.isFunctionLike(node) && "parameters" in node) || ts.isClassStaticBlockDeclaration(node)) {
    if ("parameters" in node) for (const parameter of node.parameters) bind(parameter.name, parameter);
    const visitVar = (child: ts.Node): void => {
      if (ts.isFunctionLike(child) || ts.isClassLike(child) || ts.isModuleDeclaration(child)) return;
      if (ts.isVariableDeclarationList(child) && (child.flags & ts.NodeFlags.BlockScoped) === 0) for (const declaration of child.declarations) bind(declaration.name, declaration);
      ts.forEachChild(child, visitVar);
    };
    if ("body" in node && node.body !== undefined) visitVar(node.body);
  }
  if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) bind(node.variableDeclaration.name, node.variableDeclaration);
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
    for (const declaration of node.initializer.declarations) bind(declaration.name, declaration, declaration.initializer);
  }
  OWN_BINDINGS.set(node, own);
  return own;
}

/** The names the file binds at run time; an ambient `declare` binds none. */
export function sourceBindings(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (isAmbient(statement)) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) names.add(name);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name !== undefined) names.add(statement.name.text);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node) || isAmbient(node)) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) for (const declaration of node.declarations) for (const name of bindingNames(declaration.name)) names.add(name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isAmbient(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DeclareKeyword);
}

/** The object literal an initializer is, through the wrappers TypeScript lets an author write around it. */
export function objectOf(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isTypeAssertionExpression(expression)) return objectOf(expression.expression);
  return undefined;
}

/** The name a property name denotes: an identifier, a literal, or a literal in brackets. Undefined where it is computed from anything else. */
export function propertyNameText(name: ts.PropertyName): string | undefined {
  if (!ts.isComputedPropertyName(name)) return name.text;
  const key = unwrapped(name.expression);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

export function hasKnownPropertyNames(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.every((property) => !ts.isSpreadAssignment(property) && propertyNameText(property.name) !== undefined);
}
