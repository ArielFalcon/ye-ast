import ts from "typescript";
import { ELEMENT, relatePaths, rewritePath, startsWith, type AccessPath, type PathMapping } from "../../domain/contracts/access-path.ts";
import { RESOURCE_STATE_MEMBERS, type CarrierSite, type FlowFrontier, type FlowNext, type FlowStep, type FlowUse, type FrontierCause, type Hop } from "../../domain/contracts/consumer-flow.ts";
import type { Absence, AccessStep, EqualityOperator, Literal, Predicate, UseEnd, UseOperation } from "../../domain/contracts/use-operation.ts";
import type { FallbackGuard, Guard, TestedGuard, UntestedGuard } from "../../domain/contracts/verdict.ts";
import type { Evidence, UnknownReason } from "../../domain/shared/fact.ts";
import type { Origin, Program, Unit } from "./consumer-flow.index.ts";
import {
  assignedBinding,
  chainPath,
  declaredBinding,
  declaredScope,
  discardsValue,
  declaringScope,
  isDynamicName,
  isUndeclaredName,
  enclosingClass,
  enclosingFunction,
  enclosingLoop,
  exits,
  isAsyncOrGenerator,
  isFunctionNode,
  isNullishLiteral,
  isNumericUnary,
  literalOf,
  isTransparent,
  mayNotFollow,
  namedFunction,
  referencesOf,
  replacementOf,
  searchRoot,
  unwrap,
  writesWithin,
  type Binding,
  type FunctionNode,
  type NamedFunction,
} from "./consumer-flow.syntax.ts";
import { constructorParameters, lineOf, propertyOf, symbolOf, typeName, VERBS } from "./http-call-sites.adapter.ts";

/** A value being followed: where the changed property sits in it, the steps taken, and the guards that hold on it. */
interface Trail {
  origin: AccessPath;
  hops: readonly Hop[];
  guards: readonly Guard[];
  binding?: Binding;
  /** The path that was read off the previous value to reach this one, until the next hop records it. */
  projected?: AccessPath;
}

export interface Held<T> {
  file: string;
  pos: number;
  value: T;
}

type Resolved = { kind: "function"; file: string; named: NamedFunction } | { kind: "external" };

const PRESENT: Predicate = { kind: "absence", operator: "!=", absence: "null" };
const TRUTHY: Predicate = { kind: "truthy" };
const EQUALITY: ReadonlyMap<ts.SyntaxKind, EqualityOperator> = new Map([
  [ts.SyntaxKind.EqualsEqualsToken, "=="],
  [ts.SyntaxKind.ExclamationEqualsToken, "!="],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "==="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!=="],
]);
const KEEPING_OPERATORS: ReadonlySet<string> = new Set([
  "catchError",
  "tap",
  "filter",
  "take",
  "takeLast",
  "first",
  "last",
  "finalize",
  "shareReplay",
  "share",
  "takeUntil",
  "takeWhile",
  "skip",
  "skipWhile",
  "skipLast",
  "distinctUntilChanged",
  "debounceTime",
  "throttleTime",
  "delay",
  "retry",
  "timeout",
  "observeOn",
  "subscribeOn",
]);
const CALLBACK_OPERATORS: ReadonlySet<string> = new Set(["tap", "filter"]);
const STREAM_WRITES: ReadonlySet<string> = new Set(["set", "next"]);
const ACCESSORS: ReadonlySet<string> = new Set(["value", "json"]);
const ROUTE_HOLDER = "ActivatedRoute";

const isRxjs = (module: string | undefined): boolean => module === "rxjs" || module?.startsWith("rxjs/") === true;
const isCore = (module: string | undefined): boolean => module === "@angular/core" || module?.startsWith("@angular/core/") === true;

function translate(guards: readonly Guard[], mappings: readonly PathMapping[]): Guard[] {
  return guards.flatMap((guard) => {
    const [covers] = rewritePath(guard.covers, mappings);
    return covers === undefined ? [] : [{ ...guard, covers }];
  });
}

function protects(guard: Guard, path: AccessPath): boolean {
  return guard.kind !== "non-null-assertion" && startsWith(guard.covers, path);
}

export class Walker {
  readonly uses: Held<FlowUse>[] = [];
  readonly next: Held<FlowNext>[] = [];
  readonly frontiers: Held<FlowFrontier>[] = [];
  private readonly visited = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly clauseTests = new WeakMap<ts.CaseOrDefaultClause, ClauseTest>();

  constructor(
    private readonly repo: string,
    private readonly program: Program,
    readonly unit: Unit,
  ) {}

  startCallSite(site: { line: number; symbol: string }, path: AccessPath): void {
    const call = this.calls().find((candidate) => lineOf(this.unit.tree, candidate) === site.line && symbolOf(candidate) === site.symbol && this.requestKind(candidate) !== undefined);
    if (call === undefined) return this.lostAt(site.line, "no call at the reported site");
    const kind = this.requestKind(call)!;
    const start: Trail = { origin: path, hops: [], guards: [] };
    if (kind === "resource") return this.read(call, this.hopped(this.rewrapped(start, ["value"]), "resource", call));
    if (kind === "fetch") return this.read(call, this.hopped(this.rewrapped(start, ["json"]), "response-body", call, [{ from: [], to: ["json"] }]));
    const observed = this.observed(call);
    if (observed === "events") return this.frontier(call, "unmodelled-flow", "observe events", start);
    if (observed === "response") return this.read(call, this.hopped(this.rewrapped(start, ["body"]), "response-body", call, [{ from: [], to: ["body"] }]));
    this.read(call, start);
  }

  startCallResult(site: { line: number; column?: number; callee: string }, path: AccessPath): void {
    const named = this.calls().filter((call) => calleeName(call) === site.callee);
    const here = named.filter((call) => lineOf(this.unit.tree, call) === site.line);
    const candidates = here.length > 0 ? here : named.filter((call) => this.startLine(call) <= site.line && site.line <= this.endLine(call));
    const narrowed = site.column === undefined ? candidates : candidates.filter((call) => this.columns(call).includes(site.column!));
    const call = narrowed.length === 1 ? narrowed[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (call === undefined) return this.lostAt(site.line, candidates.length === 0 ? "no call of the callee at the reported edge" : "several calls of the callee at the reported edge");
    this.read(call, { origin: path, hops: [], guards: [] });
  }

  startParameter(site: { symbol: string; line: number; index: number }, path: AccessPath): void {
    const fn = this.functionAt(site.symbol, site.line);
    const parameter = fn?.node.parameters[site.index];
    if (fn === undefined || parameter === undefined || parameter.dotDotDotToken !== undefined) return this.lostAt(site.line, "no parameter at the reported position");
    this.bind(parameter.name, fn.node, { origin: path, hops: [], guards: [] });
  }

  startMember(site: { owner: string; member: string; line?: number }, path: AccessPath): void {
    const cls = this.classNamed(site.owner);
    if (cls === undefined) return this.lostAt(site.line ?? 1, "member owner not found");
    const start: Trail = { origin: path, hops: [], guards: [] };
    const setter = cls.members.find((member): member is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(member) && member.name.getText(this.unit.tree) === site.member);
    const parameter = setter?.parameters[0];
    if (setter !== undefined && parameter !== undefined) this.bind(parameter.name, setter, start);
    else if (memberDeclaration(cls, site.member) === undefined) return this.lostAt(site.line ?? 1, "member not found in its owner");
    this.track({ kind: "member", name: site.member, scope: cls }, start);
  }

  /** The reads of `ActivatedRoute` data of a component class, for the resolver key that feeds it. */
  startRouteData(className: string, key: string, path: AccessPath, hops: readonly Hop[]): void {
    const cls = this.classNamed(className);
    if (cls === undefined) return;
    const holders = this.routeHolders(cls);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "data" && this.isRouteData(node, holders)) {
        this.read(node, { origin: [key, ...path], hops: [...hops, { step: "route-data", evidence: this.at(node) }], guards: [] });
      }
      node.forEachChild(visit);
    };
    visit(cls);
  }

  at(node: ts.Node): Evidence {
    return { path: this.unit.file, line: lineOf(this.unit.tree, node) };
  }

  frontierAt(node: ts.Node, cause: FrontierCause, detail: string | undefined, hops: readonly Hop[], reason: UnknownReason = "unresolved"): void {
    this.frontiers.push({ file: this.unit.file, pos: node.getStart(this.unit.tree), value: { at: this.at(node), cause, reason, ...(detail === undefined ? {} : { detail }), hops } });
  }

  private lostAt(line: number, detail: string): void {
    this.frontiers.push({ file: this.unit.file, pos: 0, value: { at: { path: this.unit.file, line }, cause: "unmodelled-flow", reason: "unresolved", detail, hops: [] } });
  }

  private frontier(node: ts.Node, cause: FrontierCause, detail: string | undefined, t: Trail, reason: UnknownReason = "unresolved"): void {
    this.frontierAt(node, cause, detail, t.hops, reason);
  }

  private use(node: ts.Node, t: Trail, path: AccessPath, operation: UseOperation, guards: readonly Guard[]): void {
    const reachingGuards = guards.filter((guard) => startsWith(guard.covers, t.origin));
    this.uses.push({ file: this.unit.file, pos: node.getStart(this.unit.tree), value: { site: this.at(node), path, changed: t.origin, operation, guards: reachingGuards, hops: t.hops } });
  }

  private hopped(t: Trail, step: FlowStep, node: ts.Node, rewrite?: readonly PathMapping[]): Trail {
    const mapping = rewrite ?? (t.projected !== undefined && t.projected.length > 0 ? [{ from: t.projected, to: [] }] : undefined);
    const hop: Hop = { step, evidence: this.at(node), ...(mapping === undefined ? {} : { rewrite: mapping }) };
    return { origin: t.origin, guards: t.guards, hops: [...t.hops, hop], ...(t.binding === undefined ? {} : { binding: t.binding }) };
  }

  private rewrapped(t: Trail, prefix: AccessPath): Trail {
    return { origin: [...prefix, ...t.origin], hops: t.hops, guards: translate(t.guards, [{ from: [], to: prefix }]) };
  }

  private untested(kind: UntestedGuard["kind"], covers: AccessPath, node: ts.Node): UntestedGuard {
    return { kind, covers, evidence: this.at(node) };
  }

  private tested(kind: TestedGuard["kind"], covers: AccessPath, test: Predicate, holds: boolean, node: ts.Node): TestedGuard {
    return { kind, covers, test, holds, evidence: this.at(node) };
  }

  private fallback(test: Predicate, right: ts.Expression, node: ts.Node): FallbackGuard {
    return { kind: "fallback", covers: [], test, holds: true, replacement: replacementOf(right), evidence: this.at(node) };
  }

  /** Reads the value `reference` holds, from the chain of reads that start there to what the code does with the result. */
  private read(reference: ts.Expression, t: Trail): void {
    const key = `${reference.pos}:${reference.end}:${t.origin.join("\0")}`;
    if (this.visited.has(key)) return;
    this.visited.add(key);
    let top = reference;
    let q: AccessPath = [];
    const chain: Guard[] = [];
    const steps: AccessStep[] = [];
    let beyondAt: ts.Node | undefined;
    const advance = (segment: string, node: ts.Node, optional: boolean, parent: ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
      if (optional) chain.push(this.tested("optional-chain", q, PRESENT, true, node));
      if (reachesChange(q, t)) steps.push(accessStep(parent));
      q = [...q, segment];
      if (beyondAt === undefined && relatePaths(q, t.origin) === "beyond") beyondAt = node;
      top = parent;
    };
    for (;;) {
      const parent = top.parent;
      if (isTransparent(parent)) {
        top = parent as ts.Expression;
      } else if (ts.isNonNullExpression(parent)) {
        chain.push(this.untested("non-null-assertion", q, parent));
        top = parent;
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === top) {
        const call = parent.parent;
        const optional = parent.questionDotToken !== undefined;
        if (ts.isCallExpression(call) && call.expression === parent && this.readsAccessor(parent, call, q, t)) {
          advance(parent.name.text, parent.name, optional, parent);
          top = call;
        } else if (ts.isCallExpression(call) && call.expression === parent && this.isMethod(parent, call, q, t)) {
          if (optional) chain.push(this.tested("optional-chain", q, PRESENT, true, parent.name));
          return this.methodCall(top, q, parent, call, t, chain, steps);
        } else {
          advance(parent.name.text, parent.name, optional, parent);
        }
      } else if (ts.isElementAccessExpression(parent) && parent.expression === top) {
        const segment = this.keySegment(parent, q, t);
        if (segment === undefined) return;
        advance(segment, parent.argumentExpression, parent.questionDotToken !== undefined, parent);
      } else if (ts.isCallExpression(parent) && parent.expression === top) {
        const relation = relatePaths(q, t.origin);
        const bare = parent.arguments.length === 0;
        if (q.length === 0 && bare) {
          top = parent;
        } else if (relation === "beyond" && bare) {
          steps.push(callStep(parent));
          top = parent;
        } else if (relation === "beyond" || relation === "exact") {
          if (parent.questionDotToken !== undefined) chain.push(this.tested("optional-chain", q, PRESENT, true, parent));
          return this.dereference(parent, t, q, chain, { steps: [...steps, callStep(parent)], end: { kind: "none" } });
        } else {
          if (relation === "contains") this.frontier(parent, "unmodelled-flow", "call", t);
          return;
        }
      } else {
        break;
      }
    }
    const relation = relatePaths(q, t.origin);
    if (relation === "disjoint") return;
    if (relation === "beyond") {
      const site = beyondAt ?? top;
      this.dereference(site, t, q, chain, { steps, end: this.operatorEnd(top) ?? { kind: "none" } });
      return;
    }
    if (discardsValue(top) && !(relation === "exact" && isNumericUnary(top.parent))) return;
    const attached = this.atTop(t, top, q, chain);
    if (attached !== undefined) this.sink(top, attached);
  }

  private dereference(node: ts.Node, t: Trail, q: AccessPath, chain: readonly Guard[], operation: UseOperation): void {
    const held = this.dominating(node, t);
    if (held !== undefined) this.use(node, t, q, operation, [...t.guards, ...chain, ...held]);
  }

  /** `value()` of a resource or `json()` of a fetch response: the change sits under the accessor the carrier was wrapped in. */
  private readsAccessor(access: ts.PropertyAccessExpression, call: ts.CallExpression, q: AccessPath, t: Trail): boolean {
    return call.arguments.length === 0 && q.length === 0 && ACCESSORS.has(access.name.text) && t.origin[0] === access.name.text;
  }

  /** A call of a method of the value at `q`, as opposed to a call of a property on the way to the changed value. */
  private isMethod(access: ts.PropertyAccessExpression, call: ts.CallExpression, q: AccessPath, t: Trail): boolean {
    if (relatePaths(q, t.origin) !== "contains") return call.arguments.length > 0;
    return relatePaths([...q, access.name.text], t.origin) === "disjoint";
  }

  private atTop(t: Trail, top: ts.Node, q: AccessPath, chain: readonly Guard[]): Trail | undefined {
    const held = this.dominating(top, t);
    if (held === undefined) return undefined;
    const guards = translate([...t.guards, ...chain, ...held], [{ from: q, to: [] }]);
    return { origin: t.origin.slice(q.length), hops: t.hops, guards, projected: q };
  }

  private keySegment(access: ts.ElementAccessExpression, q: AccessPath, t: Trail): string | undefined {
    const key = access.argumentExpression;
    if (ts.isStringLiteralLike(key)) return key.text;
    if (ts.isNumericLiteral(key)) return ELEMENT;
    const expected = t.origin[q.length];
    if (expected !== undefined && expected !== ELEMENT && relatePaths(q, t.origin) === "contains") {
      this.frontier(access, "dynamic-access", undefined, t);
      return undefined;
    }
    return ELEMENT;
  }

  /** A method called with arguments on a value that holds, or is, the changed value. */
  private methodCall(receiver: ts.Expression, q: AccessPath, access: ts.PropertyAccessExpression, call: ts.CallExpression, t: Trail, chain: readonly Guard[], steps: readonly AccessStep[]): void {
    const relation = relatePaths(q, t.origin);
    if (relation === "disjoint") return;
    const called: UseOperation = { steps: [...steps, accessStep(access), callStep(call)], end: { kind: "none" } };
    if (relation === "beyond") return this.dereference(access.name, t, q, chain, called);
    const name = access.name.text;
    if (q.length === 0 && STREAM_WRITES.has(name)) return;
    const attached = this.atTop(t, receiver, q, chain);
    if (attached === undefined) return;
    if (attached.origin[0] === "value" && RESOURCE_STATE_MEMBERS.has(name)) return;
    if (name === "pipe") return this.applyPipe(call, 0, this.hopped(attached, "pipe", call));
    if (name === "subscribe") return this.subscribeTo(call, attached);
    if (name === "then") {
      const [callback] = call.arguments;
      if (callback !== undefined && isFunctionNode(callback)) this.bindLambda(callback, 0, this.hopped(attached, "await", call));
      else this.frontier(call, "unmodelled-flow", "then handler", attached);
      return;
    }
    if (relation === "exact") this.use(access.name, attached, [], called, attached.guards);
    if (attached.origin.length > 0) this.frontier(access.name, "unmodelled-flow", `method:${name}`, attached);
  }

  /** What the code does with the expression that evaluates to the value: `t.origin` is where the change sits in it. */
  private sink(top: ts.Expression, t: Trail): void {
    const parent = top.parent;
    const exact = t.origin.length === 0;
    if (ts.isVariableDeclaration(parent) && parent.initializer === top) return this.bind(parent.name, declaredScope(parent), ts.isIdentifier(parent.name) ? this.hopped(t, "assign", parent) : t, parent);
    if (ts.isBinaryExpression(parent)) return this.sinkBinary(top, parent, t);
    if (ts.isConditionalExpression(parent)) return this.read(parent, t);
    if (ts.isAwaitExpression(parent)) return this.read(parent, this.hopped(t, "await", parent));
    if (ts.isReturnStatement(parent)) return this.returned(parent, enclosingFunction(parent), t);
    if (ts.isArrowFunction(parent) && parent.body === top) return this.returned(top, parent, t);
    if (ts.isCallExpression(parent)) return this.argument(top, parent, t);
    if (ts.isPropertyAssignment(parent) && parent.initializer === top) return this.property(parent, parent.name, t);
    if (ts.isShorthandPropertyAssignment(parent)) return this.property(parent, parent.name, t);
    if (ts.isArrayLiteralExpression(parent)) return this.read(parent, this.rewrapped(t, [ELEMENT]));
    if (ts.isSpreadElement(parent)) return this.spread(parent, t);
    if (ts.isSpreadAssignment(parent)) return this.frontier(parent, "unmodelled-flow", "object spread", t);
    if (ts.isForOfStatement(parent) && parent.expression === top) return this.iterate(parent, t);
    if (ts.isPropertyDeclaration(parent) && parent.initializer === top && ts.isIdentifier(parent.name)) return this.assignedToMember(parent.name.text, enclosingClass(parent), parent, this.hopped(t, "assign", parent));
    const end = exact ? this.operatorEnd(top) : undefined;
    if (end !== undefined) return this.use(parent, t, [], { steps: [], end }, t.guards);
    if (ts.isTemplateSpan(parent)) return;
    if (exact) return this.use(parent, t, [], { steps: [], end: { kind: "unmodelled", detail: ts.SyntaxKind[parent.kind] } }, t.guards);
    this.frontier(parent, "unmodelled-flow", ts.SyntaxKind[parent.kind], t);
  }

  private sinkBinary(top: ts.Expression, parent: ts.BinaryExpression, t: Trail): void {
    const operator = parent.operatorToken.kind;
    const exact = t.origin.length === 0;
    if (operator === ts.SyntaxKind.EqualsToken) return this.assignTo(parent, t);
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
      if (parent.right === top) return this.read(parent, t);
      const guards = exact ? [...t.guards, this.fallback(operator === ts.SyntaxKind.BarBarToken ? TRUTHY : PRESENT, parent.right, parent)] : t.guards;
      return this.read(parent, this.hopped({ ...t, guards }, "fallback", parent));
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return this.read(parent, t);
    const end = exact ? this.operatorEnd(top) : undefined;
    if (end !== undefined) this.use(parent, t, [], { steps: [], end }, t.guards);
  }

  /**
   * What an operator does with the value `top` evaluates to, whether that value is the changed one or one read from it;
   * `undefined` where the value flows on, is only tested, or is compared with an absence.
   */
  private operatorEnd(top: ts.Expression): UseEnd | undefined {
    const parent = top.parent;
    if (isNumericUnary(parent)) return { kind: "coerce", operator: ts.tokenToString(parent.operator)! };
    if (discardsValue(top)) return undefined;
    if (ts.isTemplateSpan(parent)) return { kind: "coerce", operator: "${}" };
    if (ts.isSwitchStatement(parent)) return { kind: "compare", operator: "===" };
    if ((ts.isForOfStatement(parent) && parent.expression === top) || ts.isSpreadElement(parent)) return ITERATE;
    if (!ts.isBinaryExpression(parent)) return undefined;
    const operator = parent.operatorToken.kind;
    if (FLOWING_OPERATORS.has(operator)) return undefined;
    const equality = [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator);
    const other = parent.left === top ? parent.right : parent.left;
    if (equality && isNullishLiteral(other)) return undefined;
    const text = parent.operatorToken.getText(this.unit.tree);
    if (parent.right === top && MEMBERSHIP_OPERATORS.has(operator)) return { kind: "unmodelled", detail: text };
    if (!COMPARISONS.has(operator)) return { kind: "coerce", operator: text };
    const literal = literalOf(other);
    return { kind: "compare", operator: text, ...(literal === undefined ? {} : { literal }) };
  }

  private assignTo(assignment: ts.BinaryExpression, t: Trail): void {
    const left = unwrap(assignment.left);
    const held = this.hopped(t, "assign", assignment);
    if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword) return this.assignedToMember(left.name.text, enclosingClass(assignment), assignment, held);
    const binding = ts.isIdentifier(left) ? assignedBinding(left) : undefined;
    if (binding !== undefined) return this.track(binding, held, assignment);
    this.frontier(assignment, "unmodelled-flow", "assignment target", t);
  }

  private assignedToMember(member: string, cls: ts.ClassLikeDeclaration | undefined, at: ts.Node, t: Trail): void {
    const owner = cls?.name?.text;
    if (cls === undefined || owner === undefined) return this.frontier(at, "unmodelled-flow", "member of an anonymous class", t);
    this.leave(at, memberSite(this.repo, this.unit, cls, owner, member), t);
  }

  private leave(at: ts.Node, site: CarrierSite, t: Trail): void {
    if (t.guards.some((guard) => protects(guard, t.origin))) return this.frontier(at, "unmodelled-flow", "guard does not cross a boundary", t);
    this.next.push({ file: this.unit.file, pos: at.getStart(this.unit.tree), value: { carrier: { site, path: t.origin }, hops: t.hops } });
  }

  private property(assignment: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, name: ts.PropertyName, t: Trail): void {
    if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return this.frontier(assignment, "dynamic-access", undefined, t);
    const object = assignment.parent;
    if (ts.isObjectLiteralExpression(object)) this.read(object, this.rewrapped(t, [name.text]));
  }

  private spread(spread: ts.SpreadElement, t: Trail): void {
    const holder = spread.parent;
    if (t.origin.length === 0) return this.use(spread, t, [], { steps: [], end: ITERATE }, t.guards);
    if (ts.isArrayLiteralExpression(holder) && t.origin[0] === ELEMENT) return this.read(holder, t);
    this.frontier(spread, "unmodelled-flow", "spread", t);
  }

  private iterate(loop: ts.ForOfStatement, t: Trail): void {
    if (t.origin.length === 0) return this.use(loop.expression, t, [], { steps: [], end: ITERATE }, t.guards);
    const initializer = loop.initializer;
    if (t.origin[0] !== ELEMENT || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return this.frontier(loop, "unmodelled-flow", "iteration", t);
    const element: Trail = { origin: t.origin.slice(1), hops: t.hops, guards: translate(t.guards, [{ from: [ELEMENT], to: [] }]) };
    this.bind(initializer.declarations[0]!.name, loop, this.hopped(element, "iterate", loop, [{ from: [ELEMENT], to: [] }]));
  }

  private returned(at: ts.Node, fn: FunctionNode | undefined, t: Trail): void {
    if (fn === undefined) return this.frontier(at, "unmodelled-flow", "return outside a function", t);
    if (this.lambdaResult(fn, at, t)) return;
    const named = namedFunction(fn);
    if (named === undefined) return this.frontier(at, "unmodelled-flow", "anonymous function result", t);
    this.leave(at, { kind: "return", repo: this.repo, file: this.unit.file, symbol: named.name, line: lineOf(this.unit.tree, named.declaration) }, this.hopped(t, "return", at));
  }

  /** Whether `fn` is a callback whose result the flow follows or knowingly drops. */
  private lambdaResult(fn: FunctionNode, at: ts.Node, t: Trail): boolean {
    const holder = fn.parent;
    if (ts.isCallExpression(holder) && holder.arguments.some((argument) => argument === fn)) {
      const callee = holder.expression;
      if (ts.isIdentifier(callee)) {
        const imported = this.unit.imports.get(callee.text);
        if (imported === undefined) return false;
        if (isRxjs(imported.module) && imported.imported === "map") {
          const kind = isAsyncOrGenerator(fn);
          if (kind !== undefined) {
            this.frontier(fn, "unmodelled-flow", `${kind} projection`, t);
            return true;
          }
          const pipe = holder.parent;
          if (!ts.isCallExpression(pipe) || !isPipe(pipe) || !pipe.arguments.some((argument) => argument === holder)) return false;
          this.applyPipe(pipe, pipe.arguments.indexOf(holder) + 1, t);
          return true;
        }
        if (isCore(imported.module) && imported.imported === "computed") {
          this.read(holder, t);
          return true;
        }
        return (isRxjs(imported.module) && KEEPING_OPERATORS.has(imported.imported)) || (isCore(imported.module) && imported.imported === "effect");
      }
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "then") {
          this.read(holder, this.hopped(t, "await", holder));
          return true;
        }
        return callee.name.text === "subscribe" || callee.name.text === "forEach";
      }
      return false;
    }
    const member = ts.isPropertyAssignment(holder) ? holder : ts.isMethodDeclaration(fn) ? fn : undefined;
    const object = member?.parent;
    if (member === undefined || object === undefined || !ts.isObjectLiteralExpression(object) || !ts.isCallExpression(object.parent) || !ts.isIdentifier(member.name)) return false;
    const call = object.parent;
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "subscribe") return member.name.text === "next";
    if (!ts.isIdentifier(call.expression)) return false;
    const imported = this.unit.imports.get(call.expression.text);
    if (!isCore(imported?.module) || (imported?.imported !== "resource" && imported?.imported !== "rxResource") || (member.name.text !== "loader" && member.name.text !== "stream")) return false;
    this.read(call, this.hopped(this.rewrapped(t, ["value"]), "resource", at, [{ from: [], to: ["value"] }]));
    return true;
  }

  private applyPipe(pipe: ts.CallExpression, from: number, t: Trail): void {
    for (const operator of pipe.arguments.slice(from)) {
      const name = this.operatorName(operator);
      if (name === undefined) return this.frontier(operator, "unmodelled-flow", "pipe operator", t);
      if (name === "map" && ts.isCallExpression(operator)) {
        const [callback] = operator.arguments;
        if (callback !== undefined && isFunctionNode(callback)) this.bindLambda(callback, 0, this.hopped(t, "map", operator));
        else this.frontier(operator, "unmodelled-flow", "map projection", t);
        return;
      }
      if (!KEEPING_OPERATORS.has(name)) return this.frontier(operator, "unmodelled-flow", `operator ${name}`, t);
      if (CALLBACK_OPERATORS.has(name) && ts.isCallExpression(operator)) {
        const [callback] = operator.arguments;
        if (callback !== undefined && isFunctionNode(callback)) this.bindLambda(callback, 0, t);
      }
    }
    this.read(pipe, t);
  }

  private operatorName(operator: ts.Expression): string | undefined {
    if (!ts.isCallExpression(operator) || !ts.isIdentifier(operator.expression)) return undefined;
    const imported = this.unit.imports.get(operator.expression.text);
    return imported !== undefined && isRxjs(imported.module) ? imported.imported : undefined;
  }

  private subscribeTo(call: ts.CallExpression, t: Trail): void {
    const [observer] = call.arguments;
    const held = this.hopped(t, "subscribe", call);
    if (observer === undefined) return;
    const handler = ts.isObjectLiteralExpression(observer) ? nextHandler(observer) : observer;
    if (handler === undefined) return;
    if (isFunctionNode(handler)) return this.bindLambda(handler, 0, held);
    if (ts.isObjectLiteralExpression(observer)) return this.frontier(observer, "unmodelled-flow", "observer", t);
    this.passTo(handler, 0, call, held);
  }

  private bindLambda(fn: FunctionNode, index: number, t: Trail): void {
    const parameter = fn.parameters[index];
    if (parameter !== undefined) this.bind(parameter.name, fn, t);
  }

  /** The value is an argument of `call` at the top of the chain. */
  private argument(top: ts.Expression, call: ts.CallExpression, t: Trail): void {
    const index = call.arguments.findIndex((argument) => argument === top);
    if (index < 0) return;
    const callee = unwrap(call.expression);
    if (index === 0 && ts.isIdentifier(callee)) {
      const imported = this.unit.imports.get(callee.text);
      if (isRxjs(imported?.module) && (imported?.imported === "firstValueFrom" || imported?.imported === "lastValueFrom" || imported?.imported === "of")) return this.read(call, t);
      if (isCore(imported?.module) && imported?.imported === "toSignal") return this.read(call, this.hopped(t, "to-signal", call));
    }
    if (ts.isPropertyAccessExpression(callee) && STREAM_WRITES.has(callee.name.text)) {
      const receiver = unwrap(callee.expression);
      if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) return this.assignedToMember(receiver.name.text, enclosingClass(call), call, this.hopped(t, "assign", call));
    }
    this.passTo(callee, index, call, this.hopped(t, "argument", call));
  }

  /** The value reaches the parameter at `index` of the function `callee` names, or is lost where that cannot be told. */
  private passTo(callee: ts.Expression, index: number, call: ts.Node, t: Trail): void {
    const target = this.resolveFunction(callee);
    if (target?.kind === "function") {
      const parameter = target.named.node.parameters[index];
      if (parameter === undefined || parameter.dotDotDotToken !== undefined) return this.frontier(call, "unmodelled-flow", "parameter position", t);
      const owner = this.program.index.units.get(target.file);
      if (owner === undefined) return this.frontier(call, "unmodelled-flow", "callee source", t);
      return this.leave(call, { kind: "parameter", repo: this.repo, file: target.file, symbol: target.named.name, line: lineOf(owner.tree, target.named.declaration), index }, t);
    }
    const detail = callee.getText(this.unit.tree).slice(0, 80);
    if (t.origin.length === 0) return this.use(call, t, [], { steps: [], end: { kind: "consume", as: "handed-on", detail } }, t.guards);
    this.frontier(call, "unmodelled-sink", detail, t);
  }

  private bind(name: ts.BindingName, scope: ts.Node, t: Trail, from?: ts.Node): void {
    if (ts.isIdentifier(name)) return this.track(declaredBinding(name, scope), t, from);
    this.destructure(name, scope, t, []);
  }

  /** Follows the reads of `binding`; with `from`, only those the declaration or assignment at `from` can reach. */
  private track(binding: Binding, t: Trail, from?: ts.Node): void {
    const trail: Trail = { origin: t.origin, hops: t.hops, guards: t.guards, binding };
    const { reads, dynamic } = referencesOf(binding);
    for (const reference of from === undefined ? reads : this.reachedFrom(binding, from, reads, t)) this.read(reference, trail);
    for (const reference of dynamic) if (from === undefined || reference.pos >= from.end) this.once(reference, "dynamic scope", trail);
  }

  private reachedFrom(binding: Binding, assignment: ts.Node, references: readonly ts.Expression[], t: Trail): ts.Expression[] {
    const loop = enclosingLoop(assignment, binding.scope);
    if (loop !== undefined && references.some((reference) => reference.pos < assignment.pos && reference.pos >= loop.pos)) this.once(assignment, "assignment in a loop", t);
    const reachable = references.filter((reference) => reference.pos >= assignment.end);
    const rewrites = writesWithin(searchRoot(binding), binding, assignment.end, Infinity).filter((write) => write.path.length === 0);
    const definite = rewrites.findIndex((write) => write.dynamic === undefined);
    for (const write of definite === -1 ? rewrites : rewrites.slice(0, definite)) this.once(write.node, "dynamic scope", t);
    const rewrite = rewrites[definite];
    if (rewrite === undefined) return reachable;
    if (mayNotFollow(assignment, rewrite.node)) {
      this.once(rewrite.node, "conditional reassignment", t);
      return reachable;
    }
    return reachable.filter((reference) => reference.pos < rewrite.node.end);
  }

  private once(node: ts.Node, detail: string, t: Trail): void {
    const key = `${node.pos}\0${detail}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.frontier(node, "unmodelled-flow", detail, t);
  }

  private destructure(pattern: ts.BindingPattern, scope: ts.Node, t: Trail, prefix: AccessPath, inherited = patternShape(pattern)): void {
    const shape = relatePaths(prefix, t.origin) === "exact" ? patternShape(pattern) : inherited;
    if (pattern.elements.length === 0 && ["exact", "beyond"].includes(relatePaths(prefix, t.origin))) this.use(pattern, t, prefix, { steps: [], end: { kind: "destructure", shape } }, t.guards);
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const key = ts.isObjectBindingPattern(pattern) ? (element.propertyName ?? element.name) : undefined;
      const segment = key === undefined ? ELEMENT : ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (element.dotDotDotToken !== undefined) {
        if (relatePaths(prefix, t.origin) !== "beyond") this.frontier(element, "unmodelled-flow", "rest element", t);
        continue;
      }
      if (segment === undefined) {
        this.frontier(element, "dynamic-access", undefined, t);
        continue;
      }
      const path = [...prefix, segment];
      const relation = relatePaths(path, t.origin);
      if (relation === "disjoint") continue;
      if (relation === "beyond") {
        this.use(element, t, path, { steps: [], end: { kind: "destructure", shape } }, t.guards);
        if (!ts.isIdentifier(element.name)) this.destructure(element.name, scope, t, path, shape);
        continue;
      }
      const guards = translate(t.guards, [{ from: path, to: [] }]);
      if (element.initializer !== undefined) guards.push(this.fallback({ kind: "absence", operator: "!==", absence: "undefined" }, element.initializer, element));
      const child: Trail = { origin: t.origin.slice(path.length), hops: t.hops, guards, projected: path };
      this.bind(element.name, scope, this.hopped(child, "assign", element));
    }
  }

  /**
   * The guards that hold on the binding where `node` runs: those of the function around it. Undefined, and reported,
   * when the read is not the followed value's to decide: a write replaced the guarded value before it, or only a guard
   * outside a closure would protect it, which holds where the closure is written, not where it runs.
   */
  private dominating(node: ts.Node, t: Trail): Guard[] | undefined {
    const binding = t.binding;
    if (binding === undefined) return [];
    const found: { guard: Guard; from: number; captured: boolean }[] = [];
    let closure: ts.Node | undefined;
    const add = (guards: Guard[], from: number): void => void guards.forEach((guard) => found.push({ guard, from, captured: closure !== undefined }));
    for (let child: ts.Node = node, parent = node.parent; parent !== undefined && child !== binding.scope; child = parent, parent = parent.parent) {
      if (isFunctionNode(parent)) {
        closure ??= parent;
        continue;
      }
      if (ts.isIfStatement(parent)) {
        if (child === parent.thenStatement) add(this.conditionGuards(parent.expression, true, binding), parent.expression.end);
        else if (child === parent.elseStatement) add(this.conditionGuards(parent.expression, false, binding), parent.expression.end);
      } else if (ts.isConditionalExpression(parent)) {
        if (child === parent.whenTrue) add(this.conditionGuards(parent.condition, true, binding), parent.condition.end);
        else if (child === parent.whenFalse) add(this.conditionGuards(parent.condition, false, binding), parent.condition.end);
      } else if (ts.isBinaryExpression(parent) && parent.right === child) {
        if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) add(this.conditionGuards(parent.left, true, binding), parent.left.end);
        else if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) add(this.conditionGuards(parent.left, false, binding), parent.left.end);
      } else if (ts.isCaseBlock(parent)) {
        add(this.clauseGuards(parent, child as ts.CaseOrDefaultClause, binding), parent.parent.expression.end);
      } else if (ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
        const before = parent.statements.indexOf(child as ts.Statement);
        for (const statement of parent.statements.slice(0, Math.max(before, 0))) add(this.earlyExit(statement, binding), statement.end);
      }
    }
    const own = found.filter(({ captured }) => !captured);
    const kept = own.filter(({ guard, from }) => !this.overwritten(guard, closure ?? binding.scope, binding, from, node, t));
    if (own.some(({ guard }) => protects(guard, t.origin) && !kept.some((held) => held.guard === guard))) return undefined;
    if (!kept.some(({ guard }) => protects(guard, t.origin)) && found.some(({ guard, captured }) => captured && protects(guard, t.origin))) {
      this.once(node, "guard across closure", t);
      return undefined;
    }
    return kept.map(({ guard }) => guard);
  }

  private overwritten(guard: Guard, limit: ts.Node, binding: Binding, from: number, read: ts.Node, t: Trail): boolean {
    const write = writesWithin(limit, binding, from, read.getStart(this.unit.tree)).find((candidate) => startsWith(guard.covers, candidate.path));
    if (write === undefined) return false;
    this.once(write.node, "write after guard", t);
    return true;
  }

  /** What reaching `clause` says about the switched value. */
  private clauseGuards(block: ts.CaseBlock, clause: ts.CaseOrDefaultClause, binding: Binding): Guard[] {
    const covers = chainPath(block.parent.expression, binding);
    if (covers === undefined) return [];
    const reached = this.clauseTest(block, clause);
    if (reached === "none") return [];
    return reached === "opaque" ? [this.untested("case", covers, clause)] : [this.tested("condition", covers, reached.test, reached.holds, clause)];
  }

  /** What reaching each clause of the switch says about the value, computed for all of its clauses on the first ask. */
  private clauseTest({ clauses }: ts.CaseBlock, clause: ts.CaseOrDefaultClause): ClauseTest {
    if (!this.clauseTests.has(clause)) {
      let start = 0;
      clauses.forEach((candidate, at) => {
        this.clauseTests.set(candidate, reachedBy(clauses, clauses.slice(start, at + 1)));
        if (candidate.statements.length > 0 && exits(candidate.statements.at(-1)!)) start = at + 1;
      });
    }
    return this.clauseTests.get(clause)!;
  }

  private earlyExit(statement: ts.Statement, binding: Binding): Guard[] {
    if (ts.isIfStatement(statement) && statement.elseStatement === undefined && exits(statement.thenStatement)) {
      return this.conditionGuards(statement.expression, false, binding).map((guard) => (guard.kind === "condition" ? { ...guard, kind: "early-exit" as const } : guard));
    }
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const target = this.resolveFunction(statement.expression.expression);
    const type = target?.kind === "function" ? target.named.node.type : undefined;
    if (type === undefined || !ts.isTypePredicateNode(type) || type.assertsModifier === undefined) return [];
    return this.predicateGuards(statement.expression, "assertion", binding);
  }

  private predicateGuards(call: ts.CallExpression, kind: "type-guard" | "assertion", binding: Binding): Guard[] {
    return call.arguments.flatMap((argument) => {
      const covers = chainPath(argument, binding);
      return covers === undefined ? [] : [this.untested(kind, covers, call)];
    });
  }

  /** The guards that hold on `binding` where `expression` evaluates to `holds`. */
  private conditionGuards(expression: ts.Expression, holds: boolean, binding: Binding): Guard[] {
    const bare = unwrap(expression);
    if (ts.isPrefixUnaryExpression(bare) && bare.operator === ts.SyntaxKind.ExclamationToken) return this.conditionGuards(bare.operand, !holds, binding);
    if (ts.isBinaryExpression(bare)) {
      const operator = bare.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return holds ? [...this.conditionGuards(bare.left, true, binding), ...this.conditionGuards(bare.right, true, binding)] : [];
      if (operator === ts.SyntaxKind.BarBarToken) return holds ? [] : [...this.conditionGuards(bare.left, false, binding), ...this.conditionGuards(bare.right, false, binding)];
      if (operator === ts.SyntaxKind.InstanceOfKeyword) {
        const covers = chainPath(bare.left, binding);
        return holds && covers !== undefined ? [this.untested("instanceof", covers, bare)] : [];
      }
      return this.equalityGuards(bare, holds, binding);
    }
    if (ts.isCallExpression(bare) && bare.arguments.length > 0) {
      const covers = this.isArrayCheck(bare) ? chainPath(bare.arguments[0]!, binding) : undefined;
      if (covers !== undefined) return [this.tested("condition", covers, { kind: "array" }, holds, bare)];
      const target = holds ? this.resolveFunction(bare.expression) : undefined;
      const type = target?.kind === "function" ? target.named.node.type : undefined;
      return type !== undefined && ts.isTypePredicateNode(type) && type.assertsModifier === undefined ? this.predicateGuards(bare, "type-guard", binding) : [];
    }
    const covers = chainPath(bare, binding);
    return covers === undefined ? [] : [this.tested("condition", covers, TRUTHY, holds, bare)];
  }

  /** An equality of a covered path with `null`, `undefined`, a literal the code writes, or a `typeof` name, whichever side it sits on. */
  private equalityGuards(comparison: ts.BinaryExpression, holds: boolean, binding: Binding): Guard[] {
    const operator = EQUALITY.get(comparison.operatorToken.kind);
    if (operator === undefined) return [];
    for (const [tested, other] of [[comparison.left, comparison.right], [comparison.right, comparison.left]] as const) {
      const operand = unwrap(tested);
      const value = unwrap(other);
      if (ts.isTypeOfExpression(operand)) {
        const covers = chainPath(operand.expression, binding);
        const type = literalOf(value);
        if (covers !== undefined && typeof type === "string") return [this.tested("condition", covers, { kind: "typeof", operator, type }, holds, comparison)];
        continue;
      }
      const covers = chainPath(operand, binding);
      if (covers === undefined) continue;
      if (isNullishLiteral(value)) return [this.tested("condition", covers, { kind: "absence", operator, absence: value.kind === ts.SyntaxKind.NullKeyword ? "null" : "undefined" }, holds, comparison)];
      const literal = literalOf(value);
      if (literal !== undefined) return [this.tested("condition", covers, { kind: "literal", operator, literal }, holds, comparison)];
    }
    return [];
  }

  /** `Array.isArray(...)` where `Array` is the global, not a name the code declares or imports. */
  private isArrayCheck(call: ts.CallExpression): boolean {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "isArray" || call.arguments.length !== 1) return false;
    const receiver = unwrap(callee.expression);
    return ts.isIdentifier(receiver) && receiver.text === "Array" && isUndeclaredName(receiver) && !this.unit.imports.has("Array");
  }

  private resolveFunction(callee: ts.Expression): Resolved | undefined {
    const expression = unwrap(callee);
    if (ts.isIdentifier(expression)) return this.functionNamed(expression);
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const cls = enclosingClass(expression);
    const receiver = unwrap(expression.expression);
    if (cls === undefined) return undefined;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return this.methodOf(this.unit.file, cls, expression.name.text);
    const className = this.receiverClass(receiver, cls);
    if (className === undefined) return undefined;
    const owner = this.unit.classes.get(className);
    if (owner !== undefined) return this.methodOf(this.unit.file, owner, expression.name.text);
    const origin = this.unit.imports.has(className) ? this.program.index.origin(this.unit.file, className) : undefined;
    return this.methodFromOrigin(origin, expression.name.text);
  }

  private methodFromOrigin(origin: Origin, method: string): Resolved | undefined {
    if (origin === "external") return { kind: "external" };
    const unit = origin === undefined ? undefined : this.program.index.units.get(origin.file);
    const cls = origin === undefined ? undefined : unit?.classes.get(origin.name);
    return unit === undefined || cls === undefined ? undefined : this.methodOf(unit.file, cls, method);
  }

  private functionNamed(identifier: ts.Identifier): Resolved | undefined {
    if (isDynamicName(identifier)) return undefined;
    const name = identifier.text;
    const scope = declaringScope(identifier);
    if (scope !== this.unit.tree) return this.localFunction(scope, name);
    const local = this.unit.functions.get(name);
    if (local !== undefined) return { kind: "function", file: this.unit.file, named: local };
    if (!this.unit.imports.has(name)) return undefined;
    const origin = this.program.index.origin(this.unit.file, name);
    if (origin === "external") return { kind: "external" };
    const named = origin === undefined ? undefined : this.program.index.units.get(origin.file)?.functions.get(origin.name);
    return origin === undefined || named === undefined ? undefined : { kind: "function", file: origin.file, named };
  }

  /** The function a name declares in a block, or undefined when it is a parameter or a variable holding something else. */
  private localFunction(scope: ts.Node, name: string): Resolved | undefined {
    const statements = ts.isCaseBlock(scope) ? scope.clauses.flatMap((clause) => clause.statements) : ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined;
    for (const statement of statements ?? []) {
      const declared = ts.isFunctionDeclaration(statement) ? [statement] : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((declaration) => declaration.initializer) : [];
      for (const candidate of declared) {
        const named = candidate !== undefined && isFunctionNode(candidate) ? namedFunction(candidate) : undefined;
        if (named?.name === name) return { kind: "function", file: this.unit.file, named };
      }
    }
    return undefined;
  }

  private methodOf(file: string, cls: ts.ClassLikeDeclaration, name: string): Resolved | undefined {
    for (const member of cls.members) {
      if (member.name === undefined || !ts.isIdentifier(member.name) || member.name.text !== name) continue;
      const fn = ts.isMethodDeclaration(member) ? member : ts.isPropertyDeclaration(member) && member.initializer !== undefined && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)) ? member.initializer : undefined;
      const named = fn === undefined ? undefined : namedFunction(fn);
      if (named !== undefined) return { kind: "function", file, named };
    }
    return undefined;
  }

  /** The class a receiver is an instance of: a field or constructor parameter of the class that holds it by type or `inject(X)`. */
  private receiverClass(receiver: ts.Expression, cls: ts.ClassLikeDeclaration): string | undefined {
    const name = ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword ? receiver.name.text : ts.isIdentifier(receiver) ? receiver.text : undefined;
    if (name === undefined) return undefined;
    for (const member of cls.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name) {
        const injected = member.initializer === undefined ? undefined : injectedClass(member.initializer);
        return injected ?? (member.type === undefined ? undefined : typeName(member.type));
      }
    }
    if (!ts.isClassDeclaration(cls)) return undefined;
    const parameter = constructorParameters(cls).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
    return parameter?.type === undefined ? undefined : typeName(parameter.type);
  }

  private routeHolders(cls: ts.ClassLikeDeclaration): ReadonlySet<string> {
    const names = new Set<string>();
    const holdsRoute = (type: ts.TypeNode | undefined, initializer: ts.Expression | undefined): boolean =>
      (type !== undefined && typeName(type) === ROUTE_HOLDER) || (initializer !== undefined && injectedClass(initializer) === ROUTE_HOLDER);
    for (const member of cls.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && holdsRoute(member.type, member.initializer)) names.add(member.name.text);
      if (ts.isConstructorDeclaration(member)) for (const parameter of member.parameters) if (ts.isIdentifier(parameter.name) && holdsRoute(parameter.type, undefined)) names.add(parameter.name.text);
    }
    return names;
  }

  /** `this.route.data` or `this.route.snapshot.data`, for a field that holds the `ActivatedRoute`. */
  private isRouteData(node: ts.PropertyAccessExpression, holders: ReadonlySet<string>): boolean {
    const owner = unwrap(node.expression);
    const route = ts.isPropertyAccessExpression(owner) && owner.name.text === "snapshot" ? unwrap(owner.expression) : owner;
    return ts.isPropertyAccessExpression(route) && route.expression.kind === ts.SyntaxKind.ThisKeyword && holders.has(route.name.text);
  }

  private classNamed(name: string): ts.ClassLikeDeclaration | undefined {
    let found: ts.ClassLikeDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (found === undefined && ts.isClassLike(node) && node.name?.text === name) found = node;
      if (found === undefined) node.forEachChild(visit);
    };
    visit(this.unit.tree);
    return found;
  }

  private functionAt(symbol: string, line: number): NamedFunction | undefined {
    let found: NamedFunction | undefined;
    const visit = (node: ts.Node): void => {
      if (found !== undefined) return;
      if (isFunctionNode(node)) {
        const named = namedFunction(node);
        if (named !== undefined && named.name === symbol && lineOf(this.unit.tree, named.declaration) === line) found = named;
      }
      node.forEachChild(visit);
    };
    visit(this.unit.tree);
    return found;
  }

  private calls(): ts.CallExpression[] {
    const found: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) found.push(node);
      node.forEachChild(visit);
    };
    visit(this.unit.tree);
    return found;
  }

  private requestKind(call: ts.CallExpression): "verb" | "resource" | "fetch" | undefined {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text === "fetch" ? "fetch" : callee.text === "httpResource" ? "resource" : undefined;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "httpResource") return "resource";
    return VERBS.has(callee.name.text) || callee.name.text === "fetch" ? "verb" : undefined;
  }

  private observed(call: ts.CallExpression): "response" | "events" | undefined {
    for (const argument of call.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      const observe = propertyOf(argument, "observe");
      if (observe !== undefined && ts.isStringLiteralLike(observe)) return observe.text === "response" ? "response" : observe.text === "events" ? "events" : undefined;
    }
    return undefined;
  }

  private startLine(node: ts.Node): number {
    return lineOf(this.unit.tree, node);
  }

  private endLine(node: ts.Node): number {
    return this.unit.tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  }

  private columns(call: ts.CallExpression): number[] {
    const start = this.unit.tree.getLineAndCharacterOfPosition(call.getStart(this.unit.tree)).character;
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    const name = this.unit.tree.getLineAndCharacterOfPosition(callee.getStart(this.unit.tree)).character;
    return [start, start + 1, name, name + 1];
  }
}

const COMPARISONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** What reaching a switch clause says about the switched value: a test that must hold, nothing, or labels that are not literals. */
type ClauseTest = { test: Predicate; holds: boolean } | "none" | "opaque";

/**
 * The clauses that fall through into the last of `group` are those after the last one that exits: without `default` among
 * them the value equals one of their labels, with it the value equals none of the labels outside them. A label that is no
 * literal leaves the test opaque.
 */
function reachedBy(clauses: readonly ts.CaseOrDefaultClause[], group: readonly ts.CaseOrDefaultClause[]): ClauseTest {
  const withDefault = group.some(ts.isDefaultClause);
  const labelled = (withDefault ? clauses.filter((candidate) => !group.includes(candidate)) : group).filter(ts.isCaseClause).map((label) => unwrap(label.expression));
  const literals: Literal[] = [];
  const absences: Absence[] = [];
  for (const label of labelled) {
    const literal = literalOf(label);
    if (literal !== undefined) literals.push(literal);
    else if (isNullishLiteral(label)) absences.push(label.kind === ts.SyntaxKind.NullKeyword ? "null" : "undefined");
    else return "opaque";
  }
  return literals.length + absences.length === 0 ? "none" : { test: { kind: "one-of", literals, absences }, holds: !withDefault };
}

/** `in` and `instanceof` throw on a right operand that is no object or no function; what they do with the value there is not modelled. */
const ITERATE: UseEnd = { kind: "iterate", tolerates: [] };

const FLOWING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);

const MEMBERSHIP_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword]);

const reachesChange = (q: AccessPath, t: Trail): boolean => ["exact", "beyond"].includes(relatePaths(q, t.origin));

const patternShape = (pattern: ts.BindingPattern): "object" | "array" => (ts.isObjectBindingPattern(pattern) ? "object" : "array");

const callStep = (call: ts.CallExpression): AccessStep => ({ kind: "call", optional: call.questionDotToken !== undefined });

function accessStep(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): AccessStep {
  const optional = access.questionDotToken !== undefined;
  if (ts.isPropertyAccessExpression(access)) return { kind: "member", name: access.name.text, optional };
  const key = access.argumentExpression;
  if (ts.isStringLiteralLike(key)) return { kind: "keyed", key: key.text, optional };
  if (ts.isNumericLiteral(key)) return { kind: "keyed", key: Number(key.text), optional };
  return { kind: "keyed", optional };
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function isPipe(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "pipe";
}

function nextHandler(observer: ts.ObjectLiteralExpression): ts.Expression | undefined {
  for (const property of observer.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "next") return property.initializer;
    if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) && property.name.text === "next") return property as unknown as ts.Expression;
  }
  return undefined;
}

function injectedClass(expression: ts.Expression): string | undefined {
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "inject") return undefined;
  const [first] = expression.arguments;
  return first !== undefined && ts.isIdentifier(first) ? first.text : undefined;
}

/** The member that declares the component input whose public name is `publicName`. */
export function declaredInput(unit: Unit, cls: ts.ClassLikeDeclaration, publicName: string): ts.ClassElement | undefined {
  return cls.members.find((member) => inputName(unit, member) === publicName);
}

function inputName(unit: Unit, member: ts.ClassElement): string | undefined {
  if (member.name === undefined || !ts.isIdentifier(member.name)) return undefined;
  const own = member.name.text;
  for (const decorator of ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : []) {
    const call = decorator.expression;
    const callee = ts.isCallExpression(call) ? call.expression : call;
    if (ts.isIdentifier(callee) && unit.imports.get(callee.text)?.imported === "Input") return aliasIn(ts.isCallExpression(call) ? call.arguments : [], own, true);
  }
  const initializer = ts.isPropertyDeclaration(member) && member.initializer !== undefined ? unwrap(member.initializer) : undefined;
  if (initializer === undefined || !ts.isCallExpression(initializer)) return undefined;
  const callee = ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === "required" ? initializer.expression.expression : initializer.expression;
  const imported = ts.isIdentifier(callee) ? unit.imports.get(callee.text)?.imported : undefined;
  return imported === "input" || imported === "model" ? aliasIn(initializer.arguments, own, false) : undefined;
}

function aliasIn(args: readonly ts.Expression[], own: string, stringAlias: boolean): string {
  for (const argument of args) {
    if (stringAlias && ts.isStringLiteralLike(argument)) return argument.text;
    const alias = ts.isObjectLiteralExpression(argument) ? propertyOf(argument, "alias") : undefined;
    if (alias !== undefined && ts.isStringLiteralLike(alias)) return alias.text;
  }
  return own;
}

function memberDeclaration(cls: ts.ClassLikeDeclaration, name: string): ts.ClassElement | ts.ParameterDeclaration | undefined {
  return (
    cls.members.find((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name) ??
    (ts.isClassDeclaration(cls) ? constructorParameters(cls).find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name) : undefined)
  );
}

export function memberSite(repo: string, unit: Unit, cls: ts.ClassLikeDeclaration, owner: string, member: string): CarrierSite {
  const declaration = memberDeclaration(cls, member);
  return { kind: "member", repo, file: unit.file, owner, member, ...(declaration === undefined ? {} : { line: lineOf(unit.tree, declaration) }) };
}
