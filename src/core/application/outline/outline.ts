import { compareText } from "../../domain/shared/code-node.ts";
import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import type { OutlineFile, OutlineValue } from "../../domain/outline/outline-fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";

const IMPORT = "imports";

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
    const targets = store.outgoingEdges(nodes.map((node) => node.id)).filter((edge) => edge.kind === IMPORT).map((edge) => edge.target);
    const imported = store.symbolsByIds(sortedUniqueIds(targets)).map((symbol) => symbol.file);
    files.push({
      file,
      declarations: nodes
        .filter((node) => !NOT_DECLARED_KINDS.includes(node.kind))
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
