import ts from "typescript";
import { bindFile, type LexicalBinding, unwrapped } from "./lexical-bindings.ts";
import { packageOf } from "./module-resolver.ts";

/**
 * What the snapshot's sources write: member paths from the global they start at, keyed by their joined segments, and
 * packages by name. A `*` segment is a name the write does not state (`Array.prototype[k] = f` writes
 * `Array.prototype.*`); a path that starts at `*` starts at a global no name states.
 */
export interface WrittenRoots {
  paths: Map<string, readonly string[]>;
  packages: Set<string>;
}

/** Names that hold the global object itself, so `globalThis.Math.max = f` writes through `Math`. */
export const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "window", "self", "global"]);

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

/** Where a write lands: at a member path from the global object (`[]` is the global object itself), or under a package. */
type Landing = { kind: "global"; path: readonly string[] } | { kind: "package"; name: string };

type BindingOf = (identifier: ts.Identifier) => LexicalBinding;

/**
 * Adds to `into` the member paths one source writes, and the packages it writes through: an assignment, compound assignment,
 * update, `delete`, destructuring or iteration target whose member path starts at a global (directly or through
 * `globalThis`, `window`, `self` or `global`) or at an imported binding, and the first argument of
 * `Object.defineProperty`, `Object.assign`, `Object.setPrototypeOf`, `Reflect.set` and their kin. What a name stands for
 * comes from the binder (ADR-0029): a local named like a global writes nothing global; a local declared from a path (a
 * variable's initializer, a parameter's default, a destructured element by its key or index) stands for that path, so a
 * write through it lands where the path starts. A chain through a call writes the call's result, not its root. A name the
 * write does not state is a `*` segment: a computed key or index, a member a writing call computes, a destructured element
 * by a computed key or the rest. A write that reaches a prototype through `__proto__`, `constructor` or `getPrototypeOf`
 * writes `*.prototype` and what follows, and one through a value that holds globals writes under each of them.
 */
export function addWrittenRoots(path: string, text: string, parsed: ts.SourceFile, into: WrittenRoots, isGlobalName: (name: string) => boolean): void {
  if (!targetsOf(parsed).some((target) => mayWriteRoot(target, isGlobalName))) return;
  const { tree, bindingOf } = bindFile(path, text);
  for (const target of targetsOf(tree)) for (const landed of landing(pathOf(target.expression), bindingOf, 0, target.members !== undefined)) record(landed, target, into);
}

/**
 * Records where a write lands. A store writes its path, a path's every member when it ends at the global object or a
 * prototype; a writing call writes the members it states below its path, or every member when it states none.
 */
function record(landed: Landing, target: Target, into: WrittenRoots): void {
  if (landed.kind === "package") return void into.packages.add(landed.name);
  const { path } = landed;
  const written = target.members === undefined ? [path.length === 0 || path.at(-1) === "prototype" ? [...path, COMPUTED] : path] : target.members === "unstated" ? [[...path, COMPUTED]] : target.members.map((member) => [...path, member]);
  for (const segments of written) into.paths.set(segments.join("\u0000"), segments);
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
function landing({ start, links }: Path, bindingOf: BindingOf, depth: number, stated: boolean): Landing[] {
  const prototypeAt = links.findLastIndex((link) => PROTOTYPE_LINKS.has(link));
  if (prototypeAt >= 0) {
    const below = links.slice(prototypeAt + 1);
    return [{ kind: "global", path: [COMPUTED, "prototype", ...(below[0] === "prototype" ? below.slice(1) : below)] }];
  }
  if (links.some(isCall)) return [];
  if (!ts.isIdentifier(start)) return throughValue(start, links, bindingOf, depth, stated);
  const binding = bindingOf(start);
  if (binding.kind !== "declared") return [{ kind: "global", path: GLOBAL_OBJECTS.has(start.text) ? links : [start.text, ...links] }];
  if (links.length === 0 && !stated) return [];
  if (depth >= ALIAS_DEPTH) return [{ kind: "global", path: [COMPUTED] }];
  return binding.declarations.flatMap((declaration): Landing[] => {
    const specifier = importSpecifierOf(declaration);
    if (specifier !== undefined) {
      const module = packageOf(specifier);
      return module === undefined ? [] : [{ kind: "package", name: module }];
    }
    const source = sourceOf(declaration);
    if (source === undefined) return [];
    if (source === "unnamed") return throughOpaqueAlias(declaration, bindingOf, depth, links, stated);
    return landing({ start: source.start, links: [...source.links, ...links] }, bindingOf, depth + 1, stated);
  });
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

/** An alias a pattern takes by a computed key or the rest stands for an unstated member of the whole pattern's path. */
function throughOpaqueAlias(element: ts.Declaration, bindingOf: BindingOf, depth: number, links: readonly string[], stated: boolean): Landing[] {
  let holder: ts.Node = element;
  while (ts.isBindingElement(holder)) holder = holder.parent.parent;
  const whole = sourceOf(holder);
  return whole === undefined || whole === "unnamed" ? [] : landing({ start: whole.start, links: [...whole.links, COMPUTED, ...links] }, bindingOf, depth + 1, stated);
}

/**
 * Where a path that starts at a value, not a name, lands: through a literal's member or element the links name, at what
 * that member holds; a write on the literal's own member is local. When the links name no member the literal states, at
 * every value the expression may hold, each at the links below its place in the literal.
 */
function throughValue(start: ts.Expression, links: readonly string[], bindingOf: BindingOf, depth: number, stated: boolean): Landing[] {
  if (depth >= ALIAS_DEPTH) return [{ kind: "global", path: [COMPUTED] }];
  const [first, ...below] = links;
  const held = first === undefined || (below.length === 0 && !stated) ? undefined : memberOf(start, first);
  if (held !== undefined) return landing({ start: held.start, links: [...held.links, ...below] }, bindingOf, depth + 1, stated);
  return valuesIn(start, 0).flatMap(({ value, nesting }) => {
    const rest = links.slice(nesting);
    return nesting > links.length || (rest.length === 0 && !stated) ? [] : landing({ start: value.start, links: [...value.links, ...rest] }, bindingOf, depth + 1, stated);
  });
}

/**
 * The paths an expression may hold, each with how many members deep a literal holds it: both branches of a conditional or
 * a logical operator, the members and elements of a literal one level deeper, a spread at its own level. A value no name
 * or literal starts (a call, `new`, `this`, a function) holds none.
 */
function valuesIn(expression: ts.Expression, nesting: number): { value: Path; nesting: number }[] {
  const node = unwrapped(expression);
  if (ts.isConditionalExpression(node)) return [...valuesIn(node.whenTrue, nesting), ...valuesIn(node.whenFalse, nesting)];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.QuestionQuestionToken) return [...valuesIn(node.left, nesting), ...valuesIn(node.right, nesting)];
    return operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken ? valuesIn(node.right, nesting) : [];
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => (ts.isSpreadElement(element) ? valuesIn(element.expression, nesting) : ts.isOmittedExpression(element) ? [] : valuesIn(element, nesting + 1)));
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => (ts.isPropertyAssignment(property) ? valuesIn(property.initializer, nesting + 1) : ts.isSpreadAssignment(property) ? valuesIn(property.expression, nesting) : ts.isShorthandPropertyAssignment(property) ? [{ value: { start: property.name, links: [] }, nesting: nesting + 1 }] : []));
  }
  const value = pathOf(node);
  return ts.isIdentifier(value.start) || ts.isArrayLiteralExpression(value.start) || ts.isObjectLiteralExpression(value.start) ? [{ value, nesting }] : [];
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

/** The module an import declaration of the binding names; none for any other declaration. */
function importSpecifierOf(declaration: ts.Declaration): string | undefined {
  let node: ts.Node = declaration;
  while (ts.isImportSpecifier(node) || ts.isNamedImports(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) node = node.parent;
  return ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}
