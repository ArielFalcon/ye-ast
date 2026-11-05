import type { SymbolRef } from "./relation.ts";
import type { ReferenceSite } from "./resolved-reference.ts";

export interface MemberUseOrigin {
  owner: SymbolRef;
  receiver: SymbolRef;
  member: SymbolRef;
  reference: ReferenceSite & { name: string; kind: "calls" };
  /** The classes a provider may inject instead of the receiver (`useClass`, `useExisting`), with the provider's site. */
  substitutes?: readonly MemberSubstitute[];
}

export interface MemberSubstitute {
  class: SymbolRef;
  at: { path: string; line: number };
}

export interface MemberProofContext {
  completeSource: boolean;
}
