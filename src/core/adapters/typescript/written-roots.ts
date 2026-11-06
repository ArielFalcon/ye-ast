import ts from "typescript";
import { bindFile, type LexicalBinding, unwrapped } from "./lexical-bindings.ts";
import { packageOf } from "./module-resolver.ts";

/**
 * What the snapshot's sources write through: global names or every global at once, packages by name, and the member
 * names those writes state.
 */
export interface WrittenRoots {
  globals: Set<string>;
  everyGlobal: boolean;
  packages: Set<string>;
  members: Set<string>;
}

/** Names that hold the global object itself, so `globalThis.Math.max = f` writes through `Math`. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "window", "self", "global"]);

/** How a writing call states the members it writes: its second argument as a key, the keys of its later arguments, or not at all. */
type MemberForm = "key" | "keys" | "unstated";

/** Calls that write through their first argument. */
const WRITING_CALLS: ReadonlyMap<string, ReadonlyMap<string, MemberForm>> = new Map([
  ["Object", new Map<string, MemberForm>([["defineProperty", "key"], ["defineProperties", "keys"], ["assign", "keys"], ["setPrototypeOf", "unstated"]])],
  ["Reflect", new Map<string, MemberForm>([["set", "key"], ["defineProperty", "key"], ["deleteProperty", "key"], ["setPrototypeOf", "unstated"]])],
]);

/** Links that reach a prototype no name states, so the write may replace a member of any global. */
const PROTOTYPE_LINKS: ReadonlySet<string> = new Set(["__proto__", "constructor", "getPrototypeOf()"]);

/** How many aliases a write is followed through; past it, the write may reach any global. */
const ALIAS_DEPTH = 8;

/** A link no name states: a computed key or index. */
const COMPUTED = "*";

interface Target {
  expression: ts.Expression;
  /** The members a writing call states; absent for a store, whose member is its path's last link. */
  members?: readonly string[] | "unstated";
}

/** A member path: the expression it starts at and the links below it, `Array` then `prototype`, `push`. */
interface Path {
  start: ts.Expression;
  links: readonly string[];
}

/** Where a write lands: under a global, under a package, on the global object itself, under any global, or on nothing global. */
type Landing =
  | { kind: "global"; name: string; links: readonly string[] }
  | { kind: "package"; name: string; links: readonly string[] }
  | { kind: "global-object" }
  | { kind: "every"; links: readonly string[] }
  | { kind: "local" };

type BindingOf = (identifier: ts.Identifier) => LexicalBinding;

/**
 * Adds to `into` the roots one source writes through, and the members it writes: an assignment, compound assignment,
 * update, `delete`, destructuring or iteration target whose member path starts at a global (directly or through
 * `globalThis`, `window`, `self` or `global`) or at an imported binding, and the first argument of
 * `Object.defineProperty`, `Object.assign`, `Object.setPrototypeOf`, `Reflect.set` and their kin. What a name stands for
 * comes from the binder (ADR-0029): a local named like a global writes nothing global; a local declared from a path (a
 * variable's initializer, a parameter's default, a destructured element by its key or index) stands for that path, so a
 * write through it lands where the path starts. A chain through a call writes the call's result, not its root. A write
 * that reaches a prototype through `__proto__`, `constructor` or `getPrototypeOf`, a computed write on the global object,
 * an alias no path names (a computed key or a rest element over a global) and a literal that holds a global land on every
 * global.
 */
export function addWrittenRoots(path: string, text: string, parsed: ts.SourceFile, into: WrittenRoots, isGlobalName: (name: string) => boolean): void {
  if (!targetsOf(parsed).some((target) => mayWriteRoot(target, isGlobalName))) return;
  const { tree, bindingOf } = bindFile(path, text);
  for (const target of targetsOf(tree)) record(landing(pathOf(target.expression), bindingOf, 0, target.members !== undefined), target, into);
}

function record(landed: Landing, target: Target, into: WrittenRoots): void {
  if (landed.kind === "local") return;
  if (landed.kind === "global-object") {
    if (target.members === undefined || target.members === "unstated" || target.members.includes(COMPUTED)) into.everyGlobal = true;
    else for (const name of target.members) into.globals.add(name);
    return;
  }
  if (landed.kind === "every") into.everyGlobal = true;
  else if (landed.kind === "global") into.globals.add(landed.name);
  else into.packages.add(landed.name);
  const last = landed.links.at(-1);
  const members = target.members ?? (last === undefined ? [] : [last]);
  if (members !== "unstated") for (const member of members) if (member !== COMPUTED) into.members.add(member);
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
      const form = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? WRITING_CALLS.get(callee.expression.text)?.get(callee.name.text) : undefined;
      if (form !== undefined) targets.push({ expression: node.arguments[0], members: statedMembers(form, node.arguments.slice(1)) });
    }
    node.forEachChild(visit);
  };
  visit(tree);
  return targets;
}

/** The members a writing call names: its literal key, or the static keys of its object literals; unstated otherwise. */
function statedMembers(form: MemberForm, rest: readonly ts.Expression[]): readonly string[] | "unstated" {
  const values = rest.map(unwrapped);
  if (form === "key") return values[0] !== undefined && (ts.isStringLiteralLike(values[0]) || ts.isNumericLiteral(values[0])) ? [values[0].text] : "unstated";
  if (form === "unstated" || values.length === 0) return "unstated";
  const keys: string[] = [];
  for (const value of values) {
    if (!ts.isObjectLiteralExpression(value)) return "unstated";
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name) || ts.isPrivateIdentifier(property.name)) return "unstated";
      keys.push(property.name.text);
    }
  }
  return keys;
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

/** An expression's member path: `*` for a computed link, `name()` for a call. */
function pathOf(expression: ts.Expression): Path {
  const links: string[] = [];
  let node = unwrapped(expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) links.unshift(node.name.text);
    else if (ts.isElementAccessExpression(node)) links.unshift(ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : COMPUTED);
    else if (ts.isCallExpression(node)) links.unshift(`${ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ""}()`);
    else break;
    node = unwrapped(node.expression);
  }
  return { start: node, links };
}

/** A link that calls: what follows it is the call's result, a value the path's start does not hold. */
function isCall(link: string): boolean {
  return link.endsWith("()");
}

/** Whether a target's syntax alone may write a global or an import, so the source is worth binding. */
function mayWriteRoot(target: Target, isGlobalName: (name: string) => boolean): boolean {
  const { start, links } = pathOf(target.expression);
  if (links.some((link) => PROTOTYPE_LINKS.has(link))) return true;
  if (links.some(isCall) || start.kind === ts.SyntaxKind.ThisKeyword || start.kind === ts.SyntaxKind.SuperKeyword) return false;
  if (!ts.isIdentifier(start)) return true;
  return links.length > 0 || target.members !== undefined || isGlobalName(start.text) || GLOBAL_OBJECTS.has(start.text);
}

/**
 * Where a write through `path` lands, following the aliases it starts at. `stated` is true when a writing call names the
 * path's value itself as the object it writes, so a path of no links writes through what its start stands for.
 */
function landing({ start, links }: Path, bindingOf: BindingOf, depth: number, stated: boolean): Landing {
  if (links.some((link) => PROTOTYPE_LINKS.has(link))) return { kind: "every", links };
  if (links.some(isCall)) return { kind: "local" };
  if (!ts.isIdentifier(start)) return throughValue(start, links, bindingOf, depth, stated);
  const binding = bindingOf(start);
  if (binding.kind !== "declared") {
    if (!GLOBAL_OBJECTS.has(start.text)) return { kind: "global", name: start.text, links };
    const [first, ...below] = links;
    if (first === undefined) return { kind: "global-object" };
    return first === COMPUTED ? { kind: "every", links } : { kind: "global", name: first, links: below };
  }
  if (links.length === 0 && !stated) return { kind: "local" };
  if (depth >= ALIAS_DEPTH) return { kind: "every", links };
  const landings = binding.declarations.map((declaration): Landing => {
    const specifier = importSpecifierOf(declaration);
    if (specifier !== undefined) {
      const module = packageOf(specifier);
      return module === undefined ? { kind: "local" } : { kind: "package", name: module, links };
    }
    const source = sourceOf(declaration);
    if (source === undefined) return { kind: "local" };
    if (source === "unnamed") return everyIfGlobal(declaration, bindingOf, depth, links);
    return landing({ start: source.start, links: [...source.links, ...links] }, bindingOf, depth + 1, stated);
  });
  return landings.find((landed) => landed.kind === "every") ?? landings.find((landed) => landed.kind !== "local") ?? { kind: "local" };
}

/**
 * The path a declared name stands for: a variable's initializer, a parameter's default, or a destructured element's key or
 * index below its pattern's path. `unnamed` when the element takes a computed key or the rest; none when the name holds
 * no path.
 */
function sourceOf(declaration: ts.Node): Path | "unnamed" | undefined {
  if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) return declaration.initializer === undefined ? undefined : pathOf(declaration.initializer);
  if (!ts.isBindingElement(declaration)) return undefined;
  const pattern = declaration.parent;
  const base = sourceOf(pattern.parent);
  if (base === undefined || base === "unnamed") return base;
  if (declaration.dotDotDotToken !== undefined) return "unnamed";
  const key = ts.isArrayBindingPattern(pattern) ? String(pattern.elements.indexOf(declaration)) : keyOf(declaration);
  return key === undefined ? "unnamed" : { start: base.start, links: [...base.links, key] };
}

function keyOf(element: ts.BindingElement): string | undefined {
  const name = element.propertyName ?? element.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression))) return name.expression.text;
  return undefined;
}

/** An alias no path names lands on every global when the pattern it comes from starts at one, and on nothing global otherwise. */
function everyIfGlobal(element: ts.Declaration, bindingOf: BindingOf, depth: number, links: readonly string[]): Landing {
  let holder: ts.Node = element;
  while (ts.isBindingElement(holder)) holder = holder.parent.parent;
  const whole = sourceOf(holder);
  if (whole === undefined || whole === "unnamed") return { kind: "local" };
  const landed = landing({ start: whole.start, links: [...whole.links, COMPUTED] }, bindingOf, depth + 1, true);
  return landed.kind === "local" ? landed : { kind: "every", links };
}

/**
 * Where a path that starts at a value, not a name, lands: through a literal's member or element the links name, at what
 * that member holds; a write on the literal's own member is local. When the links name no member the literal states, the
 * path lands on every global if the value holds one anywhere, and on nothing global otherwise.
 */
function throughValue(start: ts.Expression, links: readonly string[], bindingOf: BindingOf, depth: number, stated: boolean): Landing {
  const [first, ...below] = links;
  if (first === undefined || (below.length === 0 && !stated)) return { kind: "local" };
  const held = depth < ALIAS_DEPTH ? memberOf(start, first) : undefined;
  if (held !== undefined) return landing({ start: held.start, links: [...held.links, ...below] }, bindingOf, depth + 1, stated);
  return holdsGlobal(start, bindingOf) ? { kind: "every", links } : { kind: "local" };
}

/** The path a literal states for one of its members, when nothing computed or spread can override it. */
function memberOf(literal: ts.Expression, key: string): Path | undefined {
  if (ts.isArrayLiteralExpression(literal)) {
    const element = literal.elements[Number(key)];
    return /^\d+$/.test(key) && !literal.elements.some(ts.isSpreadElement) && element !== undefined && !ts.isOmittedExpression(element) ? pathOf(element) : undefined;
  }
  if (!ts.isObjectLiteralExpression(literal) || literal.properties.some((property) => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name))) return undefined;
  const property = literal.properties.findLast((candidate) => !ts.isSpreadAssignment(candidate) && !ts.isPrivateIdentifier(candidate.name) && !ts.isComputedPropertyName(candidate.name) && candidate.name.text === key);
  if (property === undefined) return undefined;
  if (ts.isPropertyAssignment(property)) return pathOf(property.initializer);
  if (ts.isShorthandPropertyAssignment(property)) return { start: property.name, links: [] };
  return undefined;
}

/** Whether a value that is not a name holds a global inside it, so a path through it may reach that global. */
function holdsGlobal(start: ts.Expression, bindingOf: BindingOf): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isTypeNode(node) || ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isNewExpression(node) || ts.isCallExpression(node)) return;
    if (ts.isIdentifier(node) && !isMemberName(node) && bindingOf(node).kind !== "declared") found = true;
    node.forEachChild(visit);
  };
  visit(start);
  return found;
}

/** A name that labels a member, `b` in `a.b` or in `{ b: v }`, not one that reads a binding. */
function isMemberName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === identifier;
}

/** The module an import declaration of the binding names; none for any other declaration. */
function importSpecifierOf(declaration: ts.Declaration): string | undefined {
  let node: ts.Node = declaration;
  while (ts.isImportSpecifier(node) || ts.isNamedImports(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) node = node.parent;
  return ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}
