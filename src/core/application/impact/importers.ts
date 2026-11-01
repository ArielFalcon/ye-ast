import { NOT_DECLARED_KINDS, sortedUnique, unresolvedNamersOf, type ImportedFile } from "../../domain/impact/importers-fact.ts";
import type { UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import type { CodeGraphReader, GraphEdge } from "../../ports/code-graph.port.ts";

export interface ImportersRead {
  /** One entry per requested file the index holds, in path order. */
  files: ImportedFile[];
  /** The requested files the index holds no node of. */
  unheld: string[];
}

/** Containment is structure, not use; every other edge into a file's nodes makes its source file a user. */
const CONTAINMENT = "contains";
const IMPORT = "imports";

export function readImporters(store: CodeGraphReader, requested: readonly string[], references: readonly UnresolvedUse[]): ImportersRead {
  const files: ImportedFile[] = [];
  const unheld: string[] = [];
  for (const file of sortedUnique(requested)) {
    const nodes = store.symbolsInFiles([file]);
    if (nodes.length === 0) {
      unheld.push(file);
      continue;
    }
    const edges = store.incomingEdges(nodes.map((node) => node.id));
    const sourceFiles = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.source))]).map((symbol) => [symbol.id, symbol.file]));
    const from = (accept: (edge: GraphEdge) => boolean): string[] =>
      sortedUnique(edges.filter(accept).flatMap((edge) => sourceFiles.get(edge.source) ?? []).filter((other) => other !== file));
    const declared = new Set(nodes.filter((node) => !NOT_DECLARED_KINDS.includes(node.kind)).map((node) => node.name));
    files.push({
      file,
      importers: from((edge) => edge.kind === IMPORT),
      users: from((edge) => edge.kind !== CONTAINMENT),
      unresolvedNamers: unresolvedNamersOf(file, declared, references),
    });
  }
  return { files, unheld };
}
