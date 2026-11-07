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
