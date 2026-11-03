import { compareText } from "../../domain/shared/code-node.ts";
import type { OutlineFile } from "../../domain/outline/outline-fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";

export interface OutlineRead {
  /** One entry per requested file the index holds a node of, in path order. */
  files: OutlineFile[];
  /** The requested files the index holds no node of. */
  unheld: string[];
}

/** A file, an import or an export is structure, not a declaration a reader opens. */
const NOT_A_DECLARATION: readonly string[] = ["file", "import", "export"];
const IMPORT = "imports";

/** The shape of every requested file, read from the graph the other queries already use: no file is opened. */
export function readOutline(store: CodeGraphReader, requested: readonly string[]): OutlineRead {
  const files: OutlineFile[] = [];
  const unheld: string[] = [];
  for (const file of sortedUnique(requested)) {
    const nodes = store.symbolsInFiles([file]);
    if (nodes.length === 0) {
      unheld.push(file);
      continue;
    }
    const targets = store.outgoingEdges(nodes.map((node) => node.id)).filter((edge) => edge.kind === IMPORT).map((edge) => edge.target);
    const imported = store.symbolsByIds(sortedUniqueIds(targets)).map((symbol) => symbol.file);
    files.push({
      file,
      declarations: nodes
        .filter((node) => !NOT_A_DECLARATION.includes(node.kind))
        .map((node) => ({ kind: node.kind, name: node.name, line: node.startLine, endLine: node.endLine }))
        .toSorted((a, b) => a.line - b.line || compareText(a.name, b.name)),
      imports: sortedUnique(imported.filter((other) => other !== file)),
    });
  }
  return { files, unheld };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted(compareText);
}

function sortedUniqueIds<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
