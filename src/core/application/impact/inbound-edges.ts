import { topLevelOf, isSeedable } from "../../domain/change/seeds.ts";
import { declarationAnchor, placeAt, resolvedUseKey } from "../../domain/impact/impact-cuts.ts";
import { CALL_EDGE_KINDS, EDGE_POLICY, edgeConfidence, FOLLOWED_EDGE_KINDS, followsEdge, followsRelation, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import type { Relation, SymbolRef } from "../../domain/relations/relation.ts";
import { comparePosition, joinsFact } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";

/**
 * A symbol that depends on another, and how sure the store is of the dependence: 0 to 1. `bridge` says the dependence
 * is dispatch between a method and the same-named method of a type above (`up`) or below (`down`) its own.
 */
export interface InboundEdge {
  from: GraphSymbol;
  confidence: number;
  bridge?: "up" | "down";
  /** Whether a call or an instantiation is among the edges that make the symbol a caller. */
  callLike: boolean;
}

/**
 * What depends on a symbol under the edge policy: the edges codegraph holds that a row allows, the interface bridges
 * and the Angular relations ye-ast derives, and the importers' top-level code. Every list is in position order and names a symbol once.
 */
export interface InboundEdges {
  /**
   * The symbols that depend on `node`. Dispatch runs up from an implementation to the methods it implements for every
   * node, and down to the methods that implement a method only with `contractChanged`: a changed declaration changes
   * what its implementations must meet, a reached caller does not, and a path that went up never comes back down to a
   * sibling. `throughMember` marks the type that declares a reached member: it follows only the whole-type rows of
   * `EDGE_POLICY.ownerThroughMember`, so whoever uses or injects the type does not join through its member.
   */
  callersOf(node: GraphSymbol, contractChanged: boolean, throughMember?: boolean): readonly InboundEdge[];
  /** The type that declares a method, which a reached method stands for at the same depth; none for any other symbol. */
  ownersOf(node: GraphSymbol): readonly GraphSymbol[];
  /** The unresolved references `callersOf` read as uses of a member through an injection, by `resolvedUseKey`. */
  resolvedUses(): ReadonlySet<string>;
}

const SUPERTYPE_EDGES = ["extends", "implements"];
const USAGE_EDGES = ["calls", "instantiates", "references"];

export function createInboundEdges(reader: CodeGraphReader, isTestFile: (path: string) => boolean, relations: readonly Relation[]): InboundEdges {
  const relationsByTargetFile = Map.groupBy(relations, (candidate) => candidate.to.path);
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
    if (node.kind !== "method") return [];
    let owners = ownersCache.get(node.id);
    if (owners === undefined) {
      const edges = reader.incomingEdges([node.id], ["contains"]);
      load(edges.map((edge) => edge.source));
      owners = edges.map((edge) => symbolOf(edge.source)).filter((symbol): symbol is GraphSymbol => symbol !== undefined && isOwner(symbol));
      ownersCache.set(node.id, owners);
    }
    return owners;
  }

  interface Into {
    edge: GraphEdge;
    source: GraphSymbol;
  }
  const intoCache = new Map<GraphNodeId, Into[]>();
  function followedEdgesInto(target: GraphSymbol): Into[] {
    let into = intoCache.get(target.id);
    if (into === undefined) {
      const edges = reader.incomingEdges([target.id], FOLLOWED_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge));
      load(edges.map((edge) => edge.source));
      into = edges.flatMap((edge) => {
        const source = symbolOf(edge.source);
        return source === undefined || source.id === target.id ? [] : [{ edge, source }];
      });
      intoCache.set(target.id, into);
    }
    return into;
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

  function bridgesOf(method: GraphSymbol, contractChanged: boolean): InboundEdge[] {
    const directions = contractChanged ? (["up", "down"] as const) : (["up"] as const);
    return ownersOf(method).flatMap((owner) =>
      directions.flatMap((bridge) =>
        typesAround(owner, bridge).flatMap(({ type, confidence }) =>
          methodsOf(type)
            .filter((candidate) => candidate.name === method.name)
            .map((from) => ({ from, confidence, bridge, callLike: false })),
        ),
      ),
    );
  }

  const topLevelCache = new Map<string, GraphSymbol[]>();
  function topLevelCodeOf(file: string): GraphSymbol[] {
    let code = topLevelCache.get(file);
    if (code === undefined) {
      code = topLevelOf(reader.symbolsInFiles([file]).filter(isSeedable)).filter((symbol) => (EDGE_POLICY.topLevelCodeKinds as readonly string[]).includes(symbol.kind));
      topLevelCache.set(file, code);
    }
    return code;
  }

  /** The top-level code of the files whose own top-level statements use the node, or that import a node nothing else uses. */
  function importersOf(node: GraphSymbol, otherwiseUnused: boolean): InboundEdge[] {
    const users = followedEdgesInto(node).filter(({ edge, source }) => source.kind === "file" && USAGE_EDGES.includes(edge.kind));
    const importing: { file: string; confidence: number }[] = users.map(({ edge, source }) => ({ file: source.file, confidence: edgeConfidence(edge) }));
    if (users.length === 0 && otherwiseUnused && (EDGE_POLICY.injectableKinds as readonly string[]).includes(node.kind)) {
      const imports = reader.incomingEdges([node.id], ["imports"]);
      load(imports.map((edge) => edge.source));
      for (const edge of imports) {
        const source = symbolOf(edge.source);
        if (source?.kind === "file") importing.push({ file: source.file, confidence: edgeConfidence(edge) });
      }
    }
    return importing.filter(({ file }) => !isTestFile(file)).flatMap(({ file, confidence }) => topLevelCodeOf(file).map((from) => ({ from, confidence, callLike: false })));
  }

  const symbolsCache = new Map<string, GraphSymbol[]>();
  const declarationAt = ({ path, symbol, line }: SymbolRef): GraphSymbol | undefined => {
    let inFile = symbolsCache.get(path);
    if (inFile === undefined) {
      inFile = reader.symbolsInFiles([path]).filter((candidate) => (EDGE_POLICY.relations.from as readonly string[]).includes(candidate.kind));
      symbolsCache.set(path, inFile);
    }
    return inFile.find((candidate) => joinsFact(candidate, { path, line, symbol }));
  };

  /** The classes whose injection or template use of `node` ye-ast read from the sources, only of `kinds` when given. */
  function relatedTo(node: GraphSymbol, kinds?: readonly string[]): InboundEdge[] {
    return (relationsByTargetFile.get(node.file) ?? [])
      .filter((candidate) => (kinds === undefined || kinds.includes(candidate.kind)) && joinsFact(node, { path: candidate.to.path, line: candidate.to.line, symbol: candidate.to.symbol }))
      .flatMap((candidate) => {
        const from = declarationAt(candidate.from);
        return from === undefined || isTestFile(from.file) || !followsRelation({ kind: candidate.kind, sourceKind: from.kind, targetKind: node.kind })
          ? []
          : [{ from, confidence: EDGE_POLICY.relations.confidence, callLike: false }];
      });
  }

  const referencesCache = new Map<string, readonly GraphUnresolvedReference[]>();
  function referencesIn(file: string): readonly GraphUnresolvedReference[] {
    let references = referencesCache.get(file);
    if (references === undefined) {
      references = reader.unresolvedReferences([file]);
      referencesCache.set(file, references);
    }
    return references;
  }

  const resolvedUses = new Set<string>();
  /** The members of a class injecting the type that declares `node` which use `node` through the injection's binding. */
  function injectedUsesOf(node: GraphSymbol): InboundEdge[] {
    const anchor = declarationAnchor(node.file, node.name);
    return ownersOf(node).flatMap((owner) =>
      (relationsByTargetFile.get(owner.file) ?? [])
        .filter((candidate) => candidate.kind === "injects" && candidate.binding !== undefined && joinsFact(owner, { path: candidate.to.path, line: candidate.to.line, symbol: candidate.to.symbol }))
        .flatMap((candidate) => {
          const injector = declarationAt(candidate.from);
          if (injector === undefined || isTestFile(injector.file)) return [];
          const names = [`this.${candidate.binding}.${node.name}`, `${candidate.binding}.${node.name}`];
          const uses = referencesIn(injector.file).filter((reference) => names.includes(reference.name) && (EDGE_POLICY.injectedMemberUses as readonly string[]).includes(reference.kind));
          load(uses.map((use) => use.from));
          return uses.flatMap((use): InboundEdge[] => {
            const from = symbolOf(use.from);
            if (from === undefined || from.file !== injector.file || from.startLine < injector.startLine || from.endLine > injector.endLine) return [];
            resolvedUses.add(resolvedUseKey(anchor, placeAt(use.file, use.line)));
            return [{ from, confidence: EDGE_POLICY.relations.confidence, callLike: use.kind === "calls" }];
          });
        }),
    );
  }

  const callersCache = new Map<string, InboundEdge[]>();
  function callersOf(node: GraphSymbol, contractChanged: boolean, throughMember = false): InboundEdge[] {
    const key = `${node.id}:${contractChanged}:${throughMember}`;
    let callers = callersCache.get(key);
    if (callers === undefined) {
      const followed = followedEdgesInto(node).filter(({ edge, source }) => !isTestFile(source.file) && followsEdge({ kind: edge.kind, sourceKind: source.kind, targetKind: node.kind }));
      const into = throughMember ? followed.filter(({ edge }) => (EDGE_POLICY.ownerThroughMember.edges as readonly string[]).includes(edge.kind)) : followed;
      const direct = into.map(({ edge, source }) => ({ from: source, confidence: edgeConfidence(edge), callLike: CALL_EDGE_KINDS.includes(edge.kind) }));
      const bridged = throughMember ? direct : [...direct, ...bridgesOf(node, contractChanged), ...injectedUsesOf(node)];
      const found = [...bridged, ...relatedTo(node, throughMember ? EDGE_POLICY.ownerThroughMember.relations : undefined)];
      const whole = throughMember ? found : [...found, ...importersOf(node, found.length === 0)];
      callers = strongestPerSymbol(whole.filter(({ from }) => from.id !== node.id)).sort((a, b) => comparePosition(a.from, b.from));
      callersCache.set(key, callers);
    }
    return callers;
  }

  return { callersOf, ownersOf, resolvedUses: () => resolvedUses };
}

function strongestPerSymbol(edges: readonly InboundEdge[]): InboundEdge[] {
  const strongest = new Map<GraphNodeId, InboundEdge>();
  for (const edge of edges) {
    const held = strongest.get(edge.from.id);
    const callLike = edge.callLike || (held?.callLike ?? false);
    strongest.set(edge.from.id, held === undefined || edge.confidence > held.confidence ? { ...edge, callLike } : { ...held, callLike });
  }
  return [...strongest.values()];
}
