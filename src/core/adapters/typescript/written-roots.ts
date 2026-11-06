import ts from "typescript";
import { bindFile, type LexicalBinding, unwrapped } from "./lexical-bindings.ts";
import { packageOf } from "./module-resolver.ts";

/** What the snapshot's sources write through: global names, every global at once, and packages by name. */
export interface WrittenRoots {
  globals: Set<string>;
  everyGlobal: boolean;
  packages: Set<string>;
}

/** Names that hold the global object itself, so `globalThis.Math.max = f` writes through `Math`. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "window", "self", "global"]);

/** Calls that write through their first argument. */
const WRITING_CALLS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Object", ["defineProperty", "defineProperties", "assign", "setPrototypeOf"]],
  ["Reflect", ["set", "defineProperty", "setPrototypeOf", "deleteProperty"]],
]);

/** Links that reach a prototype no name states, so the write may replace a member of any global. */
const PROTOTYPE_LINKS: ReadonlySet<string> = new Set(["__proto__", "constructor", "getPrototypeOf()"]);

/** How far a local that holds a global or an import is followed: `const A = Array; A.prototype.push = f`. */
const ALIAS_DEPTH = 3;

interface Target {
  expression: ts.Expression;
  /** For a writing call on the global object itself, the key it writes (`Object.defineProperty(globalThis, "fetch", …)`). */
  key?: ts.Expression;
}

/**
 * Adds to `into` the roots one source writes through: an assignment, compound assignment, update, `delete`, destructuring
 * or iteration target whose member chain starts at a global (directly or through `globalThis`, `window`, `self` or
 * `global`) or at an imported binding, and the first argument of `Object.defineProperty`, `Object.assign`,
 * `Object.setPrototypeOf`, `Reflect.set` and their kin. What a root names comes from the binder (ADR-0029): a local named
 * like a global writes nothing global, and a chain through a call writes the call's result, not its root. A computed write on the global object, or one that reaches a prototype through
 * `__proto__`, `constructor` or `getPrototypeOf`, writes through every global.
 */
export function addWrittenRoots(path: string, text: string, parsed: ts.SourceFile, into: WrittenRoots, isGlobalName: (name: string) => boolean): void {
  if (!targetsOf(parsed).some(({ expression }) => mayWriteRoot(expression, isGlobalName))) return;
  const { tree, bindingOf } = bindFile(path, text);
  for (const target of targetsOf(tree)) addRoot(target, bindingOf, into, 0);
}

function targetsOf(tree: ts.SourceFile): Target[] {
  const targets: Target[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) targets.push(...assigned(node.left));
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) targets.push({ expression: node.operand });
    if (ts.isDeleteExpression(node)) targets.push({ expression: node.expression });
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) targets.push(...assigned(node.initializer));
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined) {
      const callee = unwrapped(node.expression);
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && WRITING_CALLS.get(callee.expression.text)?.includes(callee.name.text)) {
        targets.push({ expression: node.arguments[0], ...(node.arguments[1] === undefined ? {} : { key: node.arguments[1] }) });
      }
    }
    node.forEachChild(visit);
  };
  visit(tree);
  return targets;
}

/** The expressions a store writes: itself, or each element of a destructuring pattern. */
function assigned(target: ts.Expression): Target[] {
  const inner = unwrapped(target);
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.flatMap((element) => assigned(ts.isSpreadElement(element) ? element.expression : element));
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.flatMap((property) => (ts.isPropertyAssignment(property) ? assigned(property.initializer) : ts.isSpreadAssignment(property) ? assigned(property.expression) : ts.isShorthandPropertyAssignment(property) ? [{ expression: property.name }] : []));
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) return assigned(inner.left);
  return [{ expression: inner }];
}

/** A chain's links from its root, `*` for a computed one, `name()` for a call; and the expression it starts at. */
function chainOf(expression: ts.Expression): { root: ts.Expression; links: string[] } {
  const links: string[] = [];
  let node = unwrapped(expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) links.unshift(node.name.text);
    else if (ts.isElementAccessExpression(node)) links.unshift(ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "*");
    else if (ts.isCallExpression(node)) links.unshift(`${ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ""}()`);
    else break;
    node = unwrapped(node.expression);
  }
  return { root: node, links };
}

/** A link that calls: what follows it is the call's result, a value the chain's root does not hold. */
function isCall(link: string): boolean {
  return link.endsWith("()");
}

/** Whether a target's syntax alone may write a global or an import: a member chain not rooted at `this`, or a global name. */
function mayWriteRoot(expression: ts.Expression, isGlobalName: (name: string) => boolean): boolean {
  const { root, links } = chainOf(expression);
  if (links.some((link) => PROTOTYPE_LINKS.has(link))) return true;
  if (!ts.isIdentifier(root) || links.some(isCall)) return false;
  return links.length > 0 || isGlobalName(root.text) || GLOBAL_OBJECTS.has(root.text);
}

function addRoot(target: Target, bindingOf: (identifier: ts.Identifier) => LexicalBinding, into: WrittenRoots, depth: number): void {
  const { root, links } = chainOf(target.expression);
  if (links.some((link) => PROTOTYPE_LINKS.has(link))) return void (into.everyGlobal = true);
  if (!ts.isIdentifier(root) || links.some(isCall)) return;
  const binding = bindingOf(root);
  if (binding.kind !== "declared") {
    if (!GLOBAL_OBJECTS.has(root.text)) return void into.globals.add(root.text);
    const key = target.key === undefined ? undefined : unwrapped(target.key);
    const first = links[0] ?? (key !== undefined && ts.isStringLiteralLike(key) ? key.text : undefined);
    if (first === undefined || first === "*") into.everyGlobal = true;
    else into.globals.add(first);
    return;
  }
  for (const declaration of binding.declarations) {
    const specifier = importSpecifierOf(declaration);
    const module = specifier === undefined ? undefined : packageOf(specifier);
    if (module !== undefined) into.packages.add(module);
    else if (specifier === undefined && depth < ALIAS_DEPTH && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (links.length > 0 || target.key !== undefined)) {
      addRoot({ expression: declaration.initializer, ...(target.key === undefined ? {} : { key: target.key }) }, bindingOf, into, depth + 1);
    }
  }
}

/** The module an import declaration of the binding names; none for any other declaration. */
function importSpecifierOf(declaration: ts.Declaration): string | undefined {
  let node: ts.Node = declaration;
  while (ts.isImportSpecifier(node) || ts.isNamedImports(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) node = node.parent;
  return ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}
