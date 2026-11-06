import type { ModuleBinding } from "../impact/module-dependency.ts";

/** A graph `imports` edge as the join reads it: where codegraph wrote it (0-based column) and what it reaches. */
export interface PlacedImport<S> {
  line: number | null;
  column: number | null;
  target: S;
}

/**
 * The declaration one binding reaches: the single `imports` edge written at the binding's own position whose target is
 * a declaration, never a file; for a binding no edge reaches, the declaration at the containment path syntax
 * names in its target file (`exportedAs`). A binding of the module itself (`*`) reaches no declaration.
 */
export function bindingDeclaration<S>(binding: ModuleBinding, edges: readonly PlacedImport<S>[], isDeclaration: (target: S) => boolean, named?: S): S | undefined {
  if (binding.imported === "*") return undefined;
  const placed = [...new Set(edges.filter((edge) => edge.line === binding.line && edge.column !== null && edge.column + 1 === binding.column && isDeclaration(edge.target)).map((edge) => edge.target))];
  if (placed.length === 1) return placed[0];
  return placed.length === 0 ? named : undefined;
}
