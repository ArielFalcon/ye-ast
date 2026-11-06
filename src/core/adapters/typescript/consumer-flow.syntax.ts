import ts from "typescript";
import { ELEMENT, type AccessPath } from "../../domain/contracts/access-path.ts";
import type { JsonValue, Literal, Replacement } from "../../domain/contracts/use-operation.ts";

export type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;

export function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** A function the code names, and the node whose first line is where the function is declared. */
export interface NamedFunction {
  node: FunctionNode;
  name: string;
  declaration: ts.Node;
}

export function namedFunction(node: FunctionNode): NamedFunction | undefined {
  if (ts.isConstructorDeclaration(node)) return { node, name: "constructor", declaration: node };
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const holder = node.parent;
    if ((ts.isVariableDeclaration(holder) || ts.isPropertyDeclaration(holder)) && holder.initializer === node && ts.isIdentifier(holder.name)) return { node, name: holder.name.text, declaration: holder };
    return ts.isFunctionExpression(node) && node.name !== undefined ? { node, name: node.name.text, declaration: node } : undefined;
  }
  return node.name !== undefined && ts.isIdentifier(node.name) ? { node, name: node.name.text, declaration: node } : undefined;
}

export function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) if (isFunctionNode(current)) return current;
  return undefined;
}

export function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) if (ts.isClassLike(current)) return current;
  return undefined;
}

export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

export function isTransparent(node: ts.Node): boolean {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}

function jsonOf(expression: ts.Expression): JsonValue | undefined {
  const bare = unwrap(expression);
  if (bare.kind === ts.SyntaxKind.NullKeyword) return null;
  const literal = literalOf(bare);
  if (literal !== undefined) return literal;
  if (ts.isArrayLiteralExpression(bare)) {
    const items = bare.elements.map(jsonOf);
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  if (!ts.isObjectLiteralExpression(bare)) return undefined;
  const entries = bare.properties.map((property): [string, JsonValue] | undefined => {
    if (!ts.isPropertyAssignment(property)) return undefined;
    const name = property.name;
    const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : ts.isNumericLiteral(name) ? String(Number(name.text)) : undefined;
    const value = jsonOf(property.initializer);
    return key === undefined || value === undefined ? undefined : [key, value];
  });
  return entries.every((entry) => entry !== undefined) ? Object.fromEntries(entries) : undefined;
}

/** What a fallback's right side puts in place of the value: the JSON it writes literally, else opaque. */
export function replacementOf(expression: ts.Expression): Replacement {
  const value = jsonOf(expression);
  return value === undefined ? { kind: "opaque" } : { kind: "literal", value };
}

export function isAsyncOrGenerator(fn: FunctionNode): "async" | "generator" | undefined {
  if (ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true) return "async";
  return "asteriskToken" in fn && fn.asteriskToken !== undefined ? "generator" : undefined;
}

/** A place that only tests or drops the value it holds, so no guard there decides anything. */
export function discardsValue(top: ts.Expression): boolean {
  const parent = top.parent;
  if (ts.isConditionalExpression(parent)) return parent.condition === top;
  if (ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) return true;
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === top;
  if (ts.isForStatement(parent)) return parent.condition === top;
  if (!ts.isBinaryExpression(parent)) return false;
  const operator = parent.operatorToken.kind;
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.EqualsToken) return parent.left === top;
  return operator === ts.SyntaxKind.InstanceOfKeyword;
}

/** The literal an expression is written as directly: a string, a number with its sign, `true` or `false`. */
export function literalOf(expression: ts.Expression): Literal | undefined {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) return -Number(expression.operand.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

const NUMERIC_UNARY: ReadonlySet<ts.PrefixUnaryOperator> = new Set([ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.TildeToken, ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]);

export function isNumericUnary(node: ts.Node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  return ts.isPostfixUnaryExpression(node) || (ts.isPrefixUnaryExpression(node) && NUMERIC_UNARY.has(node.operator));
}

export function isNullishLiteral(expression: ts.Expression): boolean {
  const bare = unwrap(expression);
  return bare.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(bare) && bare.text === "undefined");
}

export type Binding = { kind: "name"; name: string; scope: ts.Node } | { kind: "member"; name: string; scope: ts.ClassLikeDeclaration };

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

export function declaresName(node: ts.Node, name: string): boolean {
  if (isFunctionNode(node)) return node.parameters.some((parameter) => bindingNames(parameter.name).includes(name)) || ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name);
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) return statementsDeclare(node.statements, name);
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return statementsDeclare(node.statements, name);
  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const initializer = node.initializer;
    return initializer !== undefined && ts.isVariableDeclarationList(initializer) && initializer.declarations.some((declaration) => bindingNames(declaration.name).includes(name));
  }
  if (ts.isCatchClause(node)) return node.variableDeclaration !== undefined && bindingNames(node.variableDeclaration.name).includes(name);
  return false;
}

function statementsDeclare(statements: readonly ts.Statement[], name: string): boolean {
  return statements.some(
    (statement) =>
      (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => bindingNames(declaration.name).includes(name))) ||
      ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name),
  );
}

/** The nearest scope above `node` that declares `name`, the file when none does. */
export function declaringScope(node: ts.Identifier): ts.Node {
  let current: ts.Node = node;
  while (current.parent !== undefined) {
    current = current.parent;
    if (declaresName(current, node.text)) return current;
  }
  return current;
}

/** The scope of the names a variable declaration binds. */
export function declaredScope(declaration: ts.VariableDeclaration): ts.Node {
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return declaration.parent;
  const holder = list.parent;
  return ts.isVariableStatement(holder) ? holder.parent : holder;
}

const ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function isWriteTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isBinaryExpression(parent) && parent.left === node && ASSIGNMENTS.has(parent.operatorToken.kind);
}

function isValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== node;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
  if (ts.isArrowFunction(parent)) return parent.body === node;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent)) return parent.initializer === node;
  if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return false;
  if (ts.isBindingElement(parent)) return parent.initializer === node;
  if (ts.isImportSpecifier(parent) || ts.isQualifiedName(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return !isWriteTarget(node);
}

function shadows(node: ts.Node, binding: Binding): boolean {
  if (binding.kind === "name") return declaresName(node, binding.name);
  return ts.isClassLike(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
}

function isReference(node: ts.Node, binding: Binding): boolean {
  if (binding.kind === "name") return ts.isIdentifier(node) && node.text === binding.name && isValueIdentifier(node);
  return ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === binding.name && !isWriteTarget(node);
}

/** The expressions that read a binding, in source order, without the scopes that declare the name again. */
export function referencesOf(binding: Binding): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (isReference(node, binding)) {
      found.push(node as ts.Expression);
      return;
    }
    if (shadows(node, binding)) return;
    node.forEachChild(visit);
  };
  binding.scope.forEachChild(visit);
  return found;
}

/** A write to a binding or to a path below it: the assigned or deleted expression, as a path from the binding. */
export interface Write {
  node: ts.Node;
  path: AccessPath;
}

/** The writes to `binding` inside `root` that end after `from` and before `to`, in source order. */
export function writesWithin(root: ts.Node, binding: Binding, from: number, to: number): Write[] {
  const found: Write[] = [];
  const visit = (node: ts.Node): void => {
    if (node.end <= from || node.pos >= to || ts.isTypeNode(node) || shadows(node, binding)) return;
    const target = ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind) ? node.left : ts.isDeleteExpression(node) ? node.expression : undefined;
    const path = target === undefined ? undefined : chainPath(target, binding);
    if (path !== undefined && node.pos >= from && node.end <= to) found.push({ node, path });
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return found;
}

const CONDITIONAL_PARENTS = (node: ts.Node): boolean =>
  ts.isIfStatement(node) ||
  ts.isIterationStatement(node, false) ||
  ts.isSwitchStatement(node) ||
  ts.isCaseClause(node) ||
  ts.isDefaultClause(node) ||
  ts.isTryStatement(node) ||
  ts.isCatchClause(node) ||
  ts.isConditionalExpression(node) ||
  isFunctionNode(node) ||
  (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind));

/** Whether `later` may run without `earlier` having run before it, or not run after it, within one function. */
export function mayNotFollow(earlier: ts.Node, later: ts.Node): boolean {
  const above = new Set<ts.Node>();
  for (let current: ts.Node | undefined = earlier; current !== undefined; current = current.parent) above.add(current);
  let current: ts.Node = later;
  while (!above.has(current)) {
    if (CONDITIONAL_PARENTS(current)) return true;
    current = current.parent;
  }
  return CONDITIONAL_PARENTS(current) && current !== earlier;
}

/** The loop between `node` and `scope` that contains `node`, when there is one. */
export function enclosingLoop(node: ts.Node, scope: ts.Node): ts.IterationStatement | undefined {
  for (let current = node.parent; current !== undefined && current !== scope; current = current.parent) if (ts.isIterationStatement(current, false)) return current;
  return undefined;
}

/** The path a tested expression reads from the binding, when it reads from it at all. */
export function chainPath(expression: ts.Expression, binding: Binding): AccessPath | undefined {
  const segments: string[] = [];
  let current = unwrap(expression);
  for (;;) {
    if (binding.kind === "name" && ts.isIdentifier(current)) return current.text === binding.name ? segments : undefined;
    if (ts.isPropertyAccessExpression(current)) {
      if (binding.kind === "member" && current.expression.kind === ts.SyntaxKind.ThisKeyword) return current.name.text === binding.name ? segments : undefined;
      segments.unshift(current.name.text);
      current = unwrap(current.expression);
    } else if (ts.isElementAccessExpression(current)) {
      const key = current.argumentExpression;
      segments.unshift(ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : ELEMENT);
      current = unwrap(current.expression);
    } else if (ts.isCallExpression(current) && current.arguments.length === 0) {
      current = unwrap(current.expression);
    } else {
      return undefined;
    }
  }
}

export function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isContinueStatement(statement) || ts.isBreakStatement(statement)) return true;
  if (!ts.isBlock(statement)) return false;
  const last = statement.statements.at(-1);
  return last !== undefined && exits(last);
}
