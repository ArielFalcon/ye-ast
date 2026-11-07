import {
  type AST,
  Binary,
  Call,
  CombinedRecursiveAstVisitor,
  ImplicitReceiver,
  KeyedRead,
  LiteralPrimitive,
  NonNullAssert,
  ParenthesizedExpression,
  PrefixNot,
  SafeKeyedRead,
  SafePropertyRead,
  TypeofExpression,
  ParseErrorLevel,
  parseTemplate,
  PropertyRead,
  R3TargetBinder,
  SelectorMatcher,
  ThisReceiver,
  type BindingPipe,
  type BoundTarget,
  type DirectiveMeta,
  type TmplAstBoundEvent,
  type TmplAstElement,
  type TmplAstTemplate,
} from "@angular/compiler";
import { relation, type Relation, type RelationKind, type SymbolRef } from "../../domain/relations/relation.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import type { Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { ScopeMember, TemplateEffects, TemplateHandlerCall, TemplateMemberCall, TemplateUnit, TemplateUsageReader, TemplateWrite } from "../../ports/template-usage.port.ts";
import { bindTemplate } from "./template-binding.ts";

/**
 * Templates parsed with ye-ast's own `@angular/compiler` (never the analysed repository's copy, which would run its
 * code). The compiler's selector matcher and target binder decide which directives match an element, `*ngIf`
 * desugaring and the control-flow blocks included; nothing is type-checked.
 */
export function createTemplateUsageReader(): TemplateUsageReader {
  return { read: (units) => sortFindings(units.flatMap(usagesOf)), effects };
}

const COMPARISONS: ReadonlySet<string> = new Set(["==", "===", "!=", "!=="]);

function effects(template: Pick<TemplateUnit, "path" | "text" | "firstLine">): TemplateEffects {
  const parsed = parseTemplate(template.text, template.path);
  if ((parsed.errors ?? []).some((error) => error.level === ParseErrorLevel.ERROR)) return { calls: [], handlers: [], writes: [], passed: [], unreadable: true };
  const bound = new R3TargetBinder(new SelectorMatcher<DirectiveMeta[]>()).bind({ template: parsed.nodes });
  const peel = (ast: AST): AST => (ast instanceof ParenthesizedExpression || ast instanceof NonNullAssert ? peel(ast.expression) : ast);
  const ownField = (ast: AST): PropertyRead | undefined => {
    const read = peel(ast);
    return read instanceof PropertyRead && (read.receiver instanceof ImplicitReceiver || read.receiver instanceof ThisReceiver) && bound.getExpressionTarget(read) === null ? read : undefined;
  };
  const lineStarts = [0, ...[...template.text.matchAll(/\n/g)].map((match) => match.index + 1)];
  const lineOf = (offset: number): number => lineStarts.findLastIndex((start) => start <= offset);
  const calls: TemplateMemberCall[] = [];
  const handlers: TemplateHandlerCall[] = [];
  let inEvent = false;
  const writes: TemplateWrite[] = [];
  const reads: PropertyRead[] = [];
  const used = new Set<AST>();
  const use = (ast: AST): void => {
    const own = ownField(ast);
    if (own !== undefined) used.add(own);
  };
  const placeOf = (offset: number): { file: string; line: number; column: number } => {
    const index = lineOf(offset);
    return { file: template.path, line: template.firstLine + index, column: offset - lineStarts[index]! + 1 };
  };
  const visitor = new (class extends CombinedRecursiveAstVisitor {
    override visitBoundEvent(event: TmplAstBoundEvent): void {
      inEvent = true;
      try {
        super.visitBoundEvent(event);
      } finally {
        inEvent = false;
      }
    }

    override visitPropertyRead(read: PropertyRead, context?: unknown): void {
      if (ownField(read) === read) reads.push(read);
      use(read.receiver);
      super.visitPropertyRead(read, context);
    }

    override visitSafePropertyRead(read: SafePropertyRead, context?: unknown): void {
      use(read.receiver);
      super.visitSafePropertyRead(read, context);
    }

    override visitKeyedRead(read: KeyedRead, context?: unknown): void {
      use(read.receiver);
      super.visitKeyedRead(read, context);
    }

    override visitSafeKeyedRead(read: SafeKeyedRead, context?: unknown): void {
      use(read.receiver);
      super.visitSafeKeyedRead(read, context);
    }

    override visitCall(call: Call, context?: unknown): void {
      const callee = peel(call.receiver);
      const field = callee instanceof PropertyRead ? ownField(callee.receiver) : undefined;
      if (callee instanceof PropertyRead && field !== undefined) calls.push({ ...placeOf(call.sourceSpan.start), field: field.name, member: callee.name });
      if (inEvent && ownField(callee) !== undefined) handlers.push({ ...placeOf(call.sourceSpan.start), member: (callee as PropertyRead).name });
      super.visitCall(call, context);
    }

    override visitPrefixNot(not: PrefixNot, context?: unknown): void {
      use(not.expression);
      super.visitPrefixNot(not, context);
    }

    override visitTypeofExpression(typeOf: TypeofExpression, context?: unknown): void {
      use(typeOf.expression);
      super.visitTypeofExpression(typeOf, context);
    }

    override visitBinary(binary: Binary, context?: unknown): void {
      if (COMPARISONS.has(binary.operation)) {
        use(binary.left);
        use(binary.right);
      }
      if (Binary.isAssignmentOperation(binary.operation)) {
        const left = peel(binary.left);
        const line = template.firstLine + lineOf(binary.sourceSpan.start);
        const own = ownField(left);
        if (own !== undefined) {
          used.add(own);
          writes.push({ line, target: { component: true }, member: own.name });
        } else if (left instanceof PropertyRead || left instanceof KeyedRead) {
          const field = ownField(left.receiver);
          const key = left instanceof PropertyRead ? left.name : peel(left.key) instanceof LiteralPrimitive && typeof (peel(left.key) as LiteralPrimitive).value === "string" ? (peel(left.key) as LiteralPrimitive).value as string : undefined;
          writes.push({ line, target: field === undefined ? { unplaced: true } : { field: field.name }, ...(key === undefined ? {} : { member: key }) });
        } else writes.push({ line, target: { unplaced: true } });
      }
      super.visitBinary(binary, context);
    }
  })();
  for (const node of parsed.nodes) visitor.visit(node);
  return {
    calls: calls.sort((a, b) => a.line - b.line || a.column - b.column),
    handlers: handlers.sort((a, b) => a.line - b.line || a.column - b.column),
    writes,
    passed: [...new Set(reads.filter((read) => !used.has(read)).map((read) => read.name))].sort(),
  };
}

function usagesOf(unit: TemplateUnit): Finding<Relation>[] {
  const at = (line: number): Evidence => ({ path: unit.path, line: unit.firstLine + line });
  const template = bindTemplate(unit);
  if ("errorLine" in template) return [unknown("source-unreadable", at(template.errorLine))];

  const findings: Finding<Relation>[] = template.unreadable.map((ref) => unknown("no-extractor", { path: ref.path, line: ref.line }));
  const { members } = template;
  const pipes = new Map<string, SymbolRef[]>();
  for (const member of unit.scope) if (member.kind === "pipe") pipes.set(member.name, [...(pipes.get(member.name) ?? []), member.ref]);

  const found = new Map<string, Finding<Relation>>();
  const use = (kind: RelationKind, to: SymbolRef, line: number): void => {
    const key = `${kind}\0${to.path}\0${to.symbol}`;
    const existing = found.get(key);
    if (existing === undefined || (existing.evidence[0]?.line ?? 0) > unit.firstLine + line) found.set(key, { status: "complete", value: relation(kind, unit.component, to), evidence: [at(line)] });
  };
  const visitor = new UsageVisitor(template.bound, {
    directive: (meta, line) => {
      const member = members.get(meta.ref.key);
      if (member !== undefined) use(meta.isComponent ? "uses-component" : "uses-directive", member.ref, line);
    },
    clash: (line) => findings.push(unknown("unresolved", at(line))),
    pipe: (name, line) => {
      const named = pipes.get(name) ?? [];
      const [only] = named;
      if (named.length > 1) findings.push(unknown("unresolved", at(line)));
      else if (only !== undefined) use("uses-pipe", only, line);
    },
  });
  for (const node of template.nodes) visitor.visit(node);
  return [...findings, ...found.values()];
}

interface UsageSink {
  directive(meta: DirectiveMeta, line: number): void;
  clash(line: number): void;
  pipe(name: string, line: number): void;
}

/** Walks every node and expression of a template, with the line of the template node the walk is in. */
class UsageVisitor extends CombinedRecursiveAstVisitor {
  private line = 0;

  constructor(
    private readonly bound: BoundTarget<DirectiveMeta>,
    private readonly sink: UsageSink,
  ) {
    super();
  }

  override visit(node: Parameters<CombinedRecursiveAstVisitor["visit"]>[0]): void {
    const span = (node as { sourceSpan?: { start: unknown } }).sourceSpan;
    const outer = this.line;
    if (span !== undefined && typeof span.start === "object") this.line = (span as { start: { line: number } }).start.line;
    super.visit(node);
    this.line = outer;
  }

  override visitElement(element: TmplAstElement): void {
    this.match(element);
    super.visitElement(element);
  }

  override visitTemplate(template: TmplAstTemplate): void {
    this.match(template);
    super.visitTemplate(template);
  }

  override visitPipe(pipe: BindingPipe, context?: unknown): void {
    this.sink.pipe(pipe.name, this.line);
    super.visitPipe(pipe, context);
  }

  private match(node: TmplAstElement | TmplAstTemplate): void {
    const matched = this.bound.getDirectivesOfNode(node) ?? [];
    const components = matched.filter((meta) => meta.isComponent);
    if (components.length > 1) this.sink.clash(node.sourceSpan.start.line);
    for (const meta of matched) if (!meta.isComponent || components.length === 1) this.sink.directive(meta, node.sourceSpan.start.line);
  }
}

function unknown(reason: UnknownReason, at: Evidence): Finding<never> {
  return { status: "unknown", reason, evidence: [at] };
}
