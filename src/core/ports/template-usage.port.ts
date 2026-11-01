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

export interface TemplateUsageReader {
  /**
   * The components, directives and pipes of each unit's scope that its template uses. A template that does not parse,
   * an element two components match and a pipe name two pipes in scope share are unknown items, never edges.
   */
  read(units: readonly TemplateUnit[]): readonly Finding<Relation>[];
}
