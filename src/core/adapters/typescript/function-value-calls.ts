import ts from "typescript";
import type { FunctionValueCall, ReceiverBinding, ReceiverValue } from "../../ports/declared-member-names.port.ts";
import { bindFile, type BoundFile, type LexicalBinding, unwrapped } from "./lexical-bindings.ts";

const LOGICAL_OPERATORS: readonly ts.SyntaxKind[] = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];
/** Operators that store their right operand, or may: `a ??= f` leaves `a` holding `f` when it held nothing. */
const ASSIGNMENTS: readonly ts.SyntaxKind[] = [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken];

/** A write into a bare name: the value it stores, when the syntax gives one; none for `+=`, `++`, a destructuring or iteration target. */
interface Store {
  name: ts.Identifier;
  operator?: ts.SyntaxKind;
  value?: ts.Expression;
}

export interface LocalReceivers {
  functionValueCalls: FunctionValueCall[];
  receiverBindings: ReceiverBinding[];
}

/**
 * What a TypeScript tree binds the receivers of its member calls to, by the binder's own scoping (ADR-0029) and every
 * store the file makes into a bare name:
 * - the calls whose receiver holds a function value (see `FunctionValueCall`): a bare receiver bound only when the file
 *   declares or assigns a function value under its name; `this.x` by the field of the enclosing class;
 * - the calls whose bare receiver holds one kind of value (see `ReceiverBinding`), keyed by where the call starts.
 */
export function localReceivers(tree: ts.SourceFile): LocalReceivers {
  const accesses: ts.PropertyAccessExpression[] = [];
  const holders = new Set<string>();
  const stores: Store[] = [];
  const assignedFields = new Map<ts.ClassLikeDeclaration, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) accesses.push(node.expression);
    const declared = ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ? node.name : undefined;
    if (declared !== undefined && ts.isIdentifier(declared) && declaresFunction(node)) holders.add(declared.text);
    if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
      if (ts.isIdentifier(node.left)) stores.push({ name: node.left, operator: node.operatorToken.kind, value: node.right });
      else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) for (const name of targetNames(node.left)) stores.push({ name });
      if (ASSIGNMENTS.includes(node.operatorToken.kind) && isFunctionValue(node.right)) {
        if (ts.isIdentifier(node.left)) holders.add(node.left.text);
        const owner = isThisMember(node.left) ? thisClassOf(node.left) : undefined;
        if (owner !== undefined && isThisMember(node.left)) assignedFields.set(owner, new Set([...(assignedFields.get(owner) ?? []), node.left.name.text]));
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      for (const name of targetNames(node.operand)) stores.push({ name });
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) for (const name of targetNames(node.initializer)) stores.push({ name });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const assignedNames = stores.filter(({ operator, value }) => operator !== undefined && ASSIGNMENTS.includes(operator) && value !== undefined && isFunctionValue(value)).map(({ name }) => name);

  let bound: BoundFile | undefined;
  const bindingOf = (identifier: ts.Identifier): LexicalBinding | undefined => {
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
  let storesBySymbol: ReadonlyMap<ts.Symbol, readonly Store[]> | undefined;
  /** The stores into each binding; a store whose binding a dynamic scope decides may write any binding of its name. */
  const storesOf = (binding: Extract<LexicalBinding, { kind: "declared" }>, name: string): readonly Store[] | undefined => {
    if (storesBySymbol === undefined) {
      const bySymbol = new Map<ts.Symbol, Store[]>();
      for (const store of stores) {
        const target = bindingOf(store.name);
        const key = target?.kind === "declared" ? target.symbol : undefined;
        if (key !== undefined) bySymbol.set(key, [...(bySymbol.get(key) ?? []), store]);
      }
      storesBySymbol = bySymbol;
    }
    if (stores.some((store) => store.name.text === name && bindingOf(store.name)?.kind === "dynamic")) return undefined;
    return storesBySymbol.get(binding.symbol) ?? [];
  };
  let named: ReadonlyMap<string, readonly ts.Identifier[]> | undefined;
  /**
   * Whether every place the file names the binding stores into it, declares it, or reads one of its members without
   * writing it: a binding passed, returned, copied, indexed or written through could have its members replaced.
   */
  const staysLocal = (binding: Extract<LexicalBinding, { kind: "declared" }>, name: string): boolean => {
    if (named === undefined) {
      const byName = new Map<string, ts.Identifier[]>();
      const collect = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) byName.set(node.text, [...(byName.get(node.text) ?? []), node]);
        ts.forEachChild(node, collect);
      };
      collect(tree);
      named = byName;
    }
    const stored = new Set(stores.map((store) => store.name));
    return (named.get(name) ?? []).every((identifier) => {
      const parent = identifier.parent;
      if (stored.has(identifier) || (ts.isVariableDeclaration(parent) && parent.name === identifier)) return true;
      const target = bindingOf(identifier);
      if (target?.kind !== "declared" || target.symbol !== binding.symbol) return target?.kind !== "dynamic";
      return ts.isPropertyAccessExpression(parent) && parent.expression === identifier && !isWritten(parent);
    });
  };
  const fileIsModule = ts.isExternalModule(tree);
  /** What every store into the binding stores, when they all store one kind of value. */
  const valueOf = (binding: Extract<LexicalBinding, { kind: "declared" }>, name: string): ReceiverValue | undefined => {
    if (!binding.declarations.every((declaration) => isExactLocal(declaration, fileIsModule)) || !staysLocal(binding, name)) return undefined;
    const assignments = storesOf(binding, name);
    if (assignments === undefined) return undefined;
    const values = [
      ...binding.declarations.flatMap((declaration) => (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined ? [declaration.initializer] : [])),
      ...assignments.map((store) => (store.operator === undefined || !ASSIGNMENTS.includes(store.operator) ? undefined : store.value)),
    ];
    if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
    const kinds = values.map((value) => storedValue(value!, bindingOf, tree));
    const first = kinds[0];
    return first !== undefined && kinds.every((kind) => kind !== undefined && sameValue(kind, first)) ? first : undefined;
  };

  const functionValueCalls = accesses.flatMap((access): FunctionValueCall[] => {
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
  const receiverBindings = accesses.flatMap((access): ReceiverBinding[] => {
    const receiver = access.expression;
    if (!ts.isIdentifier(receiver) || access.questionDotToken !== undefined) return [];
    const binding = bindingOf(receiver);
    const holds = binding?.kind === "declared" ? valueOf(binding, receiver.text) : undefined;
    if (holds === undefined) return [];
    const at = tree.getLineAndCharacterOfPosition(access.parent.getStart(tree));
    return [{ line: at.line + 1, column: at.character + 1, receiver: receiver.text, member: access.name.text, holds }];
  });
  return { functionValueCalls, receiverBindings };
}

/** Whether an access is the target of an assignment, an update, a `delete` or a destructuring or iteration store. */
function isWritten(access: ts.Expression): boolean {
  let node: ts.Node = access;
  while (ts.isParenthesizedExpression(node.parent) || ts.isArrayLiteralExpression(node.parent) || ts.isSpreadElement(node.parent) || ts.isPropertyAssignment(node.parent) || ts.isObjectLiteralExpression(node.parent) || ts.isNonNullExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && isAssignment(parent.operatorToken.kind) && parent.left === node) return true;
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node) return true;
  return ts.isDeleteExpression(parent);
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** The bare names a destructuring, update or iteration target writes. */
function targetNames(target: ts.Node): ts.Identifier[] {
  const inner = ts.isExpression(target) ? unwrapped(target) : target;
  if (ts.isIdentifier(inner)) return [inner];
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.flatMap(targetNames);
  if (ts.isObjectLiteralExpression(inner)) return inner.properties.flatMap((property) => (ts.isShorthandPropertyAssignment(property) ? [property.name] : ts.isPropertyAssignment(property) ? targetNames(property.initializer) : ts.isSpreadAssignment(property) ? targetNames(property.expression) : []));
  if (ts.isSpreadElement(inner)) return targetNames(inner.expression);
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) return targetNames(inner.left);
  return [];
}

/**
 * A `let`, `const` or `var` that names one identifier and takes its value only from its initializer and assignments: no
 * parameter, catch variable, iteration variable or destructuring, no export another module could write through, and no
 * global a script shares with other scripts.
 */
function isExactLocal(declaration: ts.Declaration, fileIsModule: boolean): boolean {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !ts.isVariableDeclarationList(declaration.parent)) return false;
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) && !ts.isForStatement(statement)) return false;
  if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
  if (fileIsModule) return true;
  const blockScoped = (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
  if (blockScoped) return !ts.isSourceFile(statement.parent);
  for (let scope: ts.Node = statement.parent; ; scope = scope.parent) {
    if (ts.isSourceFile(scope)) return false;
    if (ts.isFunctionLike(scope) || ts.isClassStaticBlockDeclaration(scope)) return true;
  }
}

/** The kind of value one store puts in a binding, through parentheses and type syntax; none for anything else. */
function storedValue(value: ts.Expression, bindingOf: (identifier: ts.Identifier) => LexicalBinding | undefined, tree: ts.SourceFile): ReceiverValue | undefined {
  const inner = unwrapped(value);
  if (ts.isRegularExpressionLiteral(inner)) return { kind: "literal", type: "RegExp" };
  if (ts.isArrayLiteralExpression(inner)) return { kind: "literal", type: "Array" };
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) || ts.isTemplateExpression(inner)) return { kind: "literal", type: "String" };
  if (!ts.isNewExpression(inner) || !ts.isIdentifier(inner.expression)) return undefined;
  const name = inner.expression.text;
  const binding = bindingOf(inner.expression);
  if (binding?.kind === "none") {
    const at = tree.getLineAndCharacterOfPosition(inner.getStart(tree));
    return { kind: "constructed", name, line: at.line + 1, column: at.character + 1 };
  }
  if (binding?.kind !== "declared" || binding.declarations.length !== 1) return undefined;
  const declaration = binding.declarations[0]!;
  if (ts.isClassDeclaration(declaration) && declaration.name !== undefined) return { kind: "declared", name, line: tree.getLineAndCharacterOfPosition(declaration.name.getStart(tree)).line + 1 };
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
    const at = tree.getLineAndCharacterOfPosition(inner.getStart(tree));
    return { kind: "constructed", name, line: at.line + 1, column: at.character + 1 };
  }
  return undefined;
}

/** Two stores agree when they store one library type, or instances of one class under one name. */
function sameValue(a: ReceiverValue, b: ReceiverValue): boolean {
  if (a.kind === "literal") return b.kind === "literal" && a.type === b.type;
  if (a.kind === "declared") return b.kind === "declared" && a.name === b.name && a.line === b.line;
  return b.kind === "constructed" && a.name === b.name;
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
