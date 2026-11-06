import { NOT_DECLARED_KINDS, sortedUnique } from "../../domain/impact/importers-fact.ts";
import type { OutlineDeclaration, OutlineFile, OutlineValue } from "../../domain/outline/outline-fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";

const IMPORT = "imports";
const CONTAINMENT = "contains";

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
    const edges = store.outgoingEdges(nodes.map((node) => node.id), [IMPORT, CONTAINMENT]);
    const targets = edges.filter((edge) => edge.kind === IMPORT).map((edge) => edge.target);
    const imported = store.symbolsByIds([...new Set(targets)]).map((symbol) => symbol.file);
    const declared = nodes.filter((node) => !NOT_DECLARED_KINDS.includes(node.kind));
    const containers = new Map(declared.map((node) => [node.id, node]));
    const children = new Map<GraphNodeId, GraphSymbol[]>();
    const placed = new Set<GraphNodeId>();
    for (const edge of edges) {
      const container = containers.get(edge.source);
      const member = containers.get(edge.target);
      if (edge.kind !== CONTAINMENT || container === undefined || member === undefined || placed.has(member.id)) continue;
      placed.add(member.id);
      children.set(container.id, [...(children.get(container.id) ?? []), member]);
    }
    const outlined = (members: readonly GraphSymbol[]): OutlineDeclaration[] =>
      members
        .map((node): OutlineDeclaration => {
          const nested = outlined(children.get(node.id) ?? []);
          return { kind: node.kind, name: node.name, line: node.startLine, endLine: node.endLine, ...(nested.length > 0 && { children: nested }) };
        })
        .toSorted((a, b) => a.line - b.line || compareText(a.name, b.name));
    files.push({
      file,
      declarations: outlined(declared.filter((node) => !placed.has(node.id))),
      imports: sortedUnique(imported.filter((other) => other !== file)),
    });
  }
  return { files, unheld };
}
