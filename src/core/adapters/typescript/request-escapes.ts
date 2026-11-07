import ts from "typescript";
import type { Program } from "./consumer-flow.index.ts";
import { resolveFunction } from "./consumer-flow.resolution.ts";
import { declaredBinding, enclosingFunction, isFunctionNode, mutationsWithin, receiptOf, referencesOf, writesWithin, type Binding, type FunctionNode } from "./consumer-flow.syntax.ts";

const FLOWING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);

/** Whether anything in `scope` writes the binding or mutates the value it holds. */
export function isRewritten(scope: ts.Node, binding: Binding): boolean {
  return writesWithin(scope, binding, 0, Infinity).length > 0 || mutationsWithin(scope, binding, 0, () => true).length > 0;
}

/** Whether a read hands the variable's value, or a part of it, on: to a call, an alias, a result. */
function flowsOut(read: ts.Expression): boolean {
  const parent = reachedBy(read).parent;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return true;
  if (ts.isConditionalExpression(parent)) return parent.condition !== reachedBy(read);
  if (ts.isBinaryExpression(parent)) return FLOWING_OPERATORS.has(parent.operatorToken.kind);
  return (
    ts.isReturnStatement(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isArrowFunction(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isAwaitExpression(parent) ||
    ts.isYieldExpression(parent) ||
    ts.isParameter(parent)
  );
}

/** The outermost expression that is the read itself or a part of its value: `vet`, `vet.owner`, `(vet as Vet).owner`. */
function reachedBy(read: ts.Node): ts.Node {
  let top = read;
  for (;;) {
    const parent = top.parent;
    const reachesInto = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === top;
    if (!reachesInto && !isTypeWrapper(parent)) return top;
    top = parent;
  }
}

const isTypeWrapper = (node: ts.Node): boolean => ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node);

/**
 * Whether the function only creates `nested` for its caller: it is what the function returns, so nothing in it runs
 * while the function does.
 */
function isReturned(nested: FunctionNode, fn: FunctionNode): boolean {
  let top: ts.Node = nested;
  while (isTypeWrapper(top.parent)) top = top.parent;
  const parent = top.parent;
  return (ts.isReturnStatement(parent) && enclosingFunction(parent) === fn) || (parent === fn && ts.isArrowFunction(fn) && fn.body === top);
}

/** Whether `read` sits in a function that `fn` only returns, so it does not run while `fn` does. */
function runsAfter(read: ts.Node, fn: FunctionNode): boolean {
  let outermost: FunctionNode | undefined;
  for (let current = read.parent; current !== undefined && current !== fn; current = current.parent) if (isFunctionNode(current)) outermost = current;
  return outermost !== undefined && isReturned(outermost, fn);
}

/**
 * Answers, for a read of a variable, whether the value may change, or be kept to change, between the creation of the
 * request and its serialization. A read that hands the value to a call escapes unless the callee is a function of the
 * snapshot whose body, while it runs, neither writes, aliases nor passes the parameter on to code that does; where a
 * read sits in the code says nothing, since an argument is evaluated before the request is sent.
 */
export function createEscapes(program: Program): (read: ts.Expression) => boolean {
  const verdicts = new Map<FunctionNode, Map<number, boolean>>();

  const escapes = (read: ts.Expression): boolean => {
    if (!flowsOut(read)) return false;
    const top = reachedBy(read);
    const call = top.parent;
    if (!ts.isCallExpression(call) || call.expression === top) return true;
    const index = call.arguments.indexOf(top as ts.Expression);
    if (index < 0 || call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return true;
    const unit = program.index.units.get(call.getSourceFile().fileName);
    const target = unit === undefined ? undefined : resolveFunction(program, unit, call.expression);
    return target?.kind !== "function" || !leavesAlone(target.named.node, index);
  };

  /** Whether the function's parameter at `index` is left as it was while the function runs; a cycle of calls proves nothing against it. */
  const leavesAlone = (fn: FunctionNode, index: number): boolean => {
    const held = verdicts.get(fn) ?? new Map<number, boolean>();
    verdicts.set(fn, held);
    const known = held.get(index);
    if (known !== undefined) return known;
    held.set(index, true);
    const verdict = judge(fn, index);
    held.set(index, verdict);
    return verdict;
  };

  const judge = (fn: FunctionNode, index: number): boolean => {
    const { parameter, hidden } = receiptOf(fn, index);
    if (hidden || parameter === undefined || !ts.isIdentifier(parameter.name)) return false;
    const binding = declaredBinding(parameter.name, fn);
    if (isRewritten(fn, binding)) return false;
    const { reads, dynamic } = referencesOf(binding);
    return dynamic.length === 0 && reads.every((read) => runsAfter(read, fn) || !escapes(read));
  };

  return escapes;
}
