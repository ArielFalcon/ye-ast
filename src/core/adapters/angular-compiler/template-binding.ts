import {
  ClassPropertyMapping,
  CssSelector,
  MatchSource,
  ParseErrorLevel,
  parseTemplate,
  R3TargetBinder,
  SelectorMatcher,
  type BoundTarget,
  type DirectiveMeta,
  type TmplAstNode,
} from "@angular/compiler";
import type { SymbolRef } from "../../domain/relations/relation.ts";
import type { ScopeMember, TemplateUnit } from "../../ports/template-usage.port.ts";

export type TemplateMember = Exclude<ScopeMember, { kind: "pipe" }>;

export interface BoundTemplate {
  nodes: TmplAstNode[];
  bound: BoundTarget<DirectiveMeta>;
  /** The scope member each matcher entry stands for, by the key of its directive reference. */
  members: Map<string, TemplateMember>;
  /** The scope members whose selector the matcher cannot read. */
  unreadable: SymbolRef[];
}

/** A template that does not parse is the 0-based line of its first error. */
export type TemplateBinding = BoundTemplate | { errorLine: number };

/**
 * Parses a unit's template with the compiler's own parser and binds it against the unit's scope: the selector matcher
 * decides which components and directives match an element.
 */
export function bindTemplate(unit: Pick<TemplateUnit, "path" | "text" | "scope">): TemplateBinding {
  const parsed = parseTemplate(unit.text, unit.path);
  const [first] = (parsed.errors ?? []).filter((error) => error.level === ParseErrorLevel.ERROR);
  if (first !== undefined) return { errorLine: first.span.start.line };

  const matcher = new SelectorMatcher<DirectiveMeta[]>();
  const members = new Map<string, TemplateMember>();
  const unreadable: SymbolRef[] = [];
  for (const member of unit.scope) {
    if (member.kind === "pipe") continue;
    try {
      const meta = directiveMeta(member);
      matcher.addSelectables(CssSelector.parse(member.selector), [meta]);
      members.set(meta.ref.key, member);
    } catch {
      unreadable.push(member.ref);
    }
  }
  return { nodes: parsed.nodes, bound: new R3TargetBinder(matcher).bind({ template: parsed.nodes }), members, unreadable };
}

function directiveMeta(member: TemplateMember): DirectiveMeta {
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
