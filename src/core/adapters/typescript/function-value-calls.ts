import ts from "typescript";
import type { FunctionValueCall } from "../../ports/declared-member-names.port.ts";
import { bindFile, type BoundFile, unwrapped } from "./lexical-bindings.ts";

const LOGICAL_OPERATORS: readonly ts.SyntaxKind[] = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];
/** Operators that store their right operand, or may: `a ??= f` leaves `a` holding `f` when it held nothing. */
const ASSIGNMENTS: readonly ts.SyntaxKind[] = [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken];

/**
 * The member calls of a TypeScript tree whose receiver the file binds to a function value (see `FunctionValueCall`): a
 * bare receiver by the binder's own scoping (ADR-0029), bound only when the file declares or assigns a function value
 * under its name; `this.x` by the field of the enclosing class.
 */
export function functionValueCalls(tree: ts.SourceFile): FunctionValueCall[] {
  const accesses: ts.PropertyAccessExpression[] = [];
  const holders = new Set<string>();
  const assignedNames: ts.Identifier[] = [];
  const assignedFields = new Map<ts.ClassLikeDeclaration, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) accesses.push(node.expression);
    const declared = ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ? node.name : undefined;
    if (declared !== undefined && ts.isIdentifier(declared) && declaresFunction(node)) holders.add(declared.text);
    if (ts.isBinaryExpression(node) && ASSIGNMENTS.includes(node.operatorToken.kind) && isFunctionValue(node.right)) {
      if (ts.isIdentifier(node.left)) {
        holders.add(node.left.text);
        assignedNames.push(node.left);
      }
      const owner = isThisMember(node.left) ? thisClassOf(node.left) : undefined;
      if (owner !== undefined && isThisMember(node.left)) assignedFields.set(owner, new Set([...(assignedFields.get(owner) ?? []), node.left.name.text]));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);

  let bound: BoundFile | undefined;
  const bindingOf = (identifier: ts.Identifier) => {
    bound ??= bindFile(tree.fileName, tree.text);
    const same = bound.identifierAt(identifier.getStart(tree), identifier.text);
    return same === undefined ? undefined : bound.bindingOf(same);
  };
  let assigned: ReadonlySet<ts.Symbol> | undefined;
  const assignedSymbols = (): ReadonlySet<ts.Symbol> =>
    (assigned ??= new Set(assignedNames.flatMap((name) => {
      const binding = bindingOf(name);
      return binding?.kind === "declared" ? [binding.symbol] : [];
    })));

  return accesses.flatMap((access): FunctionValueCall[] => {
    const receiver = unwrapped(access.expression);
    const line = tree.getLineAndCharacterOfPosition(access.getStart(tree)).line + 1;
    if (isThisMember(receiver)) {
      const owner = thisClassOf(receiver);
      const name = receiver.name.text;
      const holds = owner !== undefined && (fieldHoldsFunction(owner, name) || (assignedFields.get(owner)?.has(name) ?? false));
      return holds ? [{ line, receiver: name, member: access.name.text }] : [];
    }
    if (!ts.isIdentifier(receiver) || !holders.has(receiver.text)) return [];
    const binding = bindingOf(receiver);
    const holds = binding?.kind === "declared" && (binding.declarations.some(declaresFunction) || assignedSymbols().has(binding.symbol));
    return holds ? [{ line, receiver: receiver.text, member: access.name.text }] : [];
  });
}

/**
 * An arrow or function expression, through parentheses, type assertions and non-null; a conditional or a logical
 * operator is one when either operand may be, a comma or an assignment when its last operand is.
 */
function isFunctionValue(value: ts.Expression): boolean {
  if (unwrapped(value) !== value) return isFunctionValue(unwrapped(value));
  if (ts.isConditionalExpression(value)) return isFunctionValue(value.whenTrue) || isFunctionValue(value.whenFalse);
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind;
    if (LOGICAL_OPERATORS.includes(operator)) return isFunctionValue(value.left) || isFunctionValue(value.right);
    if (operator === ts.SyntaxKind.CommaToken || ASSIGNMENTS.includes(operator)) return isFunctionValue(value.right);
  }
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value);
}

function isFunctionType(type: ts.TypeNode | undefined): boolean {
  let inner = type;
  while (inner !== undefined && ts.isParenthesizedTypeNode(inner)) inner = inner.type;
  return inner !== undefined && ts.isFunctionTypeNode(inner);
}

function isThisMember(node: ts.Node): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword;
}

/** The class whose instance `this` is at `node`: an arrow keeps it; a function or an object-literal method rebinds it. */
function thisClassOf(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isClassLike(scope)) return scope;
    if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) return undefined;
    if ((ts.isMethodDeclaration(scope) || ts.isAccessor(scope)) && !ts.isClassLike(scope.parent)) return undefined;
  }
  return undefined;
}

function fieldHoldsFunction(owner: ts.ClassLikeDeclaration, name: string): boolean {
  return owner.members.some((member) => {
    if (ts.isPropertyDeclaration(member)) return member.name.getText() === name && ((member.initializer !== undefined && isFunctionValue(member.initializer)) || isFunctionType(member.type));
    if (ts.isConstructorDeclaration(member)) return member.parameters.some((parameter) => ts.isParameterPropertyDeclaration(parameter, member) && ts.isIdentifier(parameter.name) && parameter.name.text === name && isFunctionType(parameter.type));
    return false;
  });
}

/** A binding whose declaration holds a function value. */
function declaresFunction(binding: ts.Node): boolean {
  if (ts.isFunctionDeclaration(binding) || ts.isFunctionExpression(binding)) return true;
  if (ts.isVariableDeclaration(binding)) return ts.isIdentifier(binding.name) && ((binding.initializer !== undefined && isFunctionValue(binding.initializer)) || isFunctionType(binding.type));
  if (ts.isParameter(binding)) return ts.isIdentifier(binding.name) && isFunctionType(binding.type);
  return false;
}
