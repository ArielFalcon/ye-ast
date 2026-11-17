import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference, StoreVersions } from "../../ports/code-graph.port.ts";

/** What a bulk read needs of a SQLite connection: the SDK's read-only connection answers it. */
export interface StoreRows {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: GraphEdge["provenance"];
}

interface ReferenceRow {
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  file_path: string | null;
  line: number;
  col: number;
  candidates: string | null;
}

/**
 * The raw-SQL remainder (RFC-0003, ADR-0124): one read transaction over the three tables the reader answers from, in
 * row order, so rows that the port's orders leave tied keep the order the store's own lookups return them in.
 */
const NODES = "SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column FROM nodes";
const EDGES = "SELECT source, target, kind, metadata, line, col, provenance FROM edges ORDER BY id";
const REFERENCES = "SELECT from_node_id, reference_name, reference_kind, file_path, line, col, candidates FROM unresolved_refs ORDER BY id";

/** A store's graph read once and kept frozen: every list is already in the order the port promises. */
export interface GraphImage {
  readonly versions: StoreVersions;
  /** The UTF-16 bytes of the text and eight bytes per number the image holds: the charge its keeper counts. */
  readonly bytes: number;
  reader(): CodeGraphReader;
}

export function readGraphImage(store: StoreRows, versions: StoreVersions): GraphImage {
  store.exec("BEGIN");
  let rows: { nodes: NodeRow[]; edges: EdgeRow[]; references: ReferenceRow[] };
  try {
    rows = { nodes: store.prepare(NODES).all() as NodeRow[], edges: store.prepare(EDGES).all() as EdgeRow[], references: store.prepare(REFERENCES).all() as ReferenceRow[] };
  } finally {
    store.exec("COMMIT");
  }
  return imageOf(rows.nodes, rows.edges, rows.references, versions);
}

function imageOf(nodeRows: readonly NodeRow[], edgeRows: readonly EdgeRow[], referenceRows: readonly ReferenceRow[], versions: StoreVersions): GraphImage {
  let bytes = 0;
  const symbols = new Map<string, GraphSymbol>();
  const byFile = new Map<string, GraphSymbol[]>();
  const byName = new Map<string, GraphSymbol[]>();
  for (const row of nodeRows) {
    const symbol = Object.freeze(symbolOf(row));
    bytes += textBytes(symbol.id, symbol.kind, symbol.name, symbol.qualifiedName, symbol.file, symbol.language) + 4 * NUMBER_BYTES;
    symbols.set(symbol.id, symbol);
    group(byFile, symbol.file, symbol);
    group(byName, symbol.name, symbol);
  }
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const row of edgeRows) {
    const edge = edgeOf(row);
    bytes += textBytes(edge.source, edge.target, edge.kind, edge.provenance ?? "", edge.synthesizedBy ?? "", edge.resolvedFrom?.name ?? "", edge.resolvedFrom?.kind ?? "") + 3 * NUMBER_BYTES;
    group(outgoing, edge.source, edge);
    group(incoming, edge.target, edge);
  }
  const references = new Map<string, GraphUnresolvedReference[]>();
  for (const row of referenceRows) {
    const reference = referenceOf(row);
    bytes += textBytes(reference.from, reference.name, reference.kind, reference.file, row.candidates ?? "") + 2 * NUMBER_BYTES;
    group(references, reference.file, reference);
  }
  const files = sortedGroups(byFile, compareSymbols);
  const names = sortedGroups(byName, compareSymbols);
  const sources = sortedGroups(outgoing, compareOutgoingEdges);
  const targets = sortedGroups(incoming, compareEdges);
  const referencesByFile = sortedGroups(references, compareReferences);

  const edgesOf = (groups: ReadonlyMap<string, readonly GraphEdge[]>, ids: readonly GraphNodeId[], kinds: readonly string[] | undefined): readonly GraphEdge[] => {
    if (kinds?.length === 0) return [];
    const edges = inKeyOrder(groups, ids);
    if (kinds === undefined) return edges;
    const wanted = new Set(kinds);
    return edges.filter((edge) => wanted.has(edge.kind));
  };
  const reader = (): CodeGraphReader => ({
    versions,
    symbolsInFiles: (paths) => inKeyOrder(files, paths),
    symbolsByIds: (ids) => unique(ids).flatMap((id) => symbols.get(id) ?? []).sort(compareSymbols),
    declarationsNamed: (wanted) => unique(wanted).flatMap((name) => names.get(name) ?? []).sort(compareSymbols),
    incomingEdges: (ids, kinds) => edgesOf(targets, ids, kinds),
    outgoingEdges: (ids, kinds) => edgesOf(sources, ids, kinds),
    unresolvedReferences: (paths) => inKeyOrder(referencesByFile, paths),
    close: () => undefined,
  });
  return Object.freeze({ versions, bytes, reader });
}

/** The images a process keeps, by the identity of the store they were read from, least recently used first out. */
export interface GraphImages {
  /**
   * The image kept under `key`, or the one `load` reads, kept when it fits the budget; a `load` that throws keeps nothing.
   * A `slot` holds one image: one obtained under another key drops the image the slot held, so a store written in place
   * keeps only its last generation.
   */
  obtain(key: string, load: () => GraphImage, slot?: string): GraphImage;
}

export function keptGraphImages(maxBytes: number): GraphImages {
  const kept = new Map<string, { key: string; image: GraphImage }>();
  let held = 0;
  return {
    obtain(key, load, slot = key) {
      const found = kept.get(slot);
      if (found !== undefined) {
        kept.delete(slot);
        if (found.key === key) {
          kept.set(slot, found);
          return found.image;
        }
        held -= found.image.bytes;
      }
      const image = load();
      if (image.bytes > maxBytes) return image;
      kept.set(slot, { key, image });
      held += image.bytes;
      for (const [oldest, { image: { bytes } }] of kept) {
        if (held <= maxBytes) break;
        kept.delete(oldest);
        held -= bytes;
      }
      return image;
    },
  };
}

const NUMBER_BYTES = 8;

function textBytes(...texts: readonly string[]): number {
  let length = 0;
  for (const text of texts) length += text.length;
  return 2 * length;
}

function group<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const members = groups.get(key);
  if (members === undefined) groups.set(key, [value]);
  else members.push(value);
}

function sortedGroups<T>(groups: Map<string, T[]>, compare: (a: T, b: T) => number): ReadonlyMap<string, readonly T[]> {
  for (const members of groups.values()) Object.freeze(members.sort(compare));
  return groups;
}

/** The groups of `keys` one after the other, the keys in text order: the order of every port list whose first key is the group's. */
function inKeyOrder<T>(groups: ReadonlyMap<string, readonly T[]>, keys: readonly string[]): T[] {
  return unique(keys)
    .sort(compareText)
    .flatMap((key) => groups.get(key) ?? []);
}

function symbolOf(row: NodeRow): GraphSymbol {
  return {
    id: row.id as GraphNodeId,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    file: row.file_path,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
  };
}

/** The SDK's own reading of an edge row: metadata that is not JSON reads as none, and a missing position as `null`. */
function edgeOf(row: EdgeRow): GraphEdge {
  return Object.freeze(
    edgeFrom({
      source: row.source,
      target: row.target,
      kind: row.kind,
      metadata: row.metadata ? parsedOr(row.metadata, undefined) : undefined,
      line: row.line ?? undefined,
      column: row.col ?? undefined,
      provenance: row.provenance,
    }),
  );
}

function referenceOf(row: ReferenceRow): GraphUnresolvedReference {
  const candidates = row.candidates ? parsedOr<string[] | undefined>(row.candidates, undefined) : undefined;
  return Object.freeze({
    from: row.from_node_id as GraphNodeId,
    name: row.reference_name,
    kind: row.reference_kind,
    file: row.file_path ?? "",
    line: row.line,
    column: row.col,
    candidates: Object.freeze(candidates ?? []),
  });
}

function parsedOr<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** An edge as the SDK hands it over, with its metadata parsed. */
export interface SdkEdge {
  source: string;
  target: string;
  kind: string;
  metadata?: Record<string, unknown> | undefined;
  line?: number | undefined;
  column?: number | undefined;
  provenance?: GraphEdge["provenance"] | undefined;
}

export function edgeFrom(edge: SdkEdge): GraphEdge {
  const { confidence, synthesizedBy, refName, refKind } = edge.metadata ?? {};
  return {
    source: edge.source as GraphNodeId,
    target: edge.target as GraphNodeId,
    kind: edge.kind,
    line: edge.line ?? null,
    column: edge.column ?? null,
    confidence: typeof confidence === "number" ? confidence : null,
    provenance: edge.provenance ?? null,
    synthesizedBy: typeof synthesizedBy === "string" ? synthesizedBy : null,
    resolvedFrom: typeof refName === "string" && typeof refKind === "string" && refKind !== edge.kind ? Object.freeze({ name: refName, kind: refKind }) : null,
  };
}

export function compareSymbols(a: GraphSymbol, b: GraphSymbol): number {
  return compareText(a.file, b.file) || a.startLine - b.startLine || a.endLine - b.endLine || compareText(a.qualifiedName, b.qualifiedName) || compareText(a.id, b.id);
}

export function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    compareText(a.target, b.target) ||
    compareText(a.kind, b.kind) ||
    (a.line ?? -1) - (b.line ?? -1) ||
    (a.column ?? -1) - (b.column ?? -1) ||
    compareText(a.source, b.source)
  );
}

export function compareOutgoingEdges(a: GraphEdge, b: GraphEdge): number {
  return compareText(a.source, b.source) || compareText(a.kind, b.kind) || (a.line ?? -1) - (b.line ?? -1) || (a.column ?? -1) - (b.column ?? -1) || compareText(a.target, b.target);
}

export function compareReferences(a: GraphUnresolvedReference, b: GraphUnresolvedReference): number {
  return compareText(a.file, b.file) || a.line - b.line || a.column - b.column || compareText(a.name, b.name) || compareText(a.kind, b.kind) || compareText(a.from, b.from);
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
