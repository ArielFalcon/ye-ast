import type { Evidence } from "../shared/fact.ts";
import type { SymbolRef } from "./relation.ts";

/** A class a list of an Angular decorator names (`imports`, `declarations`, `exports`, `hostDirectives`), or where the list cannot be read. */
export type Operand = { ref: SymbolRef; at: Evidence } | { unresolved: Evidence };

/** Where the template of a component is: written in the decorator, in a file, or named by an expression the sources do not give as text. */
export type TemplateSource = { inline: { text: string; line: number } } | { file: { path: string; at: Evidence } } | { unreadable: Evidence };

/** A class decorated with `@Component`, `@Directive`, `@Pipe` or `@NgModule`, with the metadata the template scope is made of. */
export type AngularClass =
  | { kind: "component"; ref: SymbolRef; selector?: string; template?: TemplateSource; imports: readonly Operand[]; hostDirectives: readonly Operand[] }
  | { kind: "directive"; ref: SymbolRef; selector?: string; hostDirectives: readonly Operand[] }
  | { kind: "pipe"; ref: SymbolRef; name?: string }
  | { kind: "module"; ref: SymbolRef; declarations: readonly Operand[]; imports: readonly Operand[]; exports: readonly Operand[] };

export function classKey(ref: SymbolRef): string {
  return `${ref.path}\0${ref.symbol}`;
}
