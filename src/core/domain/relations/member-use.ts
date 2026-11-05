import type { SymbolRef } from "./relation.ts";
import type { ReferenceSite } from "./resolved-reference.ts";

export interface MemberUseOrigin {
  owner: SymbolRef;
  receiver: SymbolRef;
  member: SymbolRef;
  reference: ReferenceSite & { name: string; kind: "calls" };
  /** The classes a provider may inject instead of the receiver (`useClass`, `useExisting`), with the provider's site. */
  substitutes?: readonly MemberSubstitute[];
  /** The call sits in the owner's template, which has no graph reference: the owner itself is the caller. */
  template?: true;
}

export interface MemberSubstitute {
  class: SymbolRef;
  at: { path: string; line: number };
}

export interface MemberProofContext {
  completeSource: boolean;
}
