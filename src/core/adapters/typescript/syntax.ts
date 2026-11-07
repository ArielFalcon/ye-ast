import ts from "typescript";
import { isStatic } from "./syntax-names.ts";

/** The expression inside parentheses, type assertions and non-null, which leave its value unchanged. */
export function unwrapped(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  return inner;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
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
