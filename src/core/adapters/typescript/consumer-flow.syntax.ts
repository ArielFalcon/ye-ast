import ts from "typescript";
import { ELEMENT, type AccessPath } from "../../domain/contracts/access-path.ts";
import type { JsonValue, Literal, Replacement } from "../../domain/contracts/use-operation.ts";
import { bindFile } from "./lexical-bindings.ts";
import { unwrapped } from "./syntax.ts";

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
    const held = ts.isVariableDeclaration(holder) ? (ts.isIdentifier(holder.name) ? holder.name.text : undefined) : ts.isPropertyDeclaration(holder) ? propertyNameText(holder.name) : undefined;
    if ((ts.isVariableDeclaration(holder) || ts.isPropertyDeclaration(holder)) && holder.initializer === node && held !== undefined) return { node, name: held, declaration: holder };
    return ts.isFunctionExpression(node) && node.name !== undefined ? { node, name: node.name.text, declaration: node } : undefined;
  }
  const name = node.name === undefined ? undefined : propertyNameText(node.name);
  return name === undefined ? undefined : { node, name, declaration: node };
}

/** The name a property name denotes: an identifier, a literal, or a literal in brackets. Undefined where it is computed from anything else. */
export function propertyNameText(name: ts.PropertyName): string | undefined {
  if (!ts.isComputedPropertyName(name)) return name.text;
  const key = unwrapped(name.expression);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

/** How a function receives the argument at `index`: `parameter` is the declared parameter that holds it, `hidden` that it is also readable where no binding follows it (a rest parameter, the function's own `arguments`). */
export interface ParameterReceipt {
  parameter?: ts.ParameterDeclaration;
  hidden: boolean;
}

export function receiptOf(fn: FunctionNode, index: number): ParameterReceipt {
  const last = fn.parameters[fn.parameters.length - 1];
  const gathered = last?.dotDotDotToken !== undefined && fn.parameters.length - 1 <= index;
  const parameter = gathered ? undefined : fn.parameters[index];
  return { ...(parameter === undefined ? {} : { parameter }), hidden: gathered || readsArguments(fn) };
}

const argumentsReaders = new WeakMap<FunctionNode, boolean>();

/** Whether the function reads its own `arguments`: an arrow function has none, and a nested function has its own. */
function readsArguments(fn: FunctionNode): boolean {
  if (ts.isArrowFunction(fn) || fn.body === undefined) return false;
  let reads = argumentsReaders.get(fn);
  if (reads === undefined) {
    const visit = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node)) return node.text === "arguments" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
      if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return false;
      return node.forEachChild(visit) === true;
    };
    reads = visit(fn.body);
    argumentsReaders.set(fn, reads);
  }
  return reads;
}

export function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) if (isFunctionNode(current)) return current;
  return undefined;
}

export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrapped(call.expression);
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

export function isTransparent(node: ts.Node): boolean {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}

function jsonOf(expression: ts.Expression): JsonValue | undefined {
  const bare = unwrapped(expression);
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
  return operator === ts.SyntaxKind.InstanceOfKeyword && parent.left === top;
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
  const bare = unwrapped(expression);
  return bare.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(bare) && bare.text === "undefined");
}

/** What a name binds: its declaration, by the start of the first declaration's name, and the spans of every declaration. */
interface Declared {
  key: number;
  spans: readonly { pos: number; end: number }[];
}

/** A name's binding as the binder answers it, `dynamic` where no binding is claimed (ADR-0029); absent: none. */
type Answer = Declared | "dynamic";

const answered = new WeakMap<ts.SourceFile, ReadonlyMap<number, Answer>>();

/**
 * Every name of a file with its binding, by the name's start: the binder answers them all at once and its program is
 * dropped (ADR-0029). A declaration's own name answers with its declaration whenever any read of it does.
 */
function answersOf(tree: ts.SourceFile): ReadonlyMap<number, Answer> {
  let answers = answered.get(tree);
  if (answers !== undefined) return answers;
  const bound = bindFile(tree.fileName, tree.text);
  const found = new Map<number, Answer>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const binding = bound.bindingOf(node);
      if (binding.kind === "dynamic") found.set(node.getStart(bound.tree), "dynamic");
      const names = binding.kind === "declared" ? binding.declarations.flatMap((declaration) => ts.getNameOfDeclaration(declaration) ?? []) : [];
      if (binding.kind === "declared" && names.length > 0) {
        const declared: Declared = { key: Math.min(...names.map((name) => name.getStart(bound.tree))), spans: binding.declarations.map(({ pos, end }) => ({ pos, end })) };
        for (const name of [node, ...names]) found.set(name.getStart(bound.tree), declared);
      }
    }
    node.forEachChild(visit);
  };
  visit(bound.tree);
  answers = found;
  answered.set(tree, answers);
  return answers;
}

function answerOf(identifier: ts.Identifier): Answer | undefined {
  return answersOf(identifier.getSourceFile()).get(identifier.getStart());
}

/** `binds` is the declaration the name binds, by its key; absent for a name the file does not declare. */
export type Binding = { kind: "name"; name: string; scope: ts.Node; binds?: number } | { kind: "member"; name: string; scope: ts.ClassLikeDeclaration };

/** The binding a declaration's name introduces in `scope`. */
export function declaredBinding(name: ts.Identifier, scope: ts.Node): Binding {
  const answer = answerOf(name);
  return { kind: "name", name: name.text, scope, binds: answer === undefined || answer === "dynamic" ? name.getStart() : answer.key };
}

/** The binding an assigned name writes, with the scope that declares it; undefined where the name is dynamic. */
export function assignedBinding(name: ts.Identifier): Binding | undefined {
  const answer = answerOf(name);
  if (answer === "dynamic") return undefined;
  return { kind: "name", name: name.text, scope: declaringScope(name), ...(answer === undefined ? {} : { binds: answer.key }) };
}

/** Whether a name of the binding's spelling binds it; `dynamic` where the resolver claims no binding, so it may. */
function bindsTo(identifier: ts.Identifier, binding: Extract<Binding, { kind: "name" }>): boolean | "dynamic" {
  const answer = answerOf(identifier);
  return answer === "dynamic" ? answer : answer?.key === binding.binds;
}

/** A name whose binding is decided at run time, so no declaration can be claimed for it. */
export function isDynamicName(identifier: ts.Identifier): boolean {
  return answerOf(identifier) === "dynamic";
}

/** Whether nothing the file declares or imports binds the name, outside any dynamic scope: it names a global. */
export function isUndeclaredName(identifier: ts.Identifier): boolean {
  return answerOf(identifier) === undefined;
}

const SCOPES = (node: ts.Node): boolean =>
  isFunctionNode(node) || ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node);

/** The nearest scope above `node` that holds a declaration of what it binds, as the binder answers; the file when none does. */
export function declaringScope(node: ts.Identifier): ts.Node {
  const answer = answerOf(node);
  const spans = answer === undefined || answer === "dynamic" ? [] : answer.spans;
  let current: ts.Node = node;
  while (current.parent !== undefined) {
    current = current.parent;
    if (SCOPES(current) && spans.some(({ pos, end }) => current.pos <= pos && end <= current.end)) return current;
  }
  return current;
}

/** Where every read of a name binding sits: the function or file around its scope, since a `var` reaches past its block. */
export function searchRoot(binding: Binding): ts.Node {
  if (binding.kind === "member") return binding.scope;
  let current = binding.scope;
  while (!isFunctionNode(current) && !ts.isSourceFile(current) && current.parent !== undefined) current = current.parent;
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

export function isWriteTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isBinaryExpression(parent) && parent.left === node && ASSIGNMENTS.has(parent.operatorToken.kind);
}

/** Whether the node is what an assignment or a deletion replaces; an increment also reads, and stays a use of the value. */
export function isModified(node: ts.Node): boolean {
  return ts.isDeleteExpression(node.parent) || isWriteTarget(node);
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

/** A member binding is read through `this`, which a nested class or function rebinds. */
function shadows(node: ts.Node, binding: Binding): boolean {
  return binding.kind === "member" && (ts.isClassLike(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));
}

function isReference(node: ts.Node, binding: Binding): boolean | "dynamic" {
  if (binding.kind === "name") return ts.isIdentifier(node) && node.text === binding.name && isValueIdentifier(node) && bindsTo(node, binding);
  return ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === binding.name && !isWriteTarget(node);
}

/** The expressions that read a binding, in source order, and apart the reads of its name a dynamic scope may bind to it. */
export function referencesOf(binding: Binding): { reads: ts.Expression[]; dynamic: ts.Expression[] } {
  const reads: ts.Expression[] = [];
  const dynamic: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    const reference = isReference(node, binding);
    if (reference !== false) {
      (reference === "dynamic" ? dynamic : reads).push(node as ts.Expression);
      return;
    }
    if (shadows(node, binding)) return;
    node.forEachChild(visit);
  };
  searchRoot(binding).forEachChild(visit);
  return { reads, dynamic };
}

/** A write to a binding or to a path below it: the assigned or deleted expression, as a path from the binding. */
export interface Write {
  node: ts.Node;
  path: AccessPath;
  /** The write's target is a name a dynamic scope decides, so it may not write the binding. */
  dynamic?: true;
}

/** The writes to `binding` inside `root` that end after `from` and before `to`, in source order. */
export function writesWithin(root: ts.Node, binding: Binding, from: number, to: number): Write[] {
  const found: Write[] = [];
  const visit = (node: ts.Node): void => {
    if (node.end <= from || node.pos >= to || ts.isTypeNode(node) || shadows(node, binding)) return;
    const target = ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind) ? node.left : ts.isDeleteExpression(node) ? node.expression : undefined;
    const written = target === undefined ? undefined : pathFrom(target, binding);
    if (written !== undefined && node.pos >= from && node.end <= to) found.push({ node, path: written.path, ...(written.dynamic ? { dynamic: true as const } : {}) });
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return found;
}

const MUTATORS: ReadonlySet<string> = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]);

/** The name of the static method of the global `Object` the call invokes. */
export function staticObjectMethod(call: ts.CallExpression): string | undefined {
  const callee = unwrapped(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const object = unwrapped(callee.expression);
  return ts.isIdentifier(object) && object.text === "Object" && isUndeclaredName(object) ? callee.name.text : undefined;
}

/** The first argument of `Object.assign` and the other static `Object` methods that change it. */
export function mutatedTarget(call: ts.CallExpression): ts.Expression | undefined {
  const method = staticObjectMethod(call);
  return method !== undefined && MUTATORS.has(method) ? call.arguments[0] : undefined;
}

/** The calls inside `root` after `from` that mutate the value of `binding` or a path below it for which `matters` holds. */
export function mutationsWithin(root: ts.Node, binding: Binding, from: number, matters: (path: AccessPath) => boolean): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node.end <= from || ts.isTypeNode(node) || shadows(node, binding)) return;
    const target = ts.isCallExpression(node) ? mutatedTarget(node) : undefined;
    const written = target === undefined ? undefined : pathFrom(target, binding);
    if (ts.isCallExpression(node) && written !== undefined && !written.dynamic && node.pos >= from && matters(written.path)) found.push(node);
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
  const read = pathFrom(expression, binding);
  return read === undefined || read.dynamic ? undefined : read.path;
}

/** The path an expression reaches from the binding, and whether a dynamic scope decides the name it starts at. */
function pathFrom(expression: ts.Expression, binding: Binding): { path: AccessPath; dynamic: boolean } | undefined {
  const segments: string[] = [];
  let current = unwrapped(expression);
  for (;;) {
    if (binding.kind === "name" && ts.isIdentifier(current)) {
      const binds = current.text === binding.name && bindsTo(current, binding);
      return binds === false ? undefined : { path: segments, dynamic: binds === "dynamic" };
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (binding.kind === "member" && current.expression.kind === ts.SyntaxKind.ThisKeyword) return current.name.text === binding.name ? { path: segments, dynamic: false } : undefined;
      segments.unshift(current.name.text);
      current = unwrapped(current.expression);
    } else if (ts.isElementAccessExpression(current)) {
      const key = current.argumentExpression;
      segments.unshift(ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : ELEMENT);
      current = unwrapped(current.expression);
    } else if (ts.isCallExpression(current) && current.arguments.length === 0) {
      current = unwrapped(current.expression);
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
