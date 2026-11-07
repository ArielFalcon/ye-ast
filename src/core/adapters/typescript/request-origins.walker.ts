import ts from "typescript";
import { ELEMENT, type AccessPath } from "../../domain/contracts/access-path.ts";
import type { Hop } from "../../domain/contracts/consumer-flow.ts";
import type { BranchCondition, Origin, OriginFrontierReason, OriginTrail, OriginValue } from "../../domain/contracts/request-origin.ts";
import { keepsLeft, wireOf, type WrittenValue } from "../../domain/languages/javascript.ts";
import type { ArgumentOrigins } from "../../ports/request-origins.port.ts";
import { memberDeclaration } from "./consumer-flow.classes.ts";
import { thisClass, unwrapped } from "./syntax.ts";
import type { Program } from "./consumer-flow.index.ts";
import {
  assignedBinding,
  declaredBinding,
  declaredScope,
  isDynamicName,
  isFunctionNode,
  isNullishLiteral,
  isUndeclaredName,
  literalOf,
  namedFunction,
  propertyNameText,
  receiptOf,
  referencesOf,
  searchRoot,
  type FunctionNode,
} from "./consumer-flow.syntax.ts";
import { lineOf, type RequestBody } from "./http-call-sites.adapter.ts";
import { createEscapes, isRewritten } from "./request-escapes.ts";

/** A call to a wrapper method: inside the wrapper's body its parameters hold the arguments of that call, which are written in the caller. */
interface Frame {
  id: string;
  function: FunctionNode;
  call: ts.CallExpression;
  parent: Frame | undefined;
}

/** The object the walk reached does not write the property at all; apart from an absence the code writes, which replaces earlier writes. */
type Lacks = OriginTrail & { kind: "lacks" };

/** A function or a symbol: the code holds it, so it passes `??` and `||` as any other value, and only the wire leaves it out. */
type Dropped = OriginTrail & { kind: "dropped" };

type Found = Origin | Lacks | Dropped;

const FORM_MODELS: ReadonlySet<string> = new Set(["FormGroup", "FormControl", "FormArray", "UntypedFormGroup", "UntypedFormControl", "UntypedFormArray"]);
const FORM_BUILDERS: ReadonlySet<string> = new Set(["group", "control", "array"]);
const ABSENT: OriginValue = { kind: "absent" };

const placeOf = (node: ts.Node) => ({ path: node.getSourceFile().fileName, line: lineOf(node.getSourceFile(), node) });
const trailOf = (node: ts.Node): OriginTrail => ({ at: placeOf(node), hops: [], conditions: [] });
const exact = (node: ts.Node, value: OriginValue): Origin => ({ kind: "exact", value, ...trailOf(node) });
export const frontier = (node: ts.Node, reason: OriginFrontierReason, detail?: string): Origin => ({ kind: "frontier", reason, ...(detail === undefined ? {} : { detail }), ...trailOf(node) });
const lacks = (node: ts.Node): Lacks => ({ kind: "lacks", ...trailOf(node) });
const dropped = (node: ts.Node): Dropped => ({ kind: "dropped", ...trailOf(node) });
const SERIALIZER = "toJSON";

/** An object that writes nothing there holds absence, and so does a property the wire leaves out. */
function close(found: readonly Found[]): Origin[] {
  return found.map((item) => (item.kind === "lacks" || item.kind === "dropped" ? { kind: "exact" as const, value: ABSENT, at: item.at, hops: item.hops, conditions: item.conditions } : item));
}

/** The origins as the answer states them: what the wire carries for the values the walk selected. */
function settle(found: readonly Found[]): Origin[] {
  return close(found).map((item) => (item.kind === "exact" && item.value.kind === "literal" ? { ...item, value: { kind: "literal" as const, value: wireOf(item.value.value) ?? null } } : item));
}

function extend<T extends Found>(found: readonly T[], { hop, condition }: { hop?: Hop; condition?: BranchCondition }): T[] {
  return found.map((item) => ({ ...item, hops: hop === undefined ? item.hops : [hop, ...item.hops], conditions: condition === undefined ? item.conditions : [condition, ...item.conditions] }));
}

/** The primitive a node writes, `approximate` when only its class is known, or nothing when it is no primitive. */
function writtenValue(node: ts.Expression): { value: WrittenValue } | "approximate" | undefined {
  if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isVoidExpression(node)) return { value: undefined };
  const literal = literalOf(node);
  if (literal !== undefined) return { value: literal };
  if (!ts.isTemplateExpression(node)) return undefined;
  let text = node.head.text;
  for (const span of node.templateSpans) {
    const part = writtenValue(unwrapped(span.expression));
    if (part === undefined || part === "approximate") return "approximate";
    text += String(part.value) + span.literal.text;
  }
  return { value: text };
}

/**
 * Walks an expression backward to the values that can sit at a path of it. Every answer is for one path, one frame of
 * wrapper bindings and one `body` mode, and is kept for the life of the walker: the code under walk does not change.
 */
export class OriginWalker {
  private readonly memo = new WeakMap<ts.Node, Map<string, readonly Found[]>>();
  private readonly active = new Set<string>();
  private readonly nodes = new WeakMap<ts.Node, number>();
  private readonly escapes: (read: ts.Expression) => boolean;
  private numbered = 0;

  constructor(program: Program) {
    this.escapes = createEscapes(program);
  }

  /** The origins of the body a request call sends, at `path`. */
  ofBody(request: RequestBody, path: AccessPath, call: ts.CallExpression): Origin[] {
    if (request.expression === undefined) return [frontier(call, "untracked", "no body argument")];
    let frame: Frame | undefined;
    for (const wrapper of request.wrappers) frame = { id: `${frame?.id ?? ""}/${this.nodeId(wrapper.call)}`, function: wrapper.function, call: wrapper.call, parent: frame };
    return settle(this.walk(request.expression, path, frame, true));
  }

  private nodeId(node: ts.Node): number {
    const held = this.nodes.get(node);
    if (held !== undefined) return held;
    this.numbered += 1;
    this.nodes.set(node, this.numbered);
    return this.numbered;
  }

  ofArgument(call: ts.CallExpression, index: number, path: AccessPath, body: boolean): ArgumentOrigins {
    if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return { kind: "passed", origins: [frontier(call, "untracked", "spread argument")] };
    const argument = call.arguments[index];
    if (argument === undefined || isUndefined(argument)) return { kind: "omitted" };
    return { kind: "passed", origins: settle(this.walk(argument, path, undefined, body)) };
  }

  private walk(expression: ts.Expression, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    const node = unwrapped(expression);
    const key = JSON.stringify([path, frame?.id ?? "", body]);
    const held = this.memo.get(node)?.get(key);
    if (held !== undefined) return held;
    const visiting = `${node.getSourceFile().fileName}:${node.pos}:${node.end}:${key}`;
    if (this.active.has(visiting)) return [frontier(node, "untracked", "cycle")];
    this.active.add(visiting);
    const found = this.dispatch(node, path, frame, body);
    this.active.delete(visiting);
    const kept = this.memo.get(node) ?? new Map<string, readonly Found[]>();
    kept.set(key, found);
    this.memo.set(node, kept);
    return found;
  }

  private dispatch(node: ts.Expression, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    if (ts.isConditionalExpression(node)) {
      const test = { expression: node.condition.getText(node.getSourceFile()), at: placeOf(node.condition) };
      return [
        ...extend(this.walk(node.whenTrue, path, frame, body), { condition: { ...test, holds: true } }),
        ...extend(this.walk(node.whenFalse, path, frame, body), { condition: { ...test, holds: false } }),
      ];
    }
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return this.logical(node, path, frame, body);
    if (ts.isIdentifier(node)) return this.name(node, path, frame, body);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return this.property(node, path, frame);
    if (ts.isObjectLiteralExpression(node)) return this.object(node, path, frame);
    if (ts.isArrayLiteralExpression(node)) return this.array(node, path, frame);
    if (node.kind === ts.SyntaxKind.ThisKeyword) return [frontier(node, "member", "this")];
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return this.heldFunction(node, path);
    if (ts.isNewExpression(node)) return [frontier(node, "construction", node.expression.getText(node.getSourceFile()))];
    if (ts.isCallExpression(node)) return this.call(node, path, frame, body);
    return this.primitive(node, path);
  }

  /** A function or a symbol has no JSON form: the property is left out and an array slot holds null, but only where the walk settles it. */
  private heldFunction(node: ts.Expression, path: AccessPath): readonly Found[] {
    return path.length === 0 ? [dropped(node)] : [frontier(node, "untracked", "not an object")];
  }

  private primitive(node: ts.Expression, path: AccessPath): readonly Found[] {
    const written = writtenValue(node);
    if (written === undefined) return [frontier(node, "untracked", ts.SyntaxKind[node.kind])];
    if (path.length > 0) return [frontier(node, "untracked", "not an object")];
    if (written === "approximate") return [{ kind: "approximate", class: "string", ...trailOf(node) }];
    return [exact(node, written.value === undefined ? ABSENT : { kind: "literal", value: written.value })];
  }

  /**
   * `left OP right`: the left side's own value decides, since the operator tests it and not a property of it. A left side
   * the walk cannot decide keeps its uncertainty and proves nothing about the right.
   */
  private logical(node: ts.BinaryExpression, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    const operator = node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ? "??" : "||";
    const lefts = this.walk(node.left, [], frame, body);
    const outcomes = lefts.map((left) => outcomeOf(operator, left));
    const fails = outcomes.includes("fails");
    if (path.length === 0) {
      const kept = lefts.filter((_, index) => outcomes[index] !== "fails");
      return fails ? [...kept, ...this.walk(node.right, [], frame, body)] : kept;
    }
    if (outcomes.includes("unknown") || !fails) return this.walk(node.left, path, frame, body);
    return outcomes.includes("keeps") ? [...this.walk(node.left, path, frame, body), ...this.walk(node.right, path, frame, body)] : this.walk(node.right, path, frame, body);
  }

  private property(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, path: AccessPath, frame: Frame | undefined): readonly Found[] {
    const object = unwrapped(node.expression);
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : keyOf(node.argumentExpression);
    if (key === undefined) return [frontier(node, "untracked", "computed key")];
    if (object.kind === ts.SyntaxKind.ThisKeyword) return [frontier(node, "member", key)];
    if (key === "value" && isFormModel(object)) return [frontier(node, "form-value")];
    return this.walk(object, [key, ...path], frame, false);
  }

  private call(node: ts.CallExpression, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    const callee = unwrapped(node.expression);
    if (ts.isIdentifier(callee) && callee.text === "Symbol" && isUndeclaredName(callee)) return this.heldFunction(node, path);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = unwrapped(callee.expression);
      if (callee.name.text === "stringify" && ts.isIdentifier(receiver) && receiver.text === "JSON" && isUndeclaredName(receiver)) {
        if (node.arguments.length !== 1) return [frontier(node, "untracked", "stringify arguments")];
        if (body) return this.walk(node.arguments[0]!, path, frame, true);
        return path.length === 0 ? [{ kind: "approximate", class: "string", ...trailOf(node) }] : [frontier(node, "untracked", "serialized string")];
      }
      if (callee.name.text === "getRawValue" || (callee.name.text === "get" && isFormModel(receiver))) return [frontier(node, "form-value")];
    }
    return [frontier(node, "call-result", ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined)];
  }

  private object(node: ts.ObjectLiteralExpression, path: AccessPath, frame: Frame | undefined): readonly Found[] {
    if (this.serializes(node, frame)) return [frontier(node, "untracked", SERIALIZER)];
    const [name, ...rest] = path;
    if (name === undefined) return [exact(node, { kind: "object" })];
    if (name === ELEMENT) return [frontier(node, "untracked", "element of an object")];
    let state: readonly Found[] = [lacks(node)];
    for (const member of node.properties) {
      if (ts.isSpreadAssignment(member)) {
        state = this.spread(member, state, path, frame);
        continue;
      }
      const key = member.name === undefined ? undefined : propertyNameText(member.name);
      if (key === undefined) state = [frontier(member, "untracked", "computed key")];
      else if (key !== name) continue;
      else if (ts.isPropertyAssignment(member)) state = this.written(this.walk(member.initializer, rest, frame, false), rest);
      else if (ts.isShorthandPropertyAssignment(member)) state = this.written(this.walk(member.name, rest, frame, false), rest);
      else state = [frontier(member, "untracked", "accessor or method")];
    }
    return state;
  }

  /**
   * Whether the literal serializes through code it carries: a `toJSON` member, a prototype it sets, or a spread of an
   * object the walk sees carry one. That code answers for the whole object, so no write of a property can settle it.
   */
  private serializes(node: ts.ObjectLiteralExpression, frame: Frame | undefined): boolean {
    return node.properties.some((member) => {
      if (ts.isSpreadAssignment(member)) return !isNullishLiteral(member.expression) && this.walk(member.expression, [SERIALIZER], frame, false).some((item) => item.kind === "frontier" && item.detail === SERIALIZER);
      const key = member.name === undefined ? undefined : propertyNameText(member.name);
      return key === SERIALIZER || (key === "__proto__" && ts.isPropertyAssignment(member));
    });
  }

  /** What a definite write of the first segment leaves for the rest of the path: the value written lacking it is absence, and replaces every earlier write. */
  private written(found: readonly Found[], rest: AccessPath): readonly Found[] {
    return rest.length === 0 ? found : close(found);
  }

  /**
   * A spread replaces what it carries; the earlier writes survive only where the spread is proven to lack the property.
   * One whose presence is unknown, or that the callers decide, may overwrite them, so they are no longer exact.
   */
  private spread(member: ts.SpreadAssignment, state: readonly Found[], path: AccessPath, frame: Frame | undefined): readonly Found[] {
    if (isNullishLiteral(member.expression)) return state;
    const carried = this.walk(member.expression, path, frame, false).map((item) => (item.kind === "parameter" ? frontier(member, "untracked", "spread parameter") : item));
    return [...(carried.some((item) => item.kind === "lacks") ? state : []), ...carried.filter((item) => item.kind !== "lacks")];
  }

  private array(node: ts.ArrayLiteralExpression, path: AccessPath, frame: Frame | undefined): readonly Found[] {
    const [first, ...rest] = path;
    if (first === undefined) return [exact(node, { kind: "array" })];
    if (first !== ELEMENT) return [frontier(node, "untracked", "property of an array")];
    return node.elements.flatMap((element): Found[] => {
      if (ts.isSpreadElement(element)) return [frontier(element, "untracked", "spread element")];
      if (ts.isOmittedExpression(element)) return [rest.length === 0 ? exact(element, { kind: "literal", value: null }) : frontier(element, "untracked", "not an object")];
      return close(this.walk(element, rest, frame, false)).map((item) => (rest.length === 0 && item.kind === "exact" && item.value.kind === "absent" ? { ...item, value: { kind: "literal" as const, value: null } } : item));
    });
  }

  private name(node: ts.Identifier, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    if (isDynamicName(node)) return [frontier(node, "untracked", "dynamic scope")];
    if (isUndeclaredName(node)) {
      const value = node.text === "undefined" ? ABSENT : node.text === "NaN" ? ({ kind: "literal", value: Number.NaN } as const) : node.text === "Infinity" ? ({ kind: "literal", value: Infinity } as const) : undefined;
      if (value === undefined) return [frontier(node, "untracked", node.text)];
      return path.length === 0 ? [exact(node, value)] : [frontier(node, "untracked", "not an object")];
    }
    const declaration = declarationOf(node);
    if (declaration !== undefined && ts.isParameter(declaration)) return this.parameter(node, declaration, path, frame, body);
    if (declaration !== undefined && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) return this.local(node, declaration, declaration.name, declaration.initializer, path, frame, body);
    const destructured = declaration !== undefined && ts.isBindingElement(declaration) ? destructuring(declaration) : undefined;
    if (destructured !== undefined) return this.local(node, destructured.variable, destructured.name, destructured.variable.initializer, [destructured.key, ...path], frame, body);
    return [frontier(node, "untracked", declaration === undefined ? "declaration" : ts.SyntaxKind[declaration.kind])];
  }

  /** A variable is its initializer (or a property of it, when destructured) only when nothing can have changed it between the declaration and the read. */
  private local(read: ts.Identifier, declaration: ts.VariableDeclaration, name: ts.Identifier, initializer: ts.Expression | undefined, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    const binding = declaredBinding(name, declaredScope(declaration));
    const root = searchRoot(binding);
    const { reads, dynamic } = referencesOf(binding);
    const primitive = initializer !== undefined && ts.isIdentifier(declaration.name) && writtenValue(unwrapped(initializer)) !== undefined;
    if (isRewritten(root, binding)) return [frontier(read, "mutated", "written")];
    if (dynamic.length > 0 || (!primitive && reads.some((other) => other !== read && this.escapes(other)))) return [frontier(read, "mutated", "escapes")];
    if (initializer === undefined) return [frontier(read, "untracked", "no initializer")];
    return extend(this.walk(initializer, path, frame, body), { hop: { step: "assign", evidence: placeOf(declaration) } });
  }

  private parameter(read: ts.Identifier, declaration: ts.ParameterDeclaration, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    const fn = declaration.parent;
    if (!isFunctionNode(fn) || !ts.isIdentifier(declaration.name) || declaration.dotDotDotToken !== undefined) return [frontier(read, "untracked", "rest parameter")];
    const index = fn.parameters.indexOf(declaration);
    if (receiptOf(fn, index).hidden) return [frontier(read, "untracked", "arguments")];
    const binding = declaredBinding(declaration.name, fn);
    if (isRewritten(fn, binding)) return [frontier(read, "mutated", "written")];
    if (referencesOf(binding).reads.some((other) => other !== read && this.escapes(other))) return [frontier(read, "mutated", "escapes")];
    for (let held = frame; held !== undefined; held = held.parent) {
      if (held.function === fn) return this.bound(held, declaration, index, path, body);
    }
    const named = namedFunction(fn);
    if (named === undefined) return [frontier(read, "unresolved-callers", "anonymous function")];
    const tree = read.getSourceFile();
    const omitted = settle(this.omitted(declaration, path, undefined, body));
    return [{ kind: "parameter", ...trailOf(declaration), parameter: { file: tree.fileName, symbol: named.name, line: lineOf(tree, named.declaration), index, path, body, omitted } }];
  }

  /** The parameter of a wrapper method holds what this call passes, evaluated where the call is made. */
  private bound(frame: Frame, declaration: ts.ParameterDeclaration, index: number, path: AccessPath, body: boolean): readonly Found[] {
    const { call } = frame;
    if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return [frontier(call, "untracked", "spread argument")];
    const argument = call.arguments[index];
    const hop: Hop = { step: "argument", evidence: placeOf(call) };
    const found = argument === undefined || isUndefined(argument) ? this.omitted(declaration, path, frame, body) : this.walk(argument, path, frame.parent, body);
    return extend(found, { hop });
  }

  /** What a parameter holds when no argument reaches it: its default, which only an omitted or `undefined` argument takes, or absence. */
  private omitted(declaration: ts.ParameterDeclaration, path: AccessPath, frame: Frame | undefined, body: boolean): readonly Found[] {
    if (declaration.initializer !== undefined) return this.walk(declaration.initializer, path, frame, body);
    return path.length === 0 ? [exact(declaration, ABSENT)] : [frontier(declaration, "untracked", "not an object")];
  }
}

function outcomeOf(operator: "??" | "||", left: Found): "keeps" | "fails" | "unknown" {
  if (left.kind === "dropped") return "keeps";
  if (left.kind !== "exact") return "unknown";
  if (left.value.kind === "absent") return "fails";
  if (left.value.kind !== "literal") return "keeps";
  return keepsLeft(operator, left.value.value) ? "keeps" : "fails";
}

const isUndefined = (expression: ts.Expression): boolean => {
  const bare = unwrapped(expression);
  return ts.isVoidExpression(bare) || (ts.isIdentifier(bare) && bare.text === "undefined" && isUndeclaredName(bare));
};

/** The variable and the property a name destructured from an object pattern stands for: `const { key: name } = value`, without a default, a rest or a nested pattern. */
function destructuring(element: ts.BindingElement): { variable: ts.VariableDeclaration; name: ts.Identifier; key: string } | undefined {
  const pattern = element.parent;
  if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(pattern.parent) || element.dotDotDotToken !== undefined || element.initializer !== undefined || !ts.isIdentifier(element.name)) return undefined;
  const key = element.propertyName === undefined ? element.name.text : propertyNameText(element.propertyName);
  return key === undefined ? undefined : { variable: pattern.parent, name: element.name, key };
}

/** A key an element access names literally; a number or any other expression is not one. */
function keyOf(expression: ts.Expression): string | undefined {
  const key = unwrapped(expression);
  return ts.isStringLiteralLike(key) ? key.text : undefined;
}

/** The declaration a name binds in its file, found from the position the binder gives its first declaration. */
function declarationOf(identifier: ts.Identifier): ts.Node | undefined {
  const binding = assignedBinding(identifier);
  if (binding?.kind !== "name" || binding.binds === undefined) return undefined;
  const tree = identifier.getSourceFile();
  let current: ts.Node = tree;
  for (;;) {
    const child = ts.forEachChild(current, (candidate) => (candidate.getStart(tree) <= binding.binds! && binding.binds! < candidate.end ? candidate : undefined));
    if (child === undefined) break;
    current = child;
  }
  return ts.isIdentifier(current) && current.getStart(tree) === binding.binds ? current.parent : undefined;
}

/** A form model: a field or variable declared as one of Angular's form classes or built by a form builder. */
function isFormModel(expression: ts.Expression): boolean {
  const bare = unwrapped(expression);
  let declaration: ts.Node | undefined;
  if (ts.isPropertyAccessExpression(bare) && bare.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const owner = thisClass(bare);
    declaration = owner === undefined ? undefined : memberDeclaration(owner, bare.name.text);
  } else if (ts.isIdentifier(bare)) {
    declaration = declarationOf(bare);
  }
  if (declaration === undefined || !(ts.isPropertyDeclaration(declaration) || ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))) return false;
  const type = declaration.type;
  if (type !== undefined && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && FORM_MODELS.has(type.typeName.text)) return true;
  const initializer = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
  if (initializer !== undefined && ts.isNewExpression(initializer)) return ts.isIdentifier(initializer.expression) && FORM_MODELS.has(initializer.expression.text);
  return initializer !== undefined && ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression) && FORM_BUILDERS.has(initializer.expression.name.text);
}
