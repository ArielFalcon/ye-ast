import { containsPosition, declarationSpan } from "../../domain/shared/owning-body.ts";
import type { GraphSymbol } from "../../ports/code-graph.port.ts";
import { indexedDeclaration, isNamedMember, type DeclarationModel, type ModelDeclaration } from "../navigation/declaration-model.ts";
import type { ReconciledCalls } from "../navigation/reconciled-calls.ts";

/**
 * Who owns what a syntax-only declaration writes, as the inbound walk reads it (ADR-0093). Answers are those of the files
 * `load` has read.
 */
export interface SyntaxOwners {
  /** Reads the files not read yet; whether a member of one writes a call, which moves a dependence the walk has read. */
  load(files: readonly string[]): Promise<boolean>;
  /** The member a holder names that writes the call at `line` of the indexed declaration `from`, none when no one member does. */
  memberAt(from: GraphSymbol, line: number): ModelDeclaration | undefined;
  /** The declaration around a syntax-only declaration: its holder when a holder names it, else the innermost one whose span holds it. */
  ownerOf(declaration: ModelDeclaration): GraphSymbol | ModelDeclaration | undefined;
}

/** What a walk reads without a declaration model: no member writes a call and no declaration has an owner. */
export const NO_SYNTAX_OWNERS: SyntaxOwners = { load: async () => false, memberAt: () => undefined, ownerOf: () => undefined };

export function createSyntaxOwners(declarations: DeclarationModel, ownedIn: ReconciledCalls["ownedIn"]): SyntaxOwners {
  const loaded = new Set<string>();
  const members = new Map<string, ModelDeclaration | null>();
  const owners = new Map<string, GraphSymbol | ModelDeclaration | null>();
  const placeOf = (declaration: ModelDeclaration): ModelDeclaration | undefined => {
    for (let at: ModelDeclaration | undefined = declaration; at !== undefined; ) {
      if (isNamedMember(at)) return at;
      const around: GraphSymbol | ModelDeclaration | null | undefined = owners.get(at.id);
      at = around === null || around === undefined || indexedDeclaration(around) !== undefined ? undefined : (around as ModelDeclaration);
    }
    return undefined;
  };
  return {
    async load(files) {
      const fresh = [...new Set(files)].filter((file) => !loaded.has(file));
      for (const file of fresh) loaded.add(file);
      let found = false;
      for (const file of fresh) {
        const list = await declarations.list(file);
        const syntaxOnly = list.filter(({ symbol }) => symbol === undefined);
        for (const declaration of syntaxOnly) {
          const around = (await declarations.ownersOf(file, { line: declaration.startLine, column: declaration.startColumn })).find(({ id }) => id !== declaration.id);
          owners.set(declaration.id, around === undefined ? null : around.symbol ?? around);
        }
        if (syntaxOnly.length === 0) continue;
        const byId = new Map(syntaxOnly.map((declaration) => [declaration.id, declaration]));
        for (const [key, calls] of await ownedIn(file)) {
          const owner = byId.get(key);
          const member = owner === undefined ? undefined : placeOf(owner);
          if (member === undefined) continue;
          found = true;
          for (const call of calls) {
            if (call.ambiguous === true) continue;
            const at = `${file}:${call.line}`;
            const held = members.get(at);
            members.set(at, held === undefined || held?.id === member.id ? member : null);
          }
        }
      }
      return found;
    },
    memberAt(from, line) {
      const member = members.get(`${from.file}:${line}`);
      return member === undefined || member === null || !containsPosition(declarationSpan(from), { line: member.startLine, column: member.startColumn }) ? undefined : member;
    },
    ownerOf(declaration) {
      return owners.get(declaration.id) ?? undefined;
    },
  };
}
