import type { SymbolRef } from "./relation.ts";
import type { ReferenceSite } from "./resolved-reference.ts";

export interface MemberUseOrigin {
  owner: SymbolRef;
  receiver: SymbolRef;
  member: SymbolRef;
  reference: ReferenceSite & { name: string; kind: "calls" };
}

export interface MemberProofContext {
  completeSource: boolean;
}
