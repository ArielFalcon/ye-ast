import { EDGE_POLICY } from "../../domain/impact/edge-policy.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOrigins, MethodPlace } from "../../ports/import-origins.port.ts";
import { createGraphNavigation, isInside, SUPERTYPE_EDGES } from "./graph-navigation.ts";

/** A supertype written with type arguments that the index left unresolved and the language pack did not place. */
export interface UnplacedSupertype {
  type: GraphSymbol;
  reference: GraphUnresolvedReference;
}

/** The reading's reader with the hierarchy the index leaves out, and the supertypes neither places. */
export interface CompletedHierarchy {
  reader: CodeGraphReader;
  unplaced: readonly UnplacedSupertype[];
}

/** Whether the index kept the reference's type arguments in its name, so it never resolved the type it names. */
const writesTypeArguments = (reference: GraphUnresolvedReference): boolean => SUPERTYPE_EDGES.includes(reference.kind) && reference.name.includes("<");

const writtenName = (reference: GraphUnresolvedReference): string => reference.name.slice(0, reference.name.indexOf("<")).replace(/\s+/g, "");

const referenceKey = (reference: GraphUnresolvedReference): string => JSON.stringify([reference.from, reference.kind, reference.line, reference.column, reference.name]);

/** The one type of the name the index places between a declaration's first token and its name. */
function typePlacedAt(store: CodeGraphReader, place: MethodPlace & { name: string }): GraphSymbol | undefined {
  const found = store.symbolsInFiles([place.file]).filter((symbol) => symbol.name === place.name && (EDGE_POLICY.ownerKinds as readonly string[]).includes(symbol.kind) && place.start <= symbol.startLine && symbol.startLine <= place.nameLine);
  return found.length === 1 ? found[0] : undefined;
}

function compareIncoming(a: GraphEdge, b: GraphEdge): number {
  return compareText(a.target, b.target) || compareText(a.kind, b.kind) || (a.line ?? -1) - (b.line ?? -1) || (a.column ?? -1) - (b.column ?? -1) || compareText(a.source, b.source);
}

function compareOutgoing(a: GraphEdge, b: GraphEdge): number {
  return compareText(a.source, b.source) || compareText(a.kind, b.kind) || (a.line ?? -1) - (b.line ?? -1) || (a.column ?? -1) - (b.column ?? -1) || compareText(a.target, b.target);
}

/**
 * The hierarchy of a reading completed by the language pack's placement of each supertype the index left unresolved for
 * its type arguments (`files` are those whose pack answers `declaredSupertypes`): one `extends` or `implements` edge per
 * placed supertype, at the reference's place, and the reference no longer unresolved. Without such a reference the
 * reader is `store` itself. A supertype the pack proves outside the repository stays as the index left it.
 */
export async function completedHierarchy(store: CodeGraphReader, files: readonly string[], origins: ImportOrigins | undefined, signal?: AbortSignal): Promise<CompletedHierarchy> {
  const references = files.length === 0 || origins?.declaredSupertypes === undefined ? [] : store.unresolvedReferences(files).filter(writesTypeArguments);
  if (references.length === 0 || origins?.declaredSupertypes === undefined) return { reader: store, unplaced: [] };
  const types = store.symbolsByIds([...new Set(references.map(({ from }) => from))]);
  const answers = await origins.declaredSupertypes(types.map((type) => ({ file: type.file, line: type.startLine, name: type.name })), signal);
  const declared = new Map(types.map((type, index) => [type.id, { type, answer: answers[index] }]));
  const edges: GraphEdge[] = [];
  const placed = new Set<string>();
  const unplaced: UnplacedSupertype[] = [];
  for (const reference of references) {
    const found = declared.get(reference.from);
    if (found === undefined) continue;
    const { type, answer } = found;
    if (answer?.kind === "unknown" && answer.reason !== undefined) continue;
    const entries = answer?.kind === "supertypes" ? answer.supertypes.filter(({ relation, written }) => relation === reference.kind && written === writtenName(reference)) : [];
    const entry = entries.length === 1 ? entries[0]! : undefined;
    if (entry?.kind === "outside") continue;
    const target = entry?.kind === "placed" ? typePlacedAt(store, entry) : undefined;
    if (target === undefined) {
      unplaced.push({ type, reference });
      continue;
    }
    placed.add(referenceKey(reference));
    edges.push({ source: type.id, target: target.id, kind: reference.kind, line: reference.line, column: reference.column, confidence: null, provenance: null, synthesizedBy: null, resolvedFrom: null });
  }
  return { reader: edges.length === 0 ? store : withEdges(store, edges, placed), unplaced };
}

function withEdges(store: CodeGraphReader, edges: readonly GraphEdge[], placed: ReadonlySet<string>): CodeGraphReader {
  const bySource = Map.groupBy(edges, ({ source }) => source);
  const byTarget = Map.groupBy(edges, ({ target }) => target);
  const added = (index: ReadonlyMap<GraphNodeId, readonly GraphEdge[]>, ids: readonly GraphNodeId[], kinds: readonly string[] | undefined): GraphEdge[] =>
    [...new Set(ids)].flatMap((id) => index.get(id) ?? []).filter(({ kind }) => kinds === undefined || kinds.includes(kind));
  const merged = (indexed: readonly GraphEdge[], extra: readonly GraphEdge[], compare: (a: GraphEdge, b: GraphEdge) => number): readonly GraphEdge[] => (extra.length === 0 ? indexed : [...indexed, ...extra].sort(compare));
  return {
    versions: store.versions,
    symbolsInFiles: (files) => store.symbolsInFiles(files),
    symbolsByIds: (ids) => store.symbolsByIds(ids),
    declarationsNamed: (names) => store.declarationsNamed(names),
    incomingEdges: (targets, kinds) => merged(store.incomingEdges(targets, kinds), added(byTarget, targets, kinds), compareIncoming),
    outgoingEdges: (sources, kinds) => merged(store.outgoingEdges(sources, kinds), added(bySource, sources, kinds), compareOutgoing),
    unresolvedReferences: (files) => store.unresolvedReferences(files).filter((reference) => !placed.has(referenceKey(reference))),
    close: () => store.close(),
  };
}

/**
 * The unplaced supertypes of the types an answer reached: those whose type, or a type below it in the completed
 * hierarchy, holds one of `reached`, since what such a type inherits may hide a dependent of it.
 */
export function unplacedReached(hierarchy: CompletedHierarchy, reached: readonly GraphSymbol[]): readonly UnplacedSupertype[] {
  if (hierarchy.unplaced.length === 0 || reached.length === 0) return [];
  const navigation = createGraphNavigation(hierarchy.reader, () => false);
  return hierarchy.unplaced.filter(({ type }) => [type, ...navigation.typesAround(type, "down").map(({ type: below }) => below)].some((holder) => reached.some((declaration) => isInside(declaration, holder))));
}
