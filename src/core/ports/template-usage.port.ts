import type { Relation, SymbolRef } from "../domain/relations/relation.ts";
import type { Finding } from "../domain/shared/fact.ts";

/** What a template can use: a component or directive by its selector, a pipe by its name. */
export type ScopeMember = { kind: "component" | "directive"; ref: SymbolRef; selector: string } | { kind: "pipe"; ref: SymbolRef; name: string };

export interface TemplateUnit {
  component: SymbolRef;
  /** The file the template text is in, which is the evidence path. */
  path: string;
  text: string;
  /** The line of the file the first line of the text sits on. */
  firstLine: number;
  scope: readonly ScopeMember[];
}

/** A template call `field.member(...)` whose `field` the compiler binds to the component, not to a template local. */
export interface TemplateMemberCall {
  file: string;
  line: number;
  column: number;
  field: string;
  member: string;
}

/**
 * A write a template makes: to a member of the component itself (its own field), to a member of the object one of its
 * fields holds, or to a member of an object the template does not place; `member` is absent when the key is computed.
 */
export interface TemplateWrite {
  line: number;
  target: { component: true } | { field: string } | { unplaced: true };
  member?: string;
}

/** What one template does through the component's own fields: its member calls, its writes, and the fields it passes on. */
export interface TemplateEffects {
  calls: readonly TemplateMemberCall[];
  writes: readonly TemplateWrite[];
  /** The fields whose value the template hands to something other than a member access, call or test of it. */
  passed: readonly string[];
  unreadable?: true;
}

export interface TemplateUsageReader {
  /**
   * The components, directives and pipes of each unit's scope that its template uses. A template that does not parse,
   * an element two components match and a pipe name two pipes in scope share are unknown items, never edges.
   */
  read(units: readonly TemplateUnit[]): readonly Finding<Relation>[];
  /** What one template does through the component's own fields; calls in text order. */
  effects(template: Pick<TemplateUnit, "path" | "text" | "firstLine">): TemplateEffects;
}
