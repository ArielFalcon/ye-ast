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

/**
 * A call through a field whose initializer holds a type from outside the repository, `<module>#<name>` or
 * `global#<name>`, proven by the same evidence as a `MemberUseOrigin`: the call runs on an instance of the owner, nothing
 * writes the field, and no provider replaces its token.
 */
export interface ExternalMemberUseOrigin {
  owner: SymbolRef;
  field: string;
  holds: string;
  reference: ReferenceSite & { name: string; kind: "calls" };
}
