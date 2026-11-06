import { NOT_DECLARED_KINDS, sortedUnique } from "../../domain/impact/importers-fact.ts";
import type { OutlineDeclaration, OutlineFile, OutlineFocus, OutlineFocusValue, OutlineListing } from "../../domain/outline/outline-fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { branchesOf, declarationPath, declarationTree, innermostAt, selectedBySymbol, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { UnknownSymbolFault } from "../../ports/impact-queries.port.ts";
import type { OutlineSelector, TopLevelLineFault } from "../../ports/outline-queries.port.ts";

const IMPORT = "imports";
const CONTAINMENT = "contains";

/** The containment tree of one file's declarations, from the graph's `contains` edges between them. */
export function containmentTree(store: CodeGraphReader, nodes: readonly GraphSymbol[]): DeclarationBranch<GraphSymbol>[] {
  const declared = nodes.filter((node) => !NOT_DECLARED_KINDS.includes(node.kind));
  return declarationTree(declared, store.outgoingEdges(declared.map((node) => node.id), [CONTAINMENT]));
}

/** The shape of every requested file, read from the graph the other queries already use: no file is opened. */
export function readOutline(store: CodeGraphReader, requested: readonly string[]): OutlineListing {
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

export interface FocusRead {
  value: OutlineFocusValue;
  /** The symbol selectors that match no declaration of their file. */
  unknown: UnknownSymbolFault["entries"];
  /** The line selectors no declaration of their file holds. */
  topLevel: TopLevelLineFault["entries"];
}

/** The declarations the selectors match, each with its containers and the count of its file's declarations left out. */
export function readFocus(store: CodeGraphReader, selectors: readonly OutlineSelector[]): FocusRead {
  const focus: OutlineFocus[] = [];
  const unheld: string[] = [];
  const unknown: FocusRead["unknown"][number][] = [];
  const topLevel: FocusRead["topLevel"][number][] = [];
  for (const [file, asked] of [...Map.groupBy(selectors, (selector) => selector.file)].sort(([a], [b]) => compareText(a, b))) {
    const nodes = store.symbolsInFiles([file]);
    if (nodes.length === 0) {
      unheld.push(file);
      continue;
    }
    const tree = containmentTree(store, nodes);
    const declared = branchesOf(tree);
    const candidates = sortedUnique(declared.map(declarationPath));
    for (const selector of asked) {
      const matched = "symbol" in selector ? selectedBySymbol(tree, selector.symbol) : innermostAt(tree, selector.line);
      if (matched.length === 0 && "symbol" in selector) unknown.push({ file, symbol: selector.symbol, candidates });
      if (matched.length === 0 && "line" in selector) topLevel.push({ file, line: selector.line, candidates });
      const text = "symbol" in selector ? selector.symbol : String(selector.line);
      focus.push(...matched.map((branch) => focused(file, text, branch, declared.length)));
    }
  }
  const ordered = focus.toSorted((a, b) => compareText(a.file, b.file) || a.declaration.line - b.declaration.line);
  return { value: { focus: ordered, unheld }, unknown, topLevel };
}

function focused(file: string, selector: string, branch: DeclarationBranch<GraphSymbol>, declarations: number): OutlineFocus {
  const ancestors = branch.ancestors.map(({ kind, name, startLine, endLine }) => ({ kind, name, line: startLine, endLine }));
  return { file, selector, path: declarationPath(branch), ancestors, declaration: outlined(branch), omitted: declarations - ancestors.length - branchesOf([branch]).length };
}
