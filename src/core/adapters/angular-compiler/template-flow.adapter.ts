import {
  type AST,
  ASTWithSource,
  Binary,
  BindingPipe,
  BindingType,
  Call,
  Chain,
  CombinedRecursiveAstVisitor,
  Conditional,
  ImplicitReceiver,
  Interpolation,
  KeyedRead,
  LiteralArray,
  LiteralMap,
  LiteralPrimitive,
  NonNullAssert,
  ParenthesizedExpression,
  PrefixNot,
  PropertyRead,
  RecursiveAstVisitor,
  SafeCall,
  SafeKeyedRead,
  SafePropertyRead,
  ThisReceiver,
  TmplAstBoundAttribute,
  TmplAstBoundDeferredTrigger,
  type TmplAstBoundEvent,
  type TmplAstBoundText,
  type TmplAstDeferredTrigger,
  type TmplAstElement,
  type TmplAstForLoopBlock,
  type TmplAstIfBlock,
  type TmplAstLetDeclaration,
  type TmplAstSwitchBlock,
  type TmplAstSwitchBlockCase,
  type TmplAstTemplate,
  type TmplAstVariable,
  TypeofExpression,
  Unary,
  VoidExpression,
  type DirectiveMeta,
} from "@angular/compiler";
import { ELEMENT, relatePaths, startsWith, type AccessPath } from "../../domain/contracts/access-path.ts";
import { RESOURCE_STATE_MEMBERS, templateUnreadable, type FlowFrontier, type FlowNext, type FlowResult, type FlowStep, type FlowUse, type FrontierCause, type Hop } from "../../domain/contracts/consumer-flow.ts";
import type { AccessStep, EqualityOperator, JsonValue, Literal, Predicate, Replacement, UseEnd } from "../../domain/contracts/use-operation.ts";
import type { Absence, Guard } from "../../domain/contracts/verdict.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { SymbolRef } from "../../domain/relations/relation.ts";
import type { MemberCarrier } from "../../ports/consumer-template.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { TemplateUnit } from "../../ports/template-usage.port.ts";
import { bindTemplate, type BoundTemplate } from "./template-binding.ts";

/**
 * Follows one component member through the template of its owner: the reads of the member, the guards that cover them,
 * the aliases and loop items that carry it, and the child component inputs it is bound to. Positions are template
 * offsets until the result is sorted into source order.
 */
export function createTemplateFlowReader(): TemplateFlowReader {
  return { follow };
}

function follow(unit: TemplateUnit, carrier: MemberCarrier): FlowResult {
  const template = bindTemplate(unit);
  if ("errorLine" in template) return templateUnreadable({ path: unit.path, line: unit.firstLine + template.errorLine });
  return new TemplateFlow(unit, carrier, template).run();
}

const BOTH: readonly Absence[] = ["null", "undefined"];
const PRESENT: Predicate = { kind: "absence", operator: "!=", absence: "null" };
const TRUTHY: Predicate = { kind: "truthy" };
const OPAQUE: Replacement = { kind: "opaque" };
const COMPARISONS: ReadonlySet<string> = new Set(["==", "!=", "===", "!=="]);
const RELATIONS: ReadonlySet<string> = new Set([...COMPARISONS, "<", "<=", ">", ">="]);
/** `in` and `instanceof` throw on a right operand that is no object or no function; what they do with the value there is not modelled. */
const MEMBERSHIP_OPERATORS: ReadonlySet<string> = new Set(["in", "instanceof"]);

const NONE: UseEnd = { kind: "none" };
const SHOWN: UseEnd = { kind: "consume", as: "shown" };
const HANDED_ON: UseEnd = { kind: "consume", as: "handed-on" };

/** What the value that reaches the end of an expression flows into; a use states how it ends. */
type Sink =
  | { kind: "consume"; end: UseEnd }
  | { kind: "test" }
  | { kind: "opaque"; end: UseEnd | "frontier"; cause: FrontierCause; detail: string }
  | { kind: "bind"; name: string; ref: SymbolRef };

const ITERATE: UseEnd = { kind: "iterate", tolerates: BOTH };

/** What the operator at a sink does with a value read from the changed one: the ends of an operator, else the accesses alone decide. */
function reachedBy(sink: Sink): UseEnd {
  const end = sink.kind === "consume" || sink.kind === "opaque" ? sink.end : NONE;
  if (end === "frontier") return NONE;
  return end.kind === "coerce" || end.kind === "compare" || end.kind === "iterate" || (end.kind === "unmodelled" && MEMBERSHIP_OPERATORS.has(end.detail)) ? end : NONE;
}

const consuming = (end: UseEnd): Sink => ({ kind: "consume", end });
const TEST: Sink = { kind: "test" };

function opaque(detail: string, end: UseEnd | "frontier" = { kind: "unmodelled", detail }, cause: FrontierCause = "unmodelled-flow"): Sink {
  return { kind: "opaque", end, cause, detail };
}

/** A value of the member read in the template: `offset` is where it sits in the member, `frame` where its alias starts. */
interface Tracked {
  frame: AccessPath;
  offset: AccessPath;
  /** Which element each `[]` of `offset` stands for: a literal index or a loop item. */
  slots: readonly string[];
  hops: readonly Hop[];
  guards: readonly Guard[];
  /** The accesses written on the value once the chain has reached the changed segment. */
  steps: readonly AccessStep[];
}

interface Alias {
  frame: AccessPath;
  slots: readonly string[];
  hops: readonly Hop[];
}

/** A guard without the position the adapter gives it. */
type Stated<G extends Guard = Guard> = G extends Guard ? Omit<G, "covers" | "evidence"> : never;

interface At<T> {
  offset: number;
  value: T;
}

function core(ast: AST): AST {
  if (ast instanceof ASTWithSource) return core(ast.ast);
  return ast instanceof ParenthesizedExpression ? core(ast.expression) : ast;
}

function absenceOf(ast: AST): Absence | undefined {
  const node = core(ast);
  if (!(node instanceof LiteralPrimitive)) return undefined;
  return node.value === null ? "null" : node.value === undefined ? "undefined" : undefined;
}

function literalOf(ast: AST): Literal | undefined {
  const node = core(ast);
  if (node instanceof Unary) {
    const operand = literalOf(node.expr);
    return node.operator === "-" && typeof operand === "number" ? -operand : undefined;
  }
  return node instanceof LiteralPrimitive && (typeof node.value === "string" || typeof node.value === "number" || typeof node.value === "boolean") ? node.value : undefined;
}

/** The JSON value an expression writes literally; undefined for anything else. */
function jsonOf(ast: AST): JsonValue | undefined {
  const node = core(ast);
  if (absenceOf(node) === "null") return null;
  const literal = literalOf(node);
  if (literal !== undefined) return literal;
  if (node instanceof LiteralArray) {
    const items = node.expressions.map(jsonOf);
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  if (node instanceof LiteralMap) {
    const entries: [string, JsonValue][] = [];
    for (const [index, key] of node.keys.entries()) {
      if (key.kind !== "property") return undefined;
      const value = jsonOf(node.values[index]!);
      if (value === undefined) return undefined;
      entries.push([key.key, value]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

class Children extends RecursiveAstVisitor {
  constructor(private readonly each: (ast: AST) => void) {
    super();
  }

  override visit(ast: AST): void {
    this.each(ast);
  }
}

class TemplateFlow extends CombinedRecursiveAstVisitor {
  private readonly uses: At<FlowUse>[] = [];
  private readonly next: At<FlowNext>[] = [];
  private readonly frontiers: At<FlowFrontier>[] = [];
  private readonly aliases = new Map<object, Alias>();
  private readonly guardSlots = new WeakMap<Guard, readonly string[]>();
  private readonly lineStarts: number[];
  private readonly changed: AccessPath;
  private guards: readonly Guard[] = [];
  private quiet = false;

  constructor(
    private readonly unit: TemplateUnit,
    private readonly carrier: MemberCarrier,
    private readonly template: BoundTemplate,
  ) {
    super();
    this.lineStarts = [0, ...[...unit.text.matchAll(/\n/g)].map((match) => match.index + 1)];
    this.changed = carrier.path;
  }

  run(): FlowResult {
    for (const node of this.template.nodes) this.visit(node);
    const inOrder = <T>(items: At<T>[]): T[] => items.toSorted((a, b) => a.offset - b.offset).map((item) => item.value);
    return { uses: inOrder(this.uses), next: inOrder(this.next), frontiers: inOrder(this.frontiers) };
  }

  override visitElement(element: TmplAstElement): void {
    const matched = this.template.bound.getDirectivesOfNode(element) ?? [];
    for (const input of element.inputs) this.binding(input, matched, consuming(HANDED_ON));
    for (const output of element.outputs) this.expr(output.handler, consuming(HANDED_ON));
    this.nodes(element.children);
  }

  override visitTemplate(template: TmplAstTemplate): void {
    const matched = this.template.bound.getDirectivesOfNode(template) ?? [];
    const inputs = [...template.templateAttrs, ...template.inputs].filter((attribute) => attribute instanceof TmplAstBoundAttribute);
    let established: readonly Guard[] = [];
    for (const input of inputs) {
      if (input.name === "ngIf") {
        this.expr(input.value, TEST);
        established = this.guardsOf(input.value);
        const alias = template.variables.find((variable) => variable.value === "ngIf");
        const tracked = this.peek(input.value);
        if (alias !== undefined && tracked !== undefined) this.alias(alias, tracked.offset, tracked, "template-read", template.sourceSpan.start.offset);
      } else if (input.name === "ngForOf") {
        this.iterate(input.value, template.variables.find((variable) => variable.value === "$implicit"), template.sourceSpan.start.offset);
      } else this.binding(input, matched, opaque(`binding:${input.name}`));
    }
    for (const output of template.outputs) this.expr(output.handler, consuming(HANDED_ON));
    this.within(established, () => this.nodes(template.children));
  }

  override visitBoundText(text: TmplAstBoundText): void {
    this.expr(text.value, consuming(SHOWN));
  }

  override visitBoundEvent(event: TmplAstBoundEvent): void {
    this.expr(event.handler, consuming(HANDED_ON));
  }

  override visitDeferredTrigger(trigger: TmplAstDeferredTrigger): void {
    if (trigger instanceof TmplAstBoundDeferredTrigger) this.expr(trigger.value, TEST);
  }

  override visitIfBlock(block: TmplAstIfBlock): void {
    let rejected: readonly Guard[] = [];
    for (const branch of block.branches) {
      const established = [...rejected, ...(branch.expression === null ? [] : this.guardsOf(branch.expression))];
      if (branch.expression !== null) {
        rejected = [...rejected, ...this.guardsOf(branch.expression, false)];
        this.expr(branch.expression, TEST);
        const tracked = this.peek(branch.expression);
        if (branch.expressionAlias !== null && tracked !== undefined) this.alias(branch.expressionAlias, tracked.offset, tracked, "template-read", branch.sourceSpan.start.offset);
      }
      this.within(established, () => this.nodes(branch.children));
    }
  }

  override visitForLoopBlock(block: TmplAstForLoopBlock): void {
    this.iterate(block.expression, block.item, block.sourceSpan.start.offset);
    if (block.trackBy !== null) this.expr(block.trackBy, TEST);
    this.nodes(block.children);
    if (block.empty !== null) this.nodes(block.empty.children);
  }

  override visitSwitchBlock(block: TmplAstSwitchBlock): void {
    const compared = consuming({ kind: "compare", operator: "===" });
    this.expr(block.expression, compared);
    const on = this.peek(block.expression);
    const labelsOf = (cases: readonly TmplAstSwitchBlockCase[]): AST[] => cases.flatMap((option) => (option.expression === null ? [] : [option.expression]));
    for (const group of block.groups) {
      for (const label of labelsOf(group.cases)) this.expr(label, compared);
      const isDefault = group.cases.some((option) => option.expression === null);
      const labels = isDefault ? labelsOf(block.groups.filter((other) => other !== group).flatMap((other) => other.cases)) :labelsOf(group.cases);
      const established = on === undefined || labels.length === 0 ? [] : [this.caseGuard(on, block.expression, labels, !isDefault)];
      this.within(established, () => this.nodes(group.children));
    }
  }

  /** The switched value strictly equals one of the labels; a label that is no literal leaves the test unmodelled. */
  private caseGuard(on: Tracked, node: AST, labels: readonly AST[], holds: boolean): Guard {
    const literals = labels.map(literalOf);
    const absences = labels.map(absenceOf);
    if (labels.some((_, index) => literals[index] === undefined && absences[index] === undefined)) return this.guard(on, node, { kind: "case" });
    return this.guard(on, node, {
      kind: "condition",
      test: { kind: "one-of", literals: literals.filter((literal) => literal !== undefined), absences: absences.filter((absence) => absence !== undefined) },
      holds,
    });
  }

  override visitLetDeclaration(declaration: TmplAstLetDeclaration): void {
    const tracked = this.peek(declaration.value);
    if (tracked !== undefined && startsWith(this.changed, tracked.offset)) this.alias(declaration, tracked.offset, tracked, "template-read", declaration.sourceSpan.start.offset);
    else this.expr(declaration.value, consuming(HANDED_ON));
  }

  private nodes(nodes: readonly Parameters<CombinedRecursiveAstVisitor["visit"]>[0][]): void {
    for (const node of nodes) this.visit(node);
  }

  private within(established: readonly Guard[], body: () => void): void {
    const outer = this.guards;
    this.guards = [...outer, ...established];
    body();
    this.guards = outer;
  }

  private evidence(offset: number): Evidence {
    return { path: this.unit.path, line: this.unit.firstLine + this.lineStarts.findLastIndex((start) => start <= offset) };
  }

  private guard(on: Tracked, node: AST, stated: Stated): Guard {
    const guard: Guard = { ...stated, covers: on.offset, evidence: this.evidence(node.sourceSpan.start) };
    this.guardSlots.set(guard, on.slots);
    return guard;
  }

  private optionalChain(on: Tracked, node: AST): Guard {
    return this.guard(on, node, { kind: "optional-chain", test: PRESENT, holds: true });
  }

  /** A guard on one element says nothing about another, so it applies only where its elements are the read's. */
  private applicable(tracked: Tracked, extra: readonly Guard[] = []): Guard[] {
    return [...this.guards, ...tracked.guards, ...extra].filter((guard) => {
      const own = this.guardSlots.get(guard) ?? [];
      return own.every((slot, index) => index >= tracked.slots.length || slot === tracked.slots[index]);
    });
  }

  private rootOf(read: PropertyRead | SafePropertyRead): Tracked | undefined {
    if (!(read instanceof PropertyRead) || !(read.receiver instanceof ImplicitReceiver)) return undefined;
    const target = read.receiver instanceof ThisReceiver ? null : this.template.bound.getExpressionTarget(read);
    if (target === null) return read.name === this.carrier.site.member ? { frame: [], offset: [], slots: [], hops: [], guards: [], steps: [] } : undefined;
    const alias = this.aliases.get(target);
    return alias === undefined ? undefined : { frame: alias.frame, offset: alias.frame, slots: alias.slots, hops: alias.hops, guards: [], steps: [] };
  }

  private tracks(ast: AST): boolean {
    const node = core(ast);
    if (node instanceof PropertyRead) return node.receiver instanceof ImplicitReceiver ? this.rootOf(node) !== undefined : this.tracks(node.receiver);
    if (node instanceof SafePropertyRead || node instanceof KeyedRead || node instanceof SafeKeyedRead || node instanceof Call || node instanceof SafeCall || node instanceof NonNullAssert) {
      return this.tracks(node instanceof NonNullAssert ? node.expression : node.receiver);
    }
    if (node instanceof Binary && (node.operation === "??" || node.operation === "||")) return this.tracks(node.left) && this.carriesContainer(node.left);
    return node instanceof BindingPipe && node.name === "async" && node.args.length === 0 && this.tracks(node.exp);
  }

  /** `a ?? b` and `a || b` carry `a` when it only contains the changed value: `b` cannot add the property. */
  private carriesContainer(left: AST): boolean {
    const tracked = this.peek(left);
    return tracked !== undefined && relatePaths(tracked.offset, this.changed) === "contains";
  }

  private peek(ast: AST): Tracked | undefined {
    const outer = this.quiet;
    this.quiet = true;
    try {
      return this.tracks(ast) ? this.chain(ast) : undefined;
    } finally {
      this.quiet = outer;
    }
  }

  /** The tracked value an expression rooted at the member or an alias evaluates to; undefined when the chain loses it. */
  private chain(ast: AST): Tracked | undefined {
    const node = core(ast);
    if (node instanceof PropertyRead) {
      if (node.receiver instanceof ImplicitReceiver) return this.rootOf(node);
      const receiver = this.chain(node.receiver);
      return receiver && { ...receiver, offset: [...receiver.offset, node.name], steps: this.access(receiver, { kind: "member", name: node.name, optional: false }) };
    }
    if (node instanceof SafePropertyRead) {
      const receiver = this.chain(node.receiver);
      return (
        receiver && {
          ...receiver,
          offset: [...receiver.offset, node.name],
          guards: [...receiver.guards, this.optionalChain(receiver, node)],
          steps: this.access(receiver, { kind: "member", name: node.name, optional: true }),
        }
      );
    }
    if (node instanceof KeyedRead || node instanceof SafeKeyedRead) return this.keyed(node);
    if (node instanceof NonNullAssert) {
      const inner = this.chain(node.expression);
      return inner && { ...inner, guards: [...inner.guards, this.guard(inner, node, { kind: "non-null-assertion" })] };
    }
    if (node instanceof BindingPipe) return this.chain(node.exp);
    if (node instanceof Binary) return this.chain(node.left);
    if (node instanceof Call || node instanceof SafeCall) return this.call(node);
    return undefined;
  }

  private keyed(node: KeyedRead | SafeKeyedRead): Tracked | undefined {
    const receiver = this.chain(node.receiver);
    if (receiver === undefined) return undefined;
    const key = core(node.key);
    const guards = node instanceof SafeKeyedRead ? [...receiver.guards, this.optionalChain(receiver, node)] : receiver.guards;
    const optional = node instanceof SafeKeyedRead;
    if (key instanceof LiteralPrimitive && typeof key.value === "number") {
      return { ...receiver, offset: [...receiver.offset, ELEMENT], slots: [...receiver.slots, `index:${key.value}`], guards, steps: this.access(receiver, { kind: "keyed", key: key.value, optional }) };
    }
    if (key instanceof LiteralPrimitive && typeof key.value === "string") {
      return { ...receiver, offset: [...receiver.offset, key.value], guards, steps: this.access(receiver, { kind: "keyed", key: key.value, optional }) };
    }
    this.end({ ...receiver, guards, steps: this.access(receiver, { kind: "keyed", optional }) }, opaque("computed-key", NONE, "dynamic-access"), node);
    this.expr(node.key, opaque("computed-key"));
    return undefined;
  }

  private access(receiver: Tracked, step: AccessStep): readonly AccessStep[] {
    const relation = relatePaths(receiver.offset, this.changed);
    return relation === "exact" || relation === "beyond" ? [...receiver.steps, step] : receiver.steps;
  }

  /** A call without arguments reads a signal only on the carried member or alias and on `value` of a resource: the callee adds no segment. */
  private readsSignal(callee: AST): boolean {
    if (!(callee instanceof PropertyRead)) return false;
    if (callee.receiver instanceof ImplicitReceiver) return this.rootOf(callee) !== undefined;
    const root = core(callee.receiver);
    const holder = root instanceof PropertyRead && root.receiver instanceof ImplicitReceiver ? this.rootOf(root) : undefined;
    return callee.name === "value" && holder !== undefined && this.changed[holder.offset.length] === "value";
  }

  /** Any other call is a method call: on the changed value it dereferences it, on a container of it the value is lost. */
  private call(node: Call | SafeCall): Tracked | undefined {
    const callee = core(node.receiver);
    if (node.args.length === 0 && this.readsSignal(callee)) {
      const read = this.chain(callee);
      return read && (node instanceof SafeCall ? { ...read, guards: [...read.guards, this.optionalChain(read, node)] } : read);
    }
    const method = callee instanceof PropertyRead || callee instanceof SafePropertyRead ? callee : undefined;
    const prefix = node.args.length === 0 ? "method" : "call";
    const holder = this.chain(method === undefined ? callee : method.receiver);
    const reportsState = method !== undefined && holder !== undefined && this.changed[holder.offset.length] === "value" && RESOURCE_STATE_MEMBERS.has(method.name);
    if (holder !== undefined && !reportsState) {
      const guarded = node instanceof SafeCall || method instanceof SafePropertyRead ? [...holder.guards, this.optionalChain(holder, node)] : holder.guards;
      const changedMethod = method !== undefined && relatePaths([...holder.offset, method.name], this.changed) === "exact";
      const called = changedMethod ? { ...holder, offset: [...holder.offset, method.name] } : { ...holder, steps: method === undefined ? holder.steps : this.access(holder, { kind: "member", name: method.name, optional: method instanceof SafePropertyRead }) };
      const steps = this.access(called, { kind: "call", optional: node instanceof SafeCall });
      this.end({ ...called, steps, guards: guarded }, opaque(`${prefix}:${method?.name ?? "expression"}`, NONE), node);
    }
    for (const argument of node.args) this.expr(argument, opaque(`call:${method?.name ?? "expression"}`));
    return undefined;
  }

  private expr(ast: AST, sink: Sink): void {
    const node = core(ast);
    if (node instanceof Interpolation) return node.expressions.forEach((part) => this.expr(part, consuming(SHOWN)));
    if (node instanceof Chain) return node.expressions.forEach((part) => this.expr(part, sink));
    if (node instanceof Conditional) return this.conditional(node, sink);
    if (node instanceof Unary) return this.expr(node.expr, consuming({ kind: "coerce", operator: node.operator }));
    if (node instanceof Binary) return this.binary(node, sink);
    if (node instanceof PrefixNot || node instanceof TypeofExpression || node instanceof VoidExpression) return this.expr(node.expression, TEST);
    if (this.tracks(node)) {
      const tracked = this.chain(node);
      if (tracked !== undefined) this.end(tracked, sink, node);
      return;
    }
    if (node instanceof BindingPipe) {
      this.expr(node.exp, opaque(`pipe:${node.name}`, { kind: "consume", as: "handed-on", detail: `pipe:${node.name}` }));
      for (const argument of node.args) this.expr(argument, opaque(`pipe-argument:${node.name}`));
      return;
    }
    if (node instanceof Call || node instanceof SafeCall) return this.untrackedCall(node);
    node.visit(new Children((child) => this.expr(child, opaque("expression"))));
  }

  private untrackedCall(node: Call | SafeCall): void {
    const callee = core(node.receiver);
    const named = callee instanceof PropertyRead || callee instanceof SafePropertyRead ? callee : undefined;
    const own = callee instanceof PropertyRead && callee.receiver instanceof ImplicitReceiver && this.template.bound.getExpressionTarget(callee) === null;
    const detail = named?.name === "$any" ? "$any" : own ? `template-call:${named?.name}` : `call:${named?.name ?? "expression"}`;
    this.expr(node.receiver, opaque("expression"));
    for (const argument of node.args) this.expr(argument, opaque(detail));
  }

  private conditional(node: Conditional, sink: Sink): void {
    this.expr(node.condition, TEST);
    this.within(this.guardsOf(node.condition), () => this.expr(node.trueExp, sink));
    this.within(this.guardsOf(node.condition, false), () => this.expr(node.falseExp, sink));
  }

  private binary(node: Binary, sink: Sink): void {
    const { operation, left, right } = node;
    if (operation === "&&") {
      this.expr(left, TEST);
      return this.within(this.guardsOf(left), () => this.expr(right, sink));
    }
    if (operation === "||" || operation === "??") {
      this.fallback(node, sink);
      return this.expr(right, sink);
    }
    if (Binary.isAssignmentOperation(operation)) {
      this.expr(left, operation === "=" ? TEST : consuming({ kind: "coerce", operator: operation }));
      return this.expr(right, opaque("assignment"));
    }
    const nullish = COMPARISONS.has(operation);
    const against = (other: AST): Sink => {
      if (!RELATIONS.has(operation)) return consuming({ kind: "coerce", operator: operation });
      const literal = literalOf(other);
      return consuming({ kind: "compare", operator: operation, ...(literal === undefined ? {} : { literal }) });
    };
    this.expr(left, nullish && this.isAbsent(right) ? TEST : against(right));
    this.expr(right, nullish && this.isAbsent(left) ? TEST : MEMBERSHIP_OPERATORS.has(operation) ? opaque(operation) : against(left));
  }

  /** `??` and `||` on the changed value: it is replaced where absent (`??`) or falsy (`||`), and shown otherwise. */
  private fallback(node: Binary, sink: Sink): void {
    if (!this.tracks(node.left)) return this.expr(node.left, sink);
    const tracked = this.chain(node.left);
    if (tracked === undefined) return;
    const relation = relatePaths(tracked.offset, this.changed);
    if (relation !== "exact") return this.end(tracked, relation === "beyond" ? TEST : sink, node.left);
    const replacement = jsonOf(node.right);
    const test = node.operation === "??" ? PRESENT : TRUTHY;
    this.use(tracked, HANDED_ON, node.left, [this.guard(tracked, node, { kind: "fallback", test, holds: true, replacement: replacement === undefined ? OPAQUE : { kind: "literal", value: replacement } })]);
  }

  private isAbsent(ast: AST): boolean {
    return absenceOf(ast) !== undefined;
  }

  /** What holds where `ast` evaluates to `holds`: a test of a prefix that includes the changed segment, or of an alias of it. */
  private guardsOf(ast: AST, holds = true): Guard[] {
    const node = core(ast);
    if (node instanceof PrefixNot) return this.guardsOf(node.expression, !holds);
    if (node instanceof Binary && !(node instanceof Unary)) {
      if (node.operation === "&&") return holds ? [...this.guardsOf(node.left), ...this.guardsOf(node.right)] : [];
      if (node.operation === "||") return holds ? [] : [...this.guardsOf(node.left, false), ...this.guardsOf(node.right, false)];
      return COMPARISONS.has(node.operation) ? this.equality(node, holds) : [];
    }
    const tracked = this.peek(node);
    return tracked === undefined ? [] : [this.guard(tracked, node, { kind: "condition", test: TRUTHY, holds })];
  }

  /** An equality of a tracked path with an absence, a literal the template writes, or (through `typeof`) a type name, in either order. */
  private equality(node: Binary, holds: boolean): Guard[] {
    const operator = node.operation as EqualityOperator;
    const tested = this.tested(node.left, node.right, operator) ?? this.tested(node.right, node.left, operator);
    return tested === undefined ? [] : [this.guard(tested.on, node, { kind: "condition", test: tested.test, holds })];
  }

  private tested(subject: AST, other: AST, operator: EqualityOperator): { on: Tracked; test: Predicate } | undefined {
    const side = core(subject);
    if (side instanceof TypeofExpression) {
      const type = literalOf(other);
      const on = this.peek(side.expression);
      return on && typeof type === "string" ? { on, test: { kind: "typeof", operator, type } } : undefined;
    }
    const on = this.peek(side);
    if (on === undefined) return undefined;
    const absence = absenceOf(other);
    if (absence !== undefined) return { on, test: { kind: "absence", operator, absence } };
    const literal = literalOf(other);
    return literal === undefined ? undefined : { on, test: { kind: "literal", operator, literal } };
  }

  private end(tracked: Tracked, sink: Sink, node: AST): void {
    const relation = relatePaths(tracked.offset, this.changed);
    if (relation === "disjoint") return;
    if (relation === "beyond") return this.use(tracked, reachedBy(sink), node);
    switch (sink.kind) {
      case "test":
        return;
      case "consume":
        return relation === "contains" ? undefined : this.use(tracked, sink.end, node);
      case "opaque":
        if (relation === "contains" || sink.end === "frontier") return this.frontier(tracked, sink.cause, sink.detail, node.sourceSpan.start);
        return this.use(tracked, sink.end, node);
      case "bind":
        return this.bind(tracked, sink, node);
    }
  }

  private inFrame(guards: readonly Guard[], frame: AccessPath): Guard[] {
    return guards.filter((guard) => startsWith(guard.covers, frame)).map((guard) => ({ ...guard, covers: guard.covers.slice(frame.length) }));
  }

  private use(tracked: Tracked, end: UseEnd, node: AST, extra: readonly Guard[] = []): void {
    if (this.quiet) return;
    const site = this.evidence(node.sourceSpan.start);
    this.uses.push({
      offset: node.sourceSpan.start,
      value: {
        site,
        path: tracked.offset.slice(tracked.frame.length),
        changed: this.changed.slice(tracked.frame.length),
        operation: { steps: tracked.steps, end },
        guards: this.inFrame(this.applicable(tracked, extra), tracked.frame),
        hops: [...tracked.hops, { step: "template-read", evidence: site }],
      },
    });
  }

  private frontier(tracked: Tracked, cause: FrontierCause, detail: string, offset: number): void {
    if (this.quiet) return;
    this.frontiers.push({ offset, value: { at: this.evidence(offset), cause, reason: "unresolved", detail, hops: tracked.hops } });
  }

  private bind(tracked: Tracked, sink: Extract<Sink, { kind: "bind" }>, node: AST): void {
    if (this.quiet) return;
    const establishes = this.applicable(tracked).some((guard) => guard.kind !== "non-null-assertion" && startsWith(guard.covers, this.changed));
    if (establishes) return this.frontier(tracked, "unmodelled-flow", `guarded-binding:${sink.name}`, node.sourceSpan.start);
    const from = tracked.offset.slice(tracked.frame.length);
    const hop: Hop = { step: "template-binding", evidence: this.evidence(node.sourceSpan.start), ...(from.length === 0 ? {} : { rewrite: [{ from, to: [] }] }) };
    const { site } = this.carrier;
    this.next.push({
      offset: node.sourceSpan.start,
      value: {
        carrier: { site: { kind: "input", repo: site.repo, file: sink.ref.path, owner: sink.ref.symbol, name: sink.name }, path: this.changed.slice(tracked.offset.length) },
        hops: [...tracked.hops, hop],
      },
    });
  }

  private alias(key: object, frame: AccessPath, tracked: Tracked, step: FlowStep, offset: number, slots: readonly string[] = tracked.slots): void {
    const relation = relatePaths(frame, this.changed);
    if (relation !== "exact" && relation !== "contains") return;
    const from = frame.slice(tracked.frame.length);
    const hop: Hop = { step, evidence: this.evidence(offset), ...(from.length === 0 ? {} : { rewrite: [{ from, to: [] }] }) };
    this.aliases.set(key, { frame, slots, hops: [...tracked.hops, hop] });
  }

  /** `@for` and `*ngFor`: the item is the element of the iterated value, so it drops a leading `[]`. */
  private iterate(iterable: AST, item: TmplAstVariable | undefined, offset: number): void {
    const tracked = this.peek(iterable);
    let sink = TEST;
    if (tracked !== undefined) {
      const element = [...tracked.offset, ELEMENT];
      const relation = relatePaths(tracked.offset, this.changed);
      if (item !== undefined && startsWith(this.changed, element)) this.alias(item, element, tracked, "iterate", offset, [...tracked.slots, `loop:${offset}`]);
      else if (relation === "contains") this.frontier(tracked, "unmodelled-flow", "iterate", offset);
      else if (relation === "exact") this.use(tracked, ITERATE, iterable);
      else if (relation === "beyond") sink = consuming(ITERATE);
    }
    this.expr(iterable, sink);
  }

  private binding(attribute: TmplAstBoundAttribute, matched: readonly DirectiveMeta[], native: Sink): void {
    const value = core(attribute.value);
    if (value instanceof Interpolation || (attribute.type !== BindingType.Property && attribute.type !== BindingType.TwoWay)) {
      return this.expr(value, consuming(value instanceof Interpolation ? SHOWN : HANDED_ON));
    }
    this.expr(value, this.sinkOf(attribute, matched, native));
  }

  private sinkOf(attribute: TmplAstBoundAttribute, matched: readonly DirectiveMeta[], native: Sink): Sink {
    const unsupported = (detail: string) => opaque(detail, "frontier", "unsupported-binding");
    if (attribute.type === BindingType.TwoWay) return unsupported(`two-way:${attribute.name}`);
    const components = matched.filter((meta) => meta.isComponent);
    const [only] = components;
    if (components.length > 1) return unsupported(`ambiguous-component:${attribute.name}`);
    if (only !== undefined) {
      const member = this.template.members.get(only.ref.key);
      return member === undefined ? unsupported(`unreadable-component:${attribute.name}`) : { kind: "bind", name: attribute.name, ref: member.ref };
    }
    const [directive] = matched;
    return directive === undefined ? native : unsupported(`directive:${directive.name}:${attribute.name}`);
  }
}
