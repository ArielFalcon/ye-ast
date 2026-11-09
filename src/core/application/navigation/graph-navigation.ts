import { EDGE_POLICY, edgeConfidence, LOCAL_OWNER_KINDS } from "../../domain/impact/edge-policy.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { SymbolRef } from "../../domain/relations/relation.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";

export const SUPERTYPE_EDGES = ["extends", "implements"];

/** The origin that holds a receiver at a use: the one whose owner declares the use, `ambiguous` when several do. */
export type HeldOrigin<O> = { origin: O } | "ambiguous" | "none";

/** Moves through one store in either direction; every read is cached for the life of the instance, one query. */
export interface GraphNavigation {
  /** Reads the symbols `ids` name that are not known yet, so `symbolOf` answers for them. */
  load(ids: readonly GraphNodeId[]): void;
  /** A symbol `load` read; undefined for an id the store does not know or one not loaded. */
  symbolOf(id: GraphNodeId): GraphSymbol | undefined;
  /** The non-test types that declare a member; none for any other symbol. */
  ownersOf(node: GraphSymbol): GraphSymbol[];
  /** The non-test types above (`up`) or below (`down`) a type, each with the weakest confidence on its way. */
  typesAround(type: GraphSymbol, direction: "up" | "down"): { type: GraphSymbol; confidence: number }[];
  methodsOf(type: GraphSymbol): GraphSymbol[];
  /** The edges by which `type` extends or implements another, test files included, each target loaded. */
  supertypeEdgesOf(type: GraphSymbol): readonly GraphEdge[];
  /** The declarations a contains edge places directly inside `type`, in the store's order. */
  membersOf(type: GraphSymbol): readonly GraphSymbol[];
  symbolsInFile(path: string): readonly GraphSymbol[];
  /** The declaration of `kinds` a reference names in its file. */
  declarationAt(ref: SymbolRef, kinds?: readonly string[]): GraphSymbol | undefined;
  /** The file's unresolved member uses by the name they use up to its first member: `this.svc.get` and `this.svc` under `this.svc`. */
  referencesThrough(file: string, receiver: string): readonly GraphUnresolvedReference[];
  /** The field origin `this.<field>` holds in the code of `user`: of the classes that declare the field, the one around `user`. */
  fieldOriginAt(user: GraphSymbol, field: string, fields: readonly FieldOrigin[]): HeldOrigin<FieldOrigin>;
  /** The origin a local `inject()` took holds in the code of `user`: of the declarations that take the local, the one around `user`. */
  localOriginAt(user: GraphSymbol, local: string, locals: readonly LocalOrigin[]): HeldOrigin<LocalOrigin>;
}

/** The one declaration of `kinds` the index places between a declaration's first token and its name, in `store`. */
export function placedBetween(store: CodeGraphReader, file: string, start: number, nameLine: number, kinds: readonly string[]): GraphSymbol | undefined {
  const found = store.symbolsInFiles([file]).filter((symbol) => kinds.includes(symbol.kind) && start <= symbol.startLine && symbol.startLine <= nameLine);
  return found.length === 1 ? found[0] : undefined;
}

/** Whether `inner` is declared within the lines of `outer`, in the same file. */
export function isInside(inner: GraphSymbol, outer: GraphSymbol): boolean {
  return inner.file === outer.file && outer.startLine <= inner.startLine && inner.endLine <= outer.endLine;
}

/** The members named `member` of the declarations that own `node`, of `kinds`, once each. */
export function ownMembersOf(navigation: GraphNavigation, node: GraphSymbol, member: string, kinds: readonly string[]): GraphSymbol[] {
  const members = navigation.ownersOf(node).flatMap((owner) => navigation.membersOf(owner)).filter((symbol) => symbol.name === member && kinds.includes(symbol.kind));
  return [...new Map(members.map((symbol) => [symbol.id, symbol])).values()];
}

export function createGraphNavigation(reader: CodeGraphReader, isTestFile: (path: string) => boolean): GraphNavigation {
  const known = new Map<GraphNodeId, GraphSymbol | undefined>();
  const load = (ids: readonly GraphNodeId[]): void => {
    const missing = [...new Set(ids)].filter((id) => !known.has(id));
    if (missing.length === 0) return;
    for (const symbol of reader.symbolsByIds(missing)) known.set(symbol.id, symbol);
    for (const id of missing) if (!known.has(id)) known.set(id, undefined);
  };
  const symbolOf = (id: GraphNodeId): GraphSymbol | undefined => known.get(id);
  const isOwner = (symbol: GraphSymbol): boolean => (EDGE_POLICY.ownerKinds as readonly string[]).includes(symbol.kind) && !isTestFile(symbol.file);

  const ownersCache = new Map<GraphNodeId, GraphSymbol[]>();
  function ownersOf(node: GraphSymbol): GraphSymbol[] {
    if (!(EDGE_POLICY.memberKinds as readonly string[]).includes(node.kind)) return [];
    let owners = ownersCache.get(node.id);
    if (owners === undefined) {
      const edges = reader.incomingEdges([node.id], ["contains"]);
      load(edges.map((edge) => edge.source));
      owners = edges.map((edge) => symbolOf(edge.source)).filter((symbol): symbol is GraphSymbol => symbol !== undefined && isOwner(symbol));
      ownersCache.set(node.id, owners);
    }
    return owners;
  }

  function typesAround(type: GraphSymbol, direction: "up" | "down"): { type: GraphSymbol; confidence: number }[] {
    const found = new Map<GraphNodeId, { type: GraphSymbol; confidence: number }>();
    const visited = new Set<GraphNodeId>();
    let frontier = [{ type, confidence: 1 }];
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const current of frontier) {
        const edges = direction === "up" ? reader.outgoingEdges([current.type.id], SUPERTYPE_EDGES) : reader.incomingEdges([current.type.id], SUPERTYPE_EDGES);
        load(edges.map((edge) => (direction === "up" ? edge.target : edge.source)));
        for (const edge of edges) {
          const other = symbolOf(direction === "up" ? edge.target : edge.source);
          if (other === undefined || visited.has(other.id) || !isOwner(other)) continue;
          visited.add(other.id);
          const step = { type: other, confidence: Math.min(current.confidence, edgeConfidence(edge)) };
          found.set(other.id, step);
          next.push(step);
        }
      }
      frontier = next;
    }
    return [...found.values()];
  }

  const membersCache = new Map<GraphNodeId, readonly GraphSymbol[]>();
  function membersOf(type: GraphSymbol): readonly GraphSymbol[] {
    let members = membersCache.get(type.id);
    if (members === undefined) {
      const edges = reader.outgoingEdges([type.id], ["contains"]);
      load(edges.map((edge) => edge.target));
      members = edges.flatMap((edge) => symbolOf(edge.target) ?? []);
      membersCache.set(type.id, members);
    }
    return members;
  }
  const methodsOf = (type: GraphSymbol): GraphSymbol[] => membersOf(type).filter((symbol) => symbol.kind === "method");

  const supertypesCache = new Map<GraphNodeId, readonly GraphEdge[]>();
  function supertypeEdgesOf(type: GraphSymbol): readonly GraphEdge[] {
    let edges = supertypesCache.get(type.id);
    if (edges === undefined) {
      edges = reader.outgoingEdges([type.id], SUPERTYPE_EDGES);
      load(edges.map((edge) => edge.target));
      supertypesCache.set(type.id, edges);
    }
    return edges;
  }

  const symbolsCache = new Map<string, readonly GraphSymbol[]>();
  function symbolsInFile(path: string): readonly GraphSymbol[] {
    let inFile = symbolsCache.get(path);
    if (inFile === undefined) {
      inFile = reader.symbolsInFiles([path]);
      symbolsCache.set(path, inFile);
    }
    return inFile;
  }
  const declarationAt = (ref: SymbolRef, kinds: readonly string[] = EDGE_POLICY.relations.from): GraphSymbol | undefined =>
    symbolsInFile(ref.path).find((candidate) => kinds.includes(candidate.kind) && joinsFact(candidate, ref));

  const referencesCache = new Map<string, ReadonlyMap<string, readonly GraphUnresolvedReference[]>>();
  function referencesThrough(file: string, receiver: string): readonly GraphUnresolvedReference[] {
    let byReceiver = referencesCache.get(file);
    if (byReceiver === undefined) {
      byReceiver = Map.groupBy(
        reader.unresolvedReferences([file]).filter((reference) => (EDGE_POLICY.fieldMemberUses as readonly string[]).includes(reference.kind)),
        (reference) => reference.name.split(".").slice(0, 2).join("."),
      );
      referencesCache.set(file, byReceiver);
    }
    return byReceiver.get(receiver) ?? [];
  }

  function enclosingOrigin<O extends { owner: SymbolRef }>(user: GraphSymbol, named: readonly O[], kinds: readonly string[]): HeldOrigin<O> {
    const around = named.filter((origin) => {
      const owner = declarationAt(origin.owner, kinds);
      return owner !== undefined && isInside(user, owner);
    });
    return around.length === 0 ? "none" : around.length === 1 ? { origin: around[0]! } : "ambiguous";
  }
  const fieldOriginAt = (user: GraphSymbol, field: string, fields: readonly FieldOrigin[]) => enclosingOrigin(user, fields.filter((origin) => origin.field === field), EDGE_POLICY.relations.from);
  const localOriginAt = (user: GraphSymbol, local: string, locals: readonly LocalOrigin[]) => enclosingOrigin(user, locals.filter((origin) => origin.local === local), LOCAL_OWNER_KINDS);

  return { load, symbolOf, ownersOf, typesAround, methodsOf, supertypeEdgesOf, membersOf, symbolsInFile, declarationAt, referencesThrough, fieldOriginAt, localOriginAt };
}
