import { NOT_DECLARED_KINDS, sortedUnique } from "../../domain/impact/importers-fact.ts";
import type { OutlineDeclaration, OutlineFile, OutlineValue } from "../../domain/outline/outline-fact.ts";
import { declarationTree, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";

const IMPORT = "imports";
const CONTAINMENT = "contains";

/** The containment tree of one file's declarations, from the graph's `contains` edges between them. */
export function containmentTree(store: CodeGraphReader, nodes: readonly GraphSymbol[]): DeclarationBranch<GraphSymbol>[] {
  const declared = nodes.filter((node) => !NOT_DECLARED_KINDS.includes(node.kind));
  return declarationTree(declared, store.outgoingEdges(declared.map((node) => node.id), [CONTAINMENT]));
}

/** The shape of every requested file, read from the graph the other queries already use: no file is opened. */
export function readOutline(store: CodeGraphReader, requested: readonly string[]): OutlineValue {
  const files: OutlineFile[] = [];
  const unheld: string[] = [];
  for (const file of sortedUnique(requested)) {
    const nodes = store.symbolsInFiles([file]);
    if (nodes.length === 0) {
      unheld.push(file);
      continue;
    }
    const targets = store.outgoingEdges(nodes.map((node) => node.id), [IMPORT]).map((edge) => edge.target);
    const imported = store.symbolsByIds([...new Set(targets)]).map((symbol) => symbol.file);
    files.push({
      file,
      declarations: containmentTree(store, nodes).map(outlined),
      imports: sortedUnique(imported.filter((other) => other !== file)),
    });
  }
  return { files, unheld };
}

function outlined({ declaration, children }: DeclarationBranch<GraphSymbol>): OutlineDeclaration {
  const nested = children.map(outlined);
  return { kind: declaration.kind, name: declaration.name, line: declaration.startLine, endLine: declaration.endLine, ...(nested.length > 0 && { children: nested }) };
}
