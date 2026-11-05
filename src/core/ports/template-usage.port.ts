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

export interface TemplateUsageReader {
  /**
   * The components, directives and pipes of each unit's scope that its template uses. A template that does not parse,
   * an element two components match and a pipe name two pipes in scope share are unknown items, never edges.
   */
  read(units: readonly TemplateUnit[]): readonly Finding<Relation>[];
  /**
   * The member calls through the component's own fields in one template, in text order. A template that does not parse
   * and a field the template assigns give none.
   */
  memberCalls(template: Pick<TemplateUnit, "path" | "text" | "firstLine">): readonly TemplateMemberCall[];
}
