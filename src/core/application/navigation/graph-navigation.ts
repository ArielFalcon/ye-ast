import { EDGE_POLICY, edgeConfidence } from "../../domain/impact/edge-policy.ts";
import type { SymbolRef } from "../../domain/relations/relation.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";

export const SUPERTYPE_EDGES = ["extends", "implements"];

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
  symbolsInFile(path: string): readonly GraphSymbol[];
  /** The declaration of `kinds` a reference names in its file. */
  declarationAt(ref: SymbolRef, kinds?: readonly string[]): GraphSymbol | undefined;
  /** The file's unresolved member uses by the name they use up to its first member: `this.svc.get` and `this.svc` under `this.svc`. */
  referencesThrough(file: string, receiver: string): readonly GraphUnresolvedReference[];
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

  const membersCache = new Map<GraphNodeId, GraphSymbol[]>();
  function methodsOf(type: GraphSymbol): GraphSymbol[] {
    let methods = membersCache.get(type.id);
    if (methods === undefined) {
      const edges = reader.outgoingEdges([type.id], ["contains"]);
      load(edges.map((edge) => edge.target));
      methods = edges.map((edge) => symbolOf(edge.target)).filter((symbol): symbol is GraphSymbol => symbol?.kind === "method");
      membersCache.set(type.id, methods);
    }
    return methods;
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

  return { load, symbolOf, ownersOf, typesAround, methodsOf, symbolsInFile, declarationAt, referencesThrough };
}
