import { compareText } from "./code-node.ts";

/** A declaration the containment tree places: its handle, its name and its span. */
export interface TreeDeclaration {
  id: string;
  name: string;
  startLine: number;
  endLine: number;
}

/** A declaration in its file's containment tree: the declarations around it, outermost first, and those directly inside it. */
export interface DeclarationBranch<D extends TreeDeclaration> {
  declaration: D;
  ancestors: readonly D[];
  /** In line then name order. */
  children: readonly DeclarationBranch<D>[];
}

/**
 * The containment tree of one file's declarations: a declaration sits under the first containment pair whose container
 * is another of the declarations; one no pair places is a root. Nesting comes from the pairs only, never from spans.
 */
export function declarationTree<D extends TreeDeclaration>(declarations: readonly D[], containment: readonly { source: string; target: string }[]): DeclarationBranch<D>[] {
  const byId = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  const inside = new Map<string, D[]>();
  const placed = new Set<string>();
  for (const { source, target } of containment) {
    const member = byId.get(target);
    if (!byId.has(source) || member === undefined || placed.has(target)) continue;
    placed.add(target);
    inside.set(source, [...(inside.get(source) ?? []), member]);
  }
  const branches = (members: readonly D[], ancestors: readonly D[]): DeclarationBranch<D>[] =>
    members
      .toSorted((a, b) => a.startLine - b.startLine || compareText(a.name, b.name))
      .map((declaration) => ({ declaration, ancestors, children: branches(inside.get(declaration.id) ?? [], [...ancestors, declaration]) }));
  return branches(declarations.filter((declaration) => !placed.has(declaration.id)), []);
}

/** Every branch of the tree, each container before what it contains. */
export function branchesOf<D extends TreeDeclaration>(tree: readonly DeclarationBranch<D>[]): DeclarationBranch<D>[] {
  return tree.flatMap((branch) => [branch, ...branchesOf(branch.children)]);
}

/** The dotted path of a declaration: the names of its containers, outermost first, then its own. */
export function declarationPath<D extends TreeDeclaration>(branch: DeclarationBranch<D>): string {
  return [...branch.ancestors, branch.declaration].map(({ name }) => name).join(".");
}

/**
 * The declarations a symbol selects: those whose dotted path ends with it at a whole name. A bare name selects every
 * declaration of that name at any depth; `A.m` selects only an `m` that `A` contains directly.
 */
export function selectedBySymbol<D extends TreeDeclaration>(tree: readonly DeclarationBranch<D>[], symbol: string): DeclarationBranch<D>[] {
  return branchesOf(tree).filter((branch) => {
    const names = [...branch.ancestors, branch.declaration].map(({ name }) => name);
    return names.some((_, start) => names.slice(start).join(".") === symbol);
  });
}
