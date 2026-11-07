import ts from "typescript";
import type { FunctionValueCall, ReceiverBinding, ReceiverValue } from "../../ports/declared-member-names.port.ts";
import { lineOf } from "./http-call-sites.adapter.ts";
import { bindFile, type BoundFile, isDirectEval, type LexicalBinding, unwrapped } from "./lexical-bindings.ts";
import { isStatic } from "./syntax-names.ts";

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
  const evals: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) accesses.push(node.expression);
    if (ts.isCallExpression(node) && isDirectEval(node)) evals.push(node);
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
      return readsMember(identifier);
    });
  };
  const fileIsModule = ts.isExternalModule(tree);
  /** What every store into the binding stores, when they all store one kind of value. */
  const valueOf = (binding: Extract<LexicalBinding, { kind: "declared" }>, name: string): ReceiverValue | undefined => {
    if (!binding.declarations.every((declaration) => isExactLocal(declaration, fileIsModule) && !evals.some((call) => isInside(call, scopeOf(declaration)))) || !staysLocal(binding, name)) return undefined;
    const assignments = storesOf(binding, name);
    if (assignments === undefined) return undefined;
    const values = [
      ...binding.declarations.flatMap((declaration) => (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined ? [declaration.initializer] : [])),
      ...assignments.map((store) => (store.operator === undefined || !ASSIGNMENTS.includes(store.operator) ? undefined : store.value)),
    ];
    if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
    const reads = values.map((value) => unwrapped(value!));
    const [read] = reads;
    if (read !== undefined && isThisMember(read)) {
      const same = reads.every((other) => isThisMember(other) && other.name.text === read.name.text && thisClassOf(other) === thisClassOf(read));
      return same ? fieldAnnotationOf(read, new Set(reads)) : undefined;
    }
    const kinds = values.map((value) => storedValue(value!, bindingOf, tree));
    const first = kinds[0];
    return first !== undefined && kinds.every((kind) => kind !== undefined && sameValue(kind, first)) ? first : undefined;
  };

  const functionValueCalls = accesses.flatMap((access): FunctionValueCall[] => {
    const receiver = unwrapped(access.expression);
    const line = lineOf(tree, access);
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
  /**
   * The type the one declaration of a bare receiver states: a parameter, or a local `isExactLocal` admits. None when a
   * direct `eval` or a dynamic scope may store into it, or the value leaves the file's sight (`staysLocal`), where its
   * members could be replaced.
   */
  const annotationOf = (binding: Extract<LexicalBinding, { kind: "declared" }>, name: string): ReceiverValue | undefined => {
    const [declaration, ...others] = binding.declarations;
    if (declaration === undefined || others.length > 0) return undefined;
    if (!(ts.isParameter(declaration) && ts.isIdentifier(declaration.name)) && !isExactLocal(declaration, fileIsModule)) return undefined;
    const scope = ts.isParameter(declaration) ? declaration.parent : scopeOf(declaration);
    if (evals.some((call) => isInside(call, scope)) || storesOf(binding, name) === undefined || !staysLocal(binding, name)) return undefined;
    return annotated(declaration.type, tree);
  };
  /**
   * The type the enclosing class states for `this.<name>`, when it declares the name once, as an instance field or a
   * constructor property. `copies` are reads of the field that every store into a local binding stores, a local that
   * itself stays in the file's sight, so the field's value reaches nothing else through them.
   */
  const fieldAnnotationOf = (access: ts.PropertyAccessExpression, copies: ReadonlySet<ts.Node> = new Set()): ReceiverValue | undefined => {
    const owner = thisClassOf(access);
    if (owner === undefined || evals.some((call) => isInside(call, owner))) return undefined;
    const name = access.name.text;
    const declared = owner.members.flatMap((member): ts.Node[] => {
      if (ts.isConstructorDeclaration(member)) return member.parameters.filter((parameter) => ts.isParameterPropertyDeclaration(parameter, member) && ts.isIdentifier(parameter.name) && parameter.name.text === name);
      return member.name !== undefined && !ts.isComputedPropertyName(member.name) && member.name.text === name ? [member] : [];
    });
    const [field, ...others] = declared;
    if (field === undefined || others.length > 0 || !isClassPrivate(field) || !fieldStaysLocal(owner, name, copies)) return undefined;
    if (ts.isParameter(field)) return annotated(field.type, tree);
    return ts.isPropertyDeclaration(field) && !isStatic(field) ? annotated(field.type, tree) : undefined;
  };
  const receiverBindings = accesses.flatMap((access): ReceiverBinding[] => {
    const receiver = seenThrough(access.expression);
    /** A receiver the rules see only through a wrapper binds nothing else they could leave to its root. */
    const wrapped = receiver !== access.expression ? COMPUTED : undefined;
    let holds: ReceiverValue | undefined;
    if (access.questionDotToken !== undefined) holds = COMPUTED;
    else if (isThisMember(receiver)) holds = fieldAnnotationOf(receiver) ?? wrapped;
    else if (ts.isIdentifier(receiver)) {
      const binding = bindingOf(receiver);
      holds = (binding?.kind === "declared" ? (valueOf(binding, receiver.text) ?? annotationOf(binding, receiver.text)) : undefined) ?? wrapped;
    } else if (isNameChain(receiver)) holds = wrapped;
    else holds = ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver) ? COMPUTED : (storedValue(receiver, bindingOf, tree) ?? returnedValue(receiver, tree));
    if (holds === undefined) return [];
    const at = tree.getLineAndCharacterOfPosition(access.parent.getStart(tree));
    const name = holds.kind === "computed" ? "" : isThisMember(receiver) ? receiver.name.text : ts.isIdentifier(receiver) ? receiver.text : "";
    return [{ line: at.line + 1, column: at.character + 1, receiver: name, member: access.name.text, holds }];
  });
  return { functionValueCalls, receiverBindings };
}

/**
 * The scope a variable declaration binds in: a `var`'s function, static block or file, a `let` or `const`'s block. A
 * direct `eval` there or in a scope inside it, strict or not, may assign the binding.
 */
function scopeOf(declaration: ts.VariableDeclaration): ts.Node {
  const list = declaration.parent;
  if ((list.flags & ts.NodeFlags.BlockScoped) !== 0) return ts.isForStatement(list.parent) ? list.parent : list.parent.parent;
  let scope: ts.Node = list;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope) && !ts.isClassStaticBlockDeclaration(scope)) scope = scope.parent;
  return scope;
}

/** By text span: the binder's declarations belong to its own tree of the same text, not to the tree the calls come from. */
function isInside(node: ts.Node, scope: ts.Node): boolean {
  return scope.pos <= node.pos && node.end <= scope.end;
}

/**
 * Whether every `this` the class writes for its own instance names one member, the class names the field through no
 * other receiver, and every `this.<name>` only reads one of the field's members, stores a value into the field or is one
 * of `copies`: an instance or a field passed, returned, copied elsewhere, indexed or written through could have its
 * members replaced.
 */
function fieldStaysLocal(owner: ts.ClassLikeDeclaration, name: string, copies: ReadonlySet<ts.Node>): boolean {
  let stays = true;
  const visit = (node: ts.Node): void => {
    if (!stays) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword && thisClassOf(node) === owner && !isThisMember(node.parent)) stays = false;
    else if (namesMember(node, name) && !(isThisMember(node) && thisClassOf(node) === owner)) stays = false;
    else if (isThisMember(node) && node.name.text === name && thisClassOf(node) === owner) {
      const parent = node.parent;
      const read = readsMember(node);
      const stored = ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!read && !stored && !copies.has(node)) stays = false;
    }
    node.forEachChild(visit);
  };
  visit(owner);
  return stays;
}

/** Whether a value, seen through the wrappers a receiver is seen through, only has one of its members read. */
function readsMember(value: ts.Expression): boolean {
  let at: ts.Expression = value;
  while ((ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isSatisfiesExpression(at.parent)) && at.parent.expression === at) at = at.parent;
  const parent = at.parent;
  return ts.isPropertyAccessExpression(parent) && parent.expression === at && !isWritten(parent);
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

/**
 * Whether a member access, an element access, a destructured key or a reflecting call may name `name` on its receiver: a
 * key no string or numeric literal states, a rest element and a reflecting call without such a key may name every member.
 */
function namesMember(node: ts.Node, name: string): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === name;
  if (ts.isElementAccessExpression(node)) return keyMayName(node.argumentExpression, name);
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    if (node.dotDotDotToken !== undefined) return true;
    const key = node.propertyName ?? node.name;
    if (ts.isComputedPropertyName(key)) return keyMayName(key.expression, name);
    return (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) && key.text === name;
  }
  if (ts.isCallExpression(node) && isReflectingCall(node.expression)) {
    const key = node.arguments[1];
    return key === undefined || keyMayName(key, name);
  }
  return false;
}

function keyMayName(key: ts.Expression, name: string): boolean {
  return !(ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) || key.text === name;
}

/** `Reflect.<any>(target, key, ...)` and the `Object` functions that read or write a target's members by key or by source. */
function isReflectingCall(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  if (callee.expression.text === "Reflect") return true;
  return callee.expression.text === "Object" && OBJECT_REFLECTION.has(callee.name.text);
}

const OBJECT_REFLECTION: ReadonlySet<string> = new Set(["assign", "defineProperty", "defineProperties", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]);

/** A field only its own class can reach: a `#name`, or one TypeScript declares `private`. */
function isClassPrivate(field: ts.Node): boolean {
  const name = ts.getNameOfDeclaration(field as ts.Declaration);
  if (name !== undefined && ts.isPrivateIdentifier(name)) return true;
  return ts.canHaveModifiers(field) && (ts.getModifiers(field) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword);
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
function isExactLocal(declaration: ts.Declaration, fileIsModule: boolean): declaration is ts.VariableDeclaration {
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
  const at = tree.getLineAndCharacterOfPosition(inner.getStart(tree));
  const constructed: ReceiverValue = { kind: "constructed", name, line: at.line + 1, column: at.character + 1 };
  const binding = bindingOf(inner.expression);
  if (binding?.kind === "none") return constructed;
  if (binding?.kind !== "declared" || binding.declarations.length !== 1) return undefined;
  const declaration = binding.declarations[0]!;
  if (ts.isClassDeclaration(declaration) && declaration.name !== undefined) return { kind: "declared", name, line: lineOf(tree, declaration.name) };
  return ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) ? constructed : undefined;
}

/** `a`, `this` and a chain of plain names after either: what the receiver rules above, or a root's binding, settle. */
function isNameChain(node: ts.Expression): boolean {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) return true;
  return ts.isPropertyAccessExpression(node) && node.questionDotToken === undefined && isNameChain(node.expression);
}

const COMPUTED: ReceiverValue = { kind: "computed" };

/**
 * A receiver through the wrappers that keep its value and its type: parentheses, a non-null `!` and `satisfies`. A type
 * assertion is not seen through, since it states a type the value need not have.
 */
function seenThrough(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner) || ts.isSatisfiesExpression(inner)) inner = inner.expression;
  return inner;
}

/** What a receiver that is no name holds: the result of a call whose callee ends in a name, or an expression no rule binds. */
function returnedValue(inner: ts.Expression, tree: ts.SourceFile): ReceiverValue {
  if (!ts.isCallExpression(inner) || inner.questionDotToken !== undefined) return COMPUTED;
  const callee = unwrapped(inner.expression);
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  if (name === undefined) return COMPUTED;
  const at = tree.getLineAndCharacterOfPosition(inner.getStart(tree));
  return { kind: "returned", name, line: at.line + 1, column: at.character + 1 };
}

/** Two stores agree when they store one library type, or instances of one class under one name. */
function sameValue(a: ReceiverValue, b: ReceiverValue): boolean {
  if (a.kind === "literal") return b.kind === "literal" && a.type === b.type;
  if (a.kind === "declared") return b.kind === "declared" && a.name === b.name && a.line === b.line;
  return a.kind === "constructed" && b.kind === "constructed" && a.name === b.name;
}

const KEYWORD_TYPES: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword]);

/**
 * The one type an annotation states, through parentheses, `readonly` and a union with `null` or `undefined`, at the
 * place it is written: a primitive keyword, an array type as `Array`, or a type reference by its first name. None for
 * any other type, or no annotation.
 */
export function annotated(type: ts.TypeNode | undefined, tree: ts.SourceFile): Extract<ReceiverValue, { kind: "annotated" }> | undefined {
  let inner = type;
  for (;;) {
    if (inner !== undefined && ts.isParenthesizedTypeNode(inner)) inner = inner.type;
    else if (inner !== undefined && ts.isTypeOperatorNode(inner) && inner.operator === ts.SyntaxKind.ReadonlyKeyword) inner = inner.type;
    else if (inner !== undefined && ts.isUnionTypeNode(inner)) {
      const kept = inner.types.filter((member) => member.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword));
      inner = kept.length === 1 ? kept[0] : undefined;
    } else break;
  }
  if (inner === undefined) return undefined;
  const placed = (node: ts.Node, name: string): Extract<ReceiverValue, { kind: "annotated" }> => {
    const at = tree.getLineAndCharacterOfPosition(node.getStart());
    return { kind: "annotated", type: name, line: at.line + 1, column: at.character + 1 };
  };
  if (KEYWORD_TYPES.has(inner.kind)) return placed(inner, inner.getText());
  if (ts.isArrayTypeNode(inner)) return placed(inner, "Array");
  if (!ts.isTypeReferenceNode(inner)) return undefined;
  let head: ts.EntityName = inner.typeName;
  while (ts.isQualifiedName(head)) head = head.left;
  return placed(head, head.text);
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
  return isFunctionValueNode(value);
}

/** An arrow or a function expression: the values a function-value call is read through. */
export function isFunctionValueNode(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
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
