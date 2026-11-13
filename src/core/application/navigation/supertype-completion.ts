import { EDGE_POLICY } from "../../domain/impact/edge-policy.ts";
import { withoutTypeArguments } from "../../domain/shared/call-place.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOrigins, MethodPlace } from "../../ports/import-origins.port.ts";
import { createGraphNavigation, isInside, SUPERTYPE_EDGES } from "./graph-navigation.ts";

/** A supertype the index left unresolved and the language pack did not place. */
export interface UnplacedSupertype {
  type: GraphSymbol;
  reference: GraphUnresolvedReference;
}

/** The reading's reader with the hierarchy the index leaves out, and the supertypes neither places. */
export interface CompletedHierarchy {
  reader: CodeGraphReader;
  unplaced: readonly UnplacedSupertype[];
}

const isSupertypeReference = (reference: GraphUnresolvedReference): boolean => SUPERTYPE_EDGES.includes(reference.kind);

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

/** The bodied members of `files` that hold a declaration, whose body may be a type of its own. */
function bodiedMembersIn(store: CodeGraphReader, files: readonly string[]): GraphSymbol[] {
  const members = store.symbolsInFiles(files).filter(({ kind }) => (EDGE_POLICY.bodiedMemberKinds as readonly string[]).includes(kind));
  if (members.length === 0) return [];
  const holders = new Set(store.outgoingEdges(members.map(({ id }) => id), ["contains"]).map(({ source }) => source));
  return members.filter(({ id }) => holders.has(id));
}

/**
 * The hierarchy of a reading completed by the language pack's placement of each supertype the index left unresolved
 * (`files` are those whose pack answers `declaredSupertypes`): one `extends` or `implements` edge per
 * placed supertype, at the reference's place, and the reference no longer unresolved. A bodied member that holds a
 * declaration and whose pack places a type it extends reads as a type of `EDGE_POLICY.bodiedMemberType` with an
 * `extends` edge at its own place. Without either the reader is `store` itself. A supertype the pack proves outside the
 * repository stays as the index left it.
 */
export async function completedHierarchy(store: CodeGraphReader, files: readonly string[], origins: ImportOrigins | undefined, signal?: AbortSignal): Promise<CompletedHierarchy> {
  const declaredSupertypes = files.length === 0 ? undefined : origins?.declaredSupertypes;
  if (declaredSupertypes === undefined) return { reader: store, unplaced: [] };
  const references = store.unresolvedReferences(files).filter(isSupertypeReference);
  const bodied = bodiedMembersIn(store, files);
  if (references.length === 0 && bodied.length === 0) return { reader: store, unplaced: [] };
  const types = [...store.symbolsByIds([...new Set(references.map(({ from }) => from))]), ...bodied];
  const answers = await declaredSupertypes(types.map((type) => ({ file: type.file, line: type.startLine, name: type.name })), signal);
  const declared = new Map(types.map((type, index) => [type.id, { type, answer: answers[index] }]));
  const edges: GraphEdge[] = [];
  const placed = new Set<string>();
  const retyped = new Set<GraphNodeId>();
  const unplaced: UnplacedSupertype[] = [];
  const edgeOf = (source: GraphSymbol, target: GraphSymbol, kind: string, line: number, column: number): GraphEdge => ({ source: source.id, target: target.id, kind, line, column, confidence: null, provenance: null, synthesizedBy: null, resolvedFrom: null });
  for (const reference of references) {
    const found = declared.get(reference.from);
    if (found === undefined) continue;
    const { type, answer } = found;
    if (answer?.kind === "unknown" && answer.reason !== undefined) continue;
    const entries = answer?.kind === "supertypes" ? answer.supertypes.filter(({ relation, written }) => relation === reference.kind && written === withoutTypeArguments(reference.name)) : [];
    const entry = entries.length === 1 ? entries[0]! : undefined;
    if (entry?.kind === "outside") continue;
    const target = entry?.kind === "placed" ? typePlacedAt(store, entry) : undefined;
    if (target === undefined) {
      unplaced.push({ type, reference });
      continue;
    }
    placed.add(referenceKey(reference));
    edges.push(edgeOf(type, target, reference.kind, reference.line, reference.column));
  }
  for (const member of bodied) {
    const answer = declared.get(member.id)?.answer;
    if (answer?.kind === "unknown" && answer.reason !== undefined) continue;
    const entries = answer?.kind === "supertypes" ? answer.supertypes : [];
    const target = entries.length === 1 && entries[0]!.relation === "extends" && entries[0]!.kind === "placed" ? typePlacedAt(store, entries[0]!) : undefined;
    const at = { line: member.startLine, column: member.startColumn + 1 };
    if (target === undefined) {
      unplaced.push({ type: member, reference: { from: member.id, name: member.name, kind: "extends", file: member.file, ...at, candidates: [] } });
      continue;
    }
    retyped.add(member.id);
    edges.push(edgeOf(member, target, "extends", at.line, at.column));
  }
  return { reader: edges.length === 0 ? store : withEdges(store, edges, placed, retyped), unplaced };
}

function withEdges(store: CodeGraphReader, edges: readonly GraphEdge[], placed: ReadonlySet<string>, retyped: ReadonlySet<GraphNodeId>): CodeGraphReader {
  const bySource = Map.groupBy(edges, ({ source }) => source);
  const byTarget = Map.groupBy(edges, ({ target }) => target);
  const added = (index: ReadonlyMap<GraphNodeId, readonly GraphEdge[]>, ids: readonly GraphNodeId[], kinds: readonly string[] | undefined): GraphEdge[] =>
    [...new Set(ids)].flatMap((id) => index.get(id) ?? []).filter(({ kind }) => kinds === undefined || kinds.includes(kind));
  const merged = (indexed: readonly GraphEdge[], extra: readonly GraphEdge[], compare: (a: GraphEdge, b: GraphEdge) => number): readonly GraphEdge[] => (extra.length === 0 ? indexed : [...indexed, ...extra].sort(compare));
  const typed = (symbols: readonly GraphSymbol[]): readonly GraphSymbol[] => (retyped.size === 0 ? symbols : symbols.map((symbol) => (retyped.has(symbol.id) ? { ...symbol, kind: EDGE_POLICY.bodiedMemberType } : symbol)));
  return {
    versions: store.versions,
    symbolsInFiles: (files) => typed(store.symbolsInFiles(files)),
    symbolsByIds: (ids) => typed(store.symbolsByIds(ids)),
    declarationsNamed: (names) => typed(store.declarationsNamed(names)),
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
