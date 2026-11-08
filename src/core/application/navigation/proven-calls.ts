import type { SymbolRef } from "../../domain/relations/relation.ts";
import type { ExternalMemberUseOrigin, MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { TypeBinding, TypeTarget } from "../../ports/type-bindings.port.ts";
import { compactSpelling } from "../../domain/shared/call-place.ts";

/** What the relations prove a member call runs. */
export type ProvenCall = { kind: "member"; receiver: SymbolRef; member: SymbolRef } | { kind: "external"; holds: string } | { kind: "replaceable" };

export interface ProvenCalls {
  /** By `spelledKey` of the place a call starts and the name it spells. */
  bySpelling: ReadonlyMap<string, ProvenCall>;
  /** By `provenKey` of the place a call starts and the member it reaches. */
  byMember: ReadonlyMap<string, ProvenCall>;
}

export const provenKey = (file: string, line: number, column: number, name: string): string => JSON.stringify([file, line, column, name]);

/** `provenKey` of a call's whole spelling, without the whitespace a source may break it with. */
export const spelledKey = (file: string, line: number, column: number, spelling: string): string => provenKey(file, line, column, compactSpelling(spelling));

/**
 * What the relations prove each member call runs, by its place: a repository member of the class a field or local holds
 * (RFC-0013 R3), or a type from outside the repository a field holds. A place two proofs name, a template's call and a
 * receiver a provider may replace prove nothing here.
 */
export function provenCallsOf(memberUses: readonly MemberUseOrigin[] | undefined, externalUses: readonly ExternalMemberUseOrigin[] | undefined): ProvenCalls {
  const bySpelling = new Map<string, ProvenCall[]>();
  const byMember = new Map<string, ProvenCall[]>();
  const add = (site: { file: string; line: number; column: number; name: string }, call: ProvenCall): void => {
    for (const [byPlace, key] of [[bySpelling, spelledKey(site.file, site.line, site.column, site.name)], [byMember, provenKey(site.file, site.line, site.column, site.name.slice(site.name.lastIndexOf(".") + 1))]] as const) byPlace.set(key, [...(byPlace.get(key) ?? []), call]);
  };
  for (const use of memberUses ?? []) if (use.template !== true) add(use.reference, use.substitutes === undefined ? { kind: "member", receiver: use.receiver, member: use.member } : { kind: "replaceable" });
  for (const use of externalUses ?? []) add(use.reference, { kind: "external", holds: use.holds });
  const unique = (byPlace: Map<string, ProvenCall[]>) => new Map([...byPlace].flatMap(([key, calls]) => (calls.length === 1 ? [[key, calls[0]!] as const] : [])));
  return { bySpelling: unique(bySpelling), byMember: unique(byMember) };
}

/** The declaration the type checker binds each call to, by `provenKey` of the place the call starts and the name it spells; a place two bindings name binds nothing. */
export function typedCallsOf(bindings: readonly TypeBinding[]): ReadonlyMap<string, TypeTarget> {
  const byPlace = Map.groupBy(bindings, ({ file, line, column, name }) => provenKey(file, line, column, name));
  return new Map([...byPlace].flatMap(([key, found]) => (found.length === 1 ? [[key, found[0]!.target] as const] : [])));
}

/** The one declaration of the graph a repository binding names: its name, with the line its name stands on inside it. */
export function typedDeclaration(store: CodeGraphReader, target: Extract<TypeTarget, { kind: "repository" }>): GraphSymbol | undefined {
  const named = store.symbolsInFiles([target.file]).filter((symbol) => symbol.name === target.name && symbol.startLine <= target.line && target.line <= symbol.endLine);
  return named.length === 1 ? named[0] : undefined;
}
