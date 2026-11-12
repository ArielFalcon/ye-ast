import type { SourcePosition } from "../domain/shared/owning-body.ts";
import type { SymbolRef } from "../domain/relations/relation.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";
import type { DeclaredDeclaration } from "./declared-member-names.port.ts";

export interface FrameworkMemberBinding {
  member: SourcePosition;
  holder: SymbolRef;
  evidence: { framework: string; file: string; line: number };
  declaration?: DeclaredDeclaration;
  deferredFactory?: true;
}

export interface FrameworkMemberBindings {
  bindings(file: SourceFile): Promise<readonly FrameworkMemberBinding[]>;
}
