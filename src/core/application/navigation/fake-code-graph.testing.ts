import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";

export interface FakeNode {
  id: string;
  kind: string;
  name?: string;
  file: string;
  start: number;
  end: number;
}

export interface FakeEdge {
  from: string;
  to: string;
  kind: string;
  /** The place inside `from` where the dependence happens; absent stands for a store entry with no position. */
  line?: number;
  /** 0-based, as codegraph writes it. */
  column?: number;
  confidence?: number | null;
  provenance?: GraphEdge["provenance"];
  synthesizedBy?: string | null;
}

export interface FakeUnresolved {
  from: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  column?: number;
  candidates?: readonly string[];
}

const handle = (id: string): GraphNodeId => id as GraphNodeId;

export function fakeNode(id: string, kind: string, file: string, start: number, end = start, name = id): FakeNode {
  return { id, kind, name, file, start, end };
}

/** An in-memory code graph; every list comes back in the order the store promises. */
export function fakeCodeGraph(nodes: readonly FakeNode[], edges: readonly FakeEdge[], unresolved: readonly FakeUnresolved[] = []): CodeGraphReader {
  const symbols = new Map<string, GraphSymbol>(
    nodes.map((node) => [node.id, { id: handle(node.id), kind: node.kind, name: node.name ?? node.id, qualifiedName: `${node.file}::${node.name ?? node.id}`, file: node.file, language: "java", startLine: node.start, endLine: node.end }]),
  );
  const edge = (e: FakeEdge): GraphEdge => ({
    source: handle(e.from),
    target: handle(e.to),
    kind: e.kind,
    line: e.line ?? null,
    column: e.column ?? null,
    confidence: e.confidence ?? null,
    provenance: e.provenance ?? null,
    synthesizedBy: e.synthesizedBy ?? null,
  });
  const byPosition = (a: GraphSymbol, b: GraphSymbol): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine || (a.id < b.id ? -1 : 1));
  return {
    versions: { codegraph: "fake", schema: 0, extraction: 0 },
    symbolsInFiles: (files) => [...symbols.values()].filter((symbol) => files.includes(symbol.file)).sort(byPosition),
    symbolsByIds: (ids) => ids.flatMap((id) => symbols.get(id) ?? []).sort(byPosition),
    declarationsNamed: (names) => [...symbols.values()].filter((symbol) => names.includes(symbol.name)).sort(byPosition),
    incomingEdges: (targets, kinds) => edges.filter((e) => targets.includes(handle(e.to)) && (kinds === undefined || kinds.includes(e.kind))).map(edge),
    outgoingEdges: (sources, kinds) => edges.filter((e) => sources.includes(handle(e.from)) && (kinds === undefined || kinds.includes(e.kind))).map(edge),
    unresolvedReferences: (files): readonly GraphUnresolvedReference[] =>
      unresolved.filter((u) => files.includes(u.file)).map((u) => ({ from: handle(u.from), name: u.name, kind: u.kind, file: u.file, line: u.line, column: u.column ?? Number.NaN, candidates: u.candidates ?? [] })),
    close: () => undefined,
  };
}
