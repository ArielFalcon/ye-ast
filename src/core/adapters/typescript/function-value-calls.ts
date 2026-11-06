import ts from "typescript";
import type { FunctionValueCall } from "../../ports/declared-member-names.port.ts";

/** The member calls of a TypeScript tree whose receiver the file binds to a function value (see `FunctionValueCall`). */
export function functionValueCalls(tree: ts.SourceFile): FunctionValueCall[] {
  const accesses: ts.PropertyAccessExpression[] = [];
  const assignedBindings = new Set<ts.Node>();
  const assignedFields = new Map<ts.ClassLikeDeclaration, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) accesses.push(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isFunctionValue(node.right)) {
      const binding = ts.isIdentifier(node.left) ? bindingOf(node.left) : undefined;
      if (binding !== undefined) assignedBindings.add(binding);
      const owner = isThisMember(node.left) ? thisClassOf(node.left) : undefined;
      if (owner !== undefined && isThisMember(node.left)) assignedFields.set(owner, new Set([...(assignedFields.get(owner) ?? []), node.left.name.text]));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return accesses.flatMap((access): FunctionValueCall[] => {
    const receiver = access.expression;
    const line = tree.getLineAndCharacterOfPosition(access.getStart(tree)).line + 1;
    if (isThisMember(receiver)) {
      const owner = thisClassOf(receiver);
      const name = receiver.name.text;
      const holds = owner !== undefined && (fieldHoldsFunction(owner, name) || (assignedFields.get(owner)?.has(name) ?? false));
      return holds ? [{ line, receiver: name, member: access.name.text }] : [];
    }
    if (!ts.isIdentifier(receiver)) return [];
    const binding = bindingOf(receiver);
    const holds = binding !== undefined && (declaresFunction(binding) || assignedBindings.has(binding));
    return holds ? [{ line, receiver: receiver.text, member: access.name.text }] : [];
  });
}

/** An arrow or function expression, through parentheses and type assertions. */
function isFunctionValue(value: ts.Expression): boolean {
  let inner = value;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
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
    if (ts.isConstructorDeclaration(member)) return member.parameters.some((parameter) => ts.isParameterPropertyDeclaration(parameter, member) && declaresName(parameter.name, name) && isFunctionType(parameter.type));
    return false;
  });
}

/** The innermost local, parameter or function that declares the identifier's name around it; an import is none, its value the index's to resolve. */
function bindingOf(identifier: ts.Identifier): ts.Node | undefined {
  for (let scope: ts.Node | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
    const found = declarationIn(scope, identifier.text);
    if (found !== undefined) return found;
  }
  return undefined;
}

function declarationIn(scope: ts.Node, name: string): ts.Node | undefined {
  if (ts.isFunctionLike(scope)) {
    const parameter = scope.parameters.find((candidate) => declaresName(candidate.name, name));
    if (parameter !== undefined) return parameter;
    if (ts.isFunctionExpression(scope) && scope.name?.text === name) return scope;
  }
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    for (const statement of scope.statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find((candidate) => declaresName(candidate.name, name));
        if (declaration !== undefined) return declaration;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    }
  }
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer !== undefined && ts.isVariableDeclarationList(scope.initializer)) {
    return scope.initializer.declarations.find((candidate) => declaresName(candidate.name, name));
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined && declaresName(scope.variableDeclaration.name, name)) return scope.variableDeclaration;
  return undefined;
}

function declaresName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => !ts.isOmittedExpression(element) && declaresName(element.name, name));
}

/** A binding whose declaration holds a function value. */
function declaresFunction(binding: ts.Node): boolean {
  if (ts.isFunctionDeclaration(binding) || ts.isFunctionExpression(binding)) return true;
  if (ts.isVariableDeclaration(binding)) return ts.isIdentifier(binding.name) && ((binding.initializer !== undefined && isFunctionValue(binding.initializer)) || isFunctionType(binding.type));
  if (ts.isParameter(binding)) return ts.isIdentifier(binding.name) && isFunctionType(binding.type);
  return false;
}
