import {
  Binary,
  Call,
  ClassPropertyMapping,
  CombinedRecursiveAstVisitor,
  CssSelector,
  ImplicitReceiver,
  MatchSource,
  ParseErrorLevel,
  parseTemplate,
  PropertyRead,
  R3TargetBinder,
  SelectorMatcher,
  ThisReceiver,
  type BindingPipe,
  type BoundTarget,
  type DirectiveMeta,
  type TmplAstElement,
  type TmplAstTemplate,
} from "@angular/compiler";
import { relation, type Relation, type RelationKind, type SymbolRef } from "../../domain/relations/relation.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import type { Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { ScopeMember, TemplateMemberCall, TemplateUnit, TemplateUsageReader } from "../../ports/template-usage.port.ts";

/**
 * Templates parsed with ye-ast's own `@angular/compiler` (never the analysed repository's copy, which would run its
 * code). The compiler's selector matcher and target binder decide which directives match an element, `*ngIf`
 * desugaring and the control-flow blocks included; nothing is type-checked.
 */
export function createTemplateUsageReader(): TemplateUsageReader {
  return { read: (units) => sortFindings(units.flatMap(usagesOf)), memberCalls };
}

function memberCalls(template: Pick<TemplateUnit, "path" | "text" | "firstLine">): TemplateMemberCall[] {
  const parsed = parseTemplate(template.text, template.path);
  if ((parsed.errors ?? []).some((error) => error.level === ParseErrorLevel.ERROR)) return [];
  const bound = new R3TargetBinder(new SelectorMatcher<DirectiveMeta[]>()).bind({ template: parsed.nodes });
  const ownField = (ast: unknown): ast is PropertyRead =>
    ast instanceof PropertyRead && (ast.receiver instanceof ImplicitReceiver || ast.receiver instanceof ThisReceiver) && bound.getExpressionTarget(ast) === null;
  const calls: { field: string; member: string; offset: number }[] = [];
  const written = new Set<string>();
  const visitor = new (class extends CombinedRecursiveAstVisitor {
    override visitCall(call: Call, context?: unknown): void {
      const callee = call.receiver;
      if (callee instanceof PropertyRead && ownField(callee.receiver)) calls.push({ field: callee.receiver.name, member: callee.name, offset: call.sourceSpan.start });
      super.visitCall(call, context);
    }

    override visitBinary(binary: Binary, context?: unknown): void {
      if (Binary.isAssignmentOperation(binary.operation) && ownField(binary.left)) written.add(binary.left.name);
      super.visitBinary(binary, context);
    }
  })();
  for (const node of parsed.nodes) visitor.visit(node);
  const lineStarts = [0, ...[...template.text.matchAll(/\n/g)].map((match) => match.index + 1)];
  return calls
    .filter((call) => !written.has(call.field))
    .sort((a, b) => a.offset - b.offset)
    .map(({ field, member, offset }) => {
      const index = lineStarts.findLastIndex((start) => start <= offset);
      return { file: template.path, line: template.firstLine + index, column: offset - lineStarts[index]! + 1, field, member };
    });
}

type Member = Exclude<ScopeMember, { kind: "pipe" }>;

function usagesOf(unit: TemplateUnit): Finding<Relation>[] {
  const at = (line: number): Evidence => ({ path: unit.path, line: unit.firstLine + line });
  const parsed = parseTemplate(unit.text, unit.path);
  const errors = (parsed.errors ?? []).filter((error) => error.level === ParseErrorLevel.ERROR);
  const [first] = errors;
  if (first !== undefined) return [unknown("source-unreadable", at(first.span.start.line))];

  const findings: Finding<Relation>[] = [];
  const matcher = new SelectorMatcher<DirectiveMeta[]>();
  const members = new Map<string, Member>();
  for (const member of unit.scope) {
    if (member.kind === "pipe") continue;
    try {
      const meta = directiveMeta(member);
      matcher.addSelectables(CssSelector.parse(member.selector), [meta]);
      members.set(meta.ref.key, member);
    } catch {
      findings.push(unknown("no-extractor", { path: member.ref.path, line: member.ref.line }));
    }
  }
  const pipes = new Map<string, SymbolRef[]>();
  for (const member of unit.scope) if (member.kind === "pipe") pipes.set(member.name, [...(pipes.get(member.name) ?? []), member.ref]);

  const bound = new R3TargetBinder(matcher).bind({ template: parsed.nodes });
  const found = new Map<string, Finding<Relation>>();
  const use = (kind: RelationKind, to: SymbolRef, line: number): void => {
    const key = `${kind}\0${to.path}\0${to.symbol}`;
    const existing = found.get(key);
    if (existing === undefined || (existing.evidence[0]?.line ?? 0) > unit.firstLine + line) found.set(key, { status: "complete", value: relation(kind, unit.component, to), evidence: [at(line)] });
  };
  const visitor = new UsageVisitor(bound, {
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
  for (const node of parsed.nodes) visitor.visit(node);
  return [...findings, ...found.values()];
}

function directiveMeta(member: Member): DirectiveMeta {
  return {
    name: member.ref.symbol,
    ref: { key: `${member.ref.path}\0${member.ref.symbol}` },
    selector: member.selector,
    isComponent: member.kind === "component",
    inputs: ClassPropertyMapping.empty(),
    outputs: ClassPropertyMapping.empty(),
    exportAs: null,
    isStructural: false,
    ngContentSelectors: null,
    preserveWhitespaces: false,
    animationTriggerNames: null,
    matchSource: MatchSource.Selector,
  };
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
