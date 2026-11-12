import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import type { ModuleBinding, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import { bindingDeclaration, type PlacedImport } from "../../domain/relations/import-binding.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import { branchesOf, declarationPath } from "../../domain/shared/declaration-tree.ts";
import type { DeclarationModel } from "./declaration-model.ts";

const IMPORT = "imports";
const isDeclaration = (symbol: GraphSymbol): boolean => !NOT_DECLARED_KINDS.includes(symbol.kind);

/**
 * The declaration each binding of one file's module statements reaches, joined with the graph's `imports` edges of
 * that file by position. A binding the join does not prove is absent from the map.
 */
export async function importBindings(store: CodeGraphReader, file: string, dependencies: readonly ModuleDependency[], declarations: DeclarationModel): Promise<ReadonlyMap<ModuleBinding, GraphSymbol>> {
  const nodes = store.symbolsInFiles([file]);
  const edges = store.outgoingEdges(nodes.map((node) => node.id), [IMPORT]);
  const targets = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.target))]).map((symbol) => [symbol.id, symbol]));
  const placed = edges.flatMap((edge): PlacedImport<GraphSymbol>[] => {
    const target = targets.get(edge.target);
    return target === undefined ? [] : [{ line: edge.line, column: edge.column, target }];
  });
  const reached = new Map<ModuleBinding, GraphSymbol>();
  for (const dependency of dependencies) {
    for (const binding of dependency.bindings) {
      const declaration = bindingDeclaration(binding, placed, isDeclaration, await namedDeclaration(declarations, dependency, binding));
      if (declaration !== undefined) reached.set(binding, declaration);
    }
  }
  return reached;
}

async function namedDeclaration(declarations: DeclarationModel, dependency: ModuleDependency, binding: ModuleBinding): Promise<GraphSymbol | undefined> {
  return binding.exportedAs === undefined || dependency.target.kind !== "repository" ? undefined : declarationAt(declarations, dependency.target.file, binding.exportedAs);
}

/** Joins an independently proven path with the exact lexical chain; it does not establish that chain's file placement. */
export async function declarationAt(declarations: DeclarationModel, file: string, path: string): Promise<GraphSymbol | undefined> {
  const named = branchesOf(await declarations.tree(file)).filter((branch) => declarationPath(branch) === path);
  return named.length === 1 ? named[0]!.declaration.symbol : undefined;
}
