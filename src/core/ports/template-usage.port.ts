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
  /** Where the text starts in its file, for the sites that name a place in the file: the start of its first line; absent for a file of its own. */
  offset?: number;
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

/** A call an event binding makes to a method of the component itself: `(click)="save()"` or `this.save()`. */
export interface TemplateHandlerCall {
  file: string;
  line: number;
  column: number;
  member: string;
}

/** Any other call an event binding makes, by the spelling of what it calls: `store.save`, a template local's, `$event.stopPropagation`. */
export interface TemplateEventCall {
  file: string;
  line: number;
  column: number;
  name: string;
}

/** What each unit's template uses, and in which order: the declarations, in the order they first appear in its text. */
export interface TemplateUsage {
  relations: readonly Finding<Relation>[];
  uses: readonly { component: SymbolRef; uses: readonly SymbolRef[] }[];
}

/** What one template does through the component's own fields: its member calls, its writes, and the fields it passes on. */
export interface TemplateEffects {
  /** Own methods and other calls outside event bindings, in template text order. */
  renderHandlers?: readonly TemplateHandlerCall[];
  renderCalls?: readonly TemplateEventCall[];
  calls: readonly TemplateMemberCall[];
  /** The component's own methods its event bindings call, in text order. */
  handlers: readonly TemplateHandlerCall[];
  /** Every other call its event bindings make, in text order. */
  eventCalls: readonly TemplateEventCall[];
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
  read(units: readonly TemplateUnit[]): TemplateUsage;
  /** What one template does through the component's own fields; calls in text order. */
  effects(template: Pick<TemplateUnit, "path" | "text" | "firstLine">): TemplateEffects;
}
