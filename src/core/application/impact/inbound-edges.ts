import type { DependenceBasis } from "../../domain/impact/impact-fact.ts";
import { topLevelOf, isSeedable } from "../../domain/change/seeds.ts";
import { declarationAnchor, declarationUseKey, referenceKey, uniqueReferenceKeys, type MemberReferenceProofs } from "../../domain/impact/impact-cuts.ts";
import { CALL_EDGE_KINDS, EDGE_POLICY, edgeConfidence, FOLLOWED_EDGE_KINDS, followsEdge, followsRelation, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import type { MemberSubstitute, MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { Relation, SymbolRef } from "../../domain/relations/relation.ts";
import { comparePosition, compareText, joinsFact } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";

/**
 * A symbol that depends on another, and how sure the store is of the dependence: 0 to 1. `bridge` says the dependence
 * is dispatch between a method and the same-named method of a type above (`up`) or below (`down`) its own.
 */
export interface InboundEdge {
  from: GraphSymbol;
  /** Observed call existence, independent of the selected confidence witness. */
  hasCall?: boolean;
  confidence: number;
  bridge?: "up" | "down";
  /** Locations of the selected confidence and category, in line order; empty when the store places none. */
  lines: readonly number[];
  /** The file `lines` are in when it is not `from`'s own: the template of a component. */
  resource?: string;
  /** The category of the selected evidence; observed call existence is kept separately for fan-in. */
  basis: DependenceBasis;
  /** The classes a provider may inject instead of the receiver a proven member call names. */
  substitutes?: readonly MemberSubstitute[];
}

/** One place a symbol depends on another: what the code does there, not the strongest witness per symbol. */
export interface InboundOccurrence {
  from: GraphSymbol;
  /** The line of the dependence; absent when the store places none. */
  line?: number;
  /** The file `line` is in when it is not `from`'s own: the template of a component. */
  resource?: string;
  basis: DependenceBasis;
  confidence: number;
  /** What the store recorded for the edge; `null` for a dependence ye-ast derived itself and for an edge the store did not mark. */
  provenance: GraphEdge["provenance"];
  bridge?: "up" | "down";
  substitutes?: readonly MemberSubstitute[];
}

/** The dependences on a symbol one by one, which `InboundEdges.callersOf` summarizes per symbol. */
export interface InboundOccurrences {
  /** Every dependence on `node`, one per place and basis, in position order. */
  occurrencesOf(node: GraphSymbol): readonly InboundOccurrence[];
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
  /** Candidate-specific settlements, restricted to admitted expansions and reached sources when sets are supplied. */
  settledUses(expanded?: ReadonlySet<GraphNodeId>, reached?: ReadonlySet<GraphNodeId>): ReadonlySet<string>;
  memberProofs(expanded?: ReadonlySet<GraphNodeId>): MemberReferenceProofs;
  /** Every edge read so far into a symbol, with both ends, before `outside` is applied to it. */
  followed(): readonly FollowedEdge[];
}

export interface FollowedEdge {
  edge: GraphEdge;
  source: GraphSymbol;
  target: GraphSymbol;
}

/** One edge of the store, for naming it in a set; a handle inside one store, never output. */
export function edgeKey({ source, target, kind, line, column }: GraphEdge): string {
  return JSON.stringify([source, target, kind, line, column]);
}

const SUPERTYPE_EDGES = ["extends", "implements"];

function isInside(inner: GraphSymbol, outer: GraphSymbol): boolean {
  return inner.file === outer.file && outer.startLine <= inner.startLine && inner.endLine <= outer.endLine;
}
const USAGE_EDGES = ["calls", "instantiates", "references"];

/** The declarations a relation ends at, and the only ones that can own a local an `inject()` call initializes. */
const DECLARATION_KINDS: readonly string[] = [...EDGE_POLICY.relations.from, "function"];

function holdsReference(source: GraphSymbol, use: Pick<GraphUnresolvedReference, "file" | "line">): boolean {
  return source.file === use.file && source.startLine <= use.line && use.line <= source.endLine;
}

export function createInboundEdges(
  reader: CodeGraphReader,
  isTestFile: (path: string) => boolean,
  relations: readonly Relation[],
  fields: readonly FieldOrigin[] = [],
  locals: readonly LocalOrigin[] = [],
  validOccurrences?: ReadonlySet<string>,
  memberUses?: readonly MemberUseOrigin[],
  thisMemberCalls: ReadonlySet<string> = new Set(),
  /** The edges, by `edgeKey`, whose name is rooted outside the repository: none of them is a dependence. */
  outside: ReadonlySet<string> = new Set(),
): InboundEdges & InboundOccurrences {
  const relationsByTargetFile = Map.groupBy(relations, (candidate) => candidate.to.path);
  /** The local names more than one owner of one file declares: an ambiguous name settles nothing. */
  const sharedLocalNames = new Map<string, number>();
  for (const origin of locals) {
    const key = `${origin.owner.path}\0${origin.local}`;
    sharedLocalNames.set(key, (sharedLocalNames.get(key) ?? 0) + 1);
  }
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

  interface Into {
    edge: GraphEdge;
    source: GraphSymbol;
  }
  const intoCache = new Map<GraphNodeId, Into[]>();
  const followed: FollowedEdge[] = [];
  function followedEdgesInto(target: GraphSymbol): Into[] {
    let into = intoCache.get(target.id);
    if (into === undefined) {
      const edges = reader.incomingEdges([target.id], FOLLOWED_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge));
      load(edges.map((edge) => edge.source));
      const placed = edges.flatMap((edge) => {
        const source = symbolOf(edge.source);
        return source === undefined || source.id === target.id ? [] : [{ edge, source }];
      });
      for (const { edge, source } of placed) followed.push({ edge, source, target });
      into = placed.filter(({ edge }) => !outside.has(edgeKey(edge)));
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
            .map((from) => ({ from, confidence, bridge, basis: "dispatch" as const, lines: [] })),
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
    return importing.filter(({ file }) => !isTestFile(file)).flatMap(({ file, confidence }) => topLevelCodeOf(file).map((from) => ({ from, confidence, basis: "import" as const, lines: [] })));
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

  /** The classes whose injection or template use of `node` ye-ast read from the sources, only of `kinds` when given. */
  function relatedTo(node: GraphSymbol, kinds?: readonly string[]): InboundEdge[] {
    return (relationsByTargetFile.get(node.file) ?? [])
      .filter((candidate) => (kinds === undefined || kinds.includes(candidate.kind)) && joinsFact(node, { path: candidate.to.path, line: candidate.to.line, symbol: candidate.to.symbol }))
      .flatMap((candidate) => {
        const from = declarationAt(candidate.from);
        return from === undefined || isTestFile(from.file) || !followsRelation({ kind: candidate.kind, sourceKind: from.kind, targetKind: node.kind })
          ? []
          : [{ from, confidence: EDGE_POLICY.relations.confidence, basis: "relation" as const, lines: [] }];
      });
  }

  const referencesCache = new Map<string, ReadonlyMap<string, readonly GraphUnresolvedReference[]>>();
  /** The file's unresolved references by the name they use up to its first member: `this.svc.get` and `this.svc` under `this.svc`. */
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

  /**
   * The uses of `node` by name through `this`, made by code inside a type that declares it. The graph spells a call on
   * `this` of a member named like a library global by the bare name; the syntax proof makes it a call that settles its cut.
   */
  function ownUsesOf(node: GraphSymbol): InboundEdge[] {
    const owners = ownersOf(node);
    if (owners.length === 0) return [];
    const throughThis = `this.${node.name}`;
    const provenBare = (use: GraphUnresolvedReference): boolean => {
      const key = referenceKey(use);
      return use.kind === "calls" && use.name === node.name && key !== undefined && thisMemberCalls.has(key);
    };
    const uses = [...referencesThrough(node.file, throughThis), ...referencesThrough(node.file, node.name).filter(provenBare)];
    load(uses.map((use) => use.from));
    return uses.flatMap((use) => {
      const from = symbolOf(use.from);
      if (from === undefined || !owners.some((owner) => isInside(from, owner))) return [];
      const bare = use.name === node.name;
      const occurrence = bare ? uniqueUse(use) : undefined;
      if (occurrence !== undefined && uniqueAnchor(node)) settledUses.push({ key: declarationUseKey(declarationAnchor(node.file, node.name), occurrence), target: node.id, source: from.id });
      return [{ from, confidence: EDGE_POLICY.relations.confidence, basis: use.kind === "calls" && (bare || use.name === throughThis) ? "call" : "reference", lines: [use.line] }];
    });
  }


  const settledUses: { key: string; target: GraphNodeId; source?: GraphNodeId }[] = [];
  const uniqueAnchors = new Map<string, ReadonlySet<string>>();
  const uniqueAnchor = (node: GraphSymbol): boolean => {
    let unique = uniqueAnchors.get(node.file);
    if (unique === undefined) {
      const counts = new Map<string, number>();
      for (const candidate of symbolsInFile(node.file)) counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
      unique = new Set([...counts].filter(([, count]) => count === 1).map(([name]) => name));
      uniqueAnchors.set(node.file, unique);
    }
    return unique.has(node.name);
  };
  const uniqueByFile = new Map<string, ReadonlySet<string>>();
  const uniqueUse = (use: GraphUnresolvedReference): string | undefined => {
    let unique = uniqueByFile.get(use.file);
    if (unique === undefined) { unique = uniqueReferenceKeys(reader.unresolvedReferences([use.file])); uniqueByFile.set(use.file, unique); }
    const key = referenceKey(use);
    return key !== undefined && unique.has(key) && (validOccurrences === undefined || validOccurrences.has(key)) ? key : undefined;
  };
  const derivedHolders = new Map<GraphNodeId, boolean>();
  /**
   * Field origins retain potential impact paths. Only readers without an exact member channel authorize legacy
   * settlements here; a present channel, including an empty one, reserves settlement for its exact proofs.
   */
  function fieldUsesOf(node: GraphSymbol): InboundEdge[] {
    const owners = ownersOf(node);
    if (owners.length === 0) return [];
    const anchor = declarationAnchor(node.file, node.name);
    const related = owners.flatMap((owner) => [owner, ...typesAround(owner, "down").map(({ type }) => type)]);
    const callers: InboundEdge[] = [];
    for (const origin of fields) {
      const holder = declarationAt(origin.owner);
      if (holder === undefined || isTestFile(holder.file)) continue;
      if (memberUses === undefined) {
        let derived = derivedHolders.get(holder.id);
        if (derived === undefined) {
          derived = reader.incomingEdges([holder.id], SUPERTYPE_EDGES).length > 0;
          derivedHolders.set(holder.id, derived);
        }
        if (derived) continue;
      }
      const uses = referencesThrough(holder.file, `this.${origin.field}`).filter((reference) => reference.name === `this.${origin.field}.${node.name}`);
      if (uses.length === 0) continue;
      const held = "class" in origin.holds ? origin.holds.class : undefined;
      const holdsOwner = held !== undefined && owners.some((owner) => joinsFact(owner, { path: held.path, line: held.line, symbol: held.symbol }));
      const holdsRelated = held !== undefined && related.some((type) => joinsFact(type, { path: held.path, line: held.line, symbol: held.symbol }));
      if (!holdsOwner && holdsRelated) continue;
      load(uses.map((use) => use.from));
      for (const use of uses) {
        const from = symbolOf(use.from);
        if (from === undefined || !isInside(from, holder) || !holdsReference(from, use)) continue;
        const occurrence = uniqueUse(use);
        if (occurrence === undefined) continue;
        if (memberUses === undefined && uniqueAnchor(node)) settledUses.push({ key: declarationUseKey(anchor, occurrence), target: node.id, ...(holdsOwner ? { source: from.id } : {}) });
        if (holdsOwner) callers.push({ from, confidence: EDGE_POLICY.relations.confidence, basis: use.kind === "calls" ? "call" : "reference", lines: [use.line] });
      }
    }
    return callers;
  }

  /**
   * The calls made through a local a function takes from `inject()`: `const svc = inject(Svc); svc.member()`. The index
   * types no local. Certified sites give potential reach only when the native member channel is present; older
   * readers without that channel retain the legacy settlement behavior.
   */
  function localUsesOf(node: GraphSymbol): InboundEdge[] {
    const owners = ownersOf(node);
    if (owners.length === 0 || locals.length === 0) return [];
    const anchor = declarationAnchor(node.file, node.name);
    const callers: InboundEdge[] = [];
    for (const origin of locals) {
      const held = origin.holds.class;
      if ((sharedLocalNames.get(`${origin.owner.path}\0${origin.local}`) ?? 0) > 1) continue;
      if (!owners.some((owner) => joinsFact(owner, { path: held.path, line: held.line, symbol: held.symbol }))) continue;
      const holder = declarationAt(origin.owner, DECLARATION_KINDS);
      if (holder === undefined || isTestFile(holder.file)) continue;
      const name = `${origin.local}.${node.name}`;
      const uses = referencesThrough(holder.file, name).filter((reference) => reference.name === name);
      load(uses.map((use) => use.from));
      for (const use of uses) {
        const from = symbolOf(use.from);
        if (from === undefined || !isInside(from, holder) || !holdsReference(from, use)) continue;
        const occurrence = uniqueUse(use);
        if (occurrence === undefined) continue;
        if (memberUses !== undefined && !origin.calls?.some((site) => site.file === use.file && site.line === use.line && site.column === use.column + 1 && site.name === use.name && site.kind === use.kind)) continue;
        if (memberUses === undefined && uniqueAnchor(node)) settledUses.push({ key: declarationUseKey(anchor, occurrence), target: node.id, source: from.id });
        callers.push({ from, confidence: EDGE_POLICY.relations.confidence, basis: use.kind === "calls" ? "call" : "reference", lines: [use.line] });
      }
    }
    return callers;
  }

  const memberNames = new Set((memberUses ?? []).map((proof) => proof.member.symbol));
  const memberTargets = new Map<string, string>();
  const memberExpanded = new Map<string, GraphNodeId>();
  const memberCallers = new Map<GraphNodeId, InboundEdge[]>();
  let membersIndexed = false;
  const memberMatches = new Map<string, readonly GraphSymbol[]>();
  const memberSymbols = new Map<string, ReadonlyMap<string, readonly GraphSymbol[]>>();
  const memberReferences = new Map<string, ReadonlyMap<string, readonly GraphUnresolvedReference[]>>();
  const memberSiteKey = (site: { line: number; column: number; name: string; kind: string }): string => JSON.stringify([site.line, site.column, site.name, site.kind]);
  interface JoinedMember { member: GraphSymbol; from: GraphSymbol; occurrence: string; line: number; resource?: string }
  const joinedMembers = new Map<MemberUseOrigin, JoinedMember | undefined>();
  function joinMember(proof: MemberUseOrigin): JoinedMember | undefined {
    if (joinedMembers.has(proof)) return joinedMembers.get(proof);
    const matches = (ref: SymbolRef, kind: string): readonly GraphSymbol[] => {
      const key = JSON.stringify([kind, ref.path, ref.line, ref.symbol]);
      let found = memberMatches.get(key);
      if (found === undefined) {
        let symbols = memberSymbols.get(ref.path);
        if (symbols === undefined) {
          symbols = Map.groupBy(symbolsInFile(ref.path), (node) => JSON.stringify([node.kind, node.name]));
          memberSymbols.set(ref.path, symbols);
        }
        found = (symbols.get(JSON.stringify([kind, ref.symbol])) ?? []).filter((node) => joinsFact(node, ref));
        memberMatches.set(key, found);
      }
      return found;
    };
    const owners = [...EDGE_POLICY.injectableKinds, "function"].flatMap((kind) => matches(proof.owner, kind));
    const receivers = matches(proof.receiver, "class");
    const members = matches(proof.member, "method");
    const ownsMember = (member: GraphSymbol, receiver: GraphSymbol): boolean => { const memberOwners = ownersOf(member); return memberOwners.length === 1 && memberOwners[0]!.id === receiver.id; };
    if (proof.template === true) {
      const owner = owners[0];
      const result = owners.length === 1 && receivers.length === 1 && members.length === 1 && !isTestFile(proof.reference.file) && !isTestFile(owner!.file) && ownsMember(members[0]!, receivers[0]!)
        ? { member: members[0]!, from: owner!, occurrence: JSON.stringify([proof.reference.file, proof.reference.line, proof.reference.column, proof.reference.name]), line: proof.reference.line, ...(proof.reference.file === owner!.file ? {} : { resource: proof.reference.file }) }
        : undefined;
      joinedMembers.set(proof, result);
      return result;
    }
    let sites = memberReferences.get(proof.reference.file);
    if (sites === undefined) {
      sites = Map.groupBy(reader.unresolvedReferences([proof.reference.file]), (ref) => memberSiteKey({ ...ref, column: ref.column + 1 }));
      memberReferences.set(proof.reference.file, sites);
    }
    const refs = sites.get(memberSiteKey(proof.reference)) ?? [];
    let result: JoinedMember | undefined;
    if (owners.length === 1 && receivers.length === 1 && members.length === 1 && refs.length === 1 && !isTestFile(proof.reference.file)) {
      const use = refs[0]!;
      load([use.from]);
      const from = symbolOf(use.from);
      const occurrence = uniqueUse(use);
      const member = members[0]!;
      if (from !== undefined && occurrence !== undefined && isInside(from, owners[0]!) && holdsReference(from, use) && ownsMember(member, receivers[0]!)) result = { member, from, occurrence, line: use.line };
    }
    joinedMembers.set(proof, result);
    return result;
  }
  function indexMemberUses(): void {
    if (membersIndexed) return;
    membersIndexed = true;
    const joined = (memberUses ?? []).flatMap((proof) => { const use = joinMember(proof); return use === undefined ? [] : [{ ...use, substitutes: proof.substitutes, template: proof.template === true }]; });
    for (const [occurrence, group] of Map.groupBy(joined, (use) => use.occurrence)) {
      if (group.length !== 1) continue;
      const use = group[0]!;
      if (!use.template) {
        const anchor = declarationAnchor(use.member.file, use.member.name);
        /** A receiver a provider may replace settles its own member's place, but cannot exclude a substitute's homonym. */
        if (use.substitutes === undefined) memberTargets.set(occurrence, anchor);
        if (uniqueAnchor(use.member)) settledUses.push({ key: declarationUseKey(anchor, occurrence), target: use.member.id, source: use.from.id });
      }
      const callers = memberCallers.get(use.member.id) ?? [];
      callers.push({ from: use.from, confidence: EDGE_POLICY.relations.confidence, basis: "call", lines: [use.line], ...(use.resource === undefined ? {} : { resource: use.resource }), ...(use.substitutes === undefined ? {} : { substitutes: use.substitutes }) });
      memberCallers.set(use.member.id, callers);
    }
  }
  function provenMemberUsesOf(node: GraphSymbol): InboundEdge[] {
    if (!memberNames.has(node.name)) return [];
    indexMemberUses();
    if (uniqueAnchor(node)) memberExpanded.set(declarationAnchor(node.file, node.name), node.id);
    return memberCallers.get(node.id) ?? [];
  }

  type Gathered = InboundEdge & { provenance?: GraphEdge["provenance"] };
  function gather(node: GraphSymbol, contractChanged: boolean, throughMember: boolean): Gathered[] {
    const followed = followedEdgesInto(node).filter(({ edge, source }) => !isTestFile(source.file) && followsEdge({ kind: edge.kind, sourceKind: source.kind, targetKind: node.kind }));
    const into = throughMember ? followed.filter(({ edge }) => (EDGE_POLICY.ownerThroughMember.edges as readonly string[]).includes(edge.kind)) : followed;
    const direct: Gathered[] = into.map(({ edge, source }) => ({
      from: source,
      confidence: edgeConfidence(edge),
      basis: CALL_EDGE_KINDS.includes(edge.kind) ? ("call" as const) : ("reference" as const),
      lines: edge.line === null ? [] : [edge.line],
      provenance: edge.provenance,
    }));
    const bridged = throughMember ? direct : [...direct, ...bridgesOf(node, contractChanged), ...fieldUsesOf(node), ...localUsesOf(node), ...provenMemberUsesOf(node), ...ownUsesOf(node)];
    const found = [...bridged, ...relatedTo(node, throughMember ? EDGE_POLICY.ownerThroughMember.relations : undefined)];
    /** Individual target lookups do not prove incoming-reference coverage. */
    const whole = throughMember ? found : [...found, ...importersOf(node, found.length === 0)];
    return whole.filter(({ from }) => from.id !== node.id);
  }

  const callersCache = new Map<string, InboundEdge[]>();
  function callersOf(node: GraphSymbol, contractChanged: boolean, throughMember = false): InboundEdge[] {
    const key = `${node.id}:${contractChanged}:${throughMember}`;
    let callers = callersCache.get(key);
    if (callers === undefined) {
      callers = strongestPerSymbol(gather(node, contractChanged, throughMember).map(({ provenance: _, ...edge }) => edge)).sort((a, b) => comparePosition(a.from, b.from));
      callersCache.set(key, callers);
    }
    return callers;
  }

  function occurrencesOf(node: GraphSymbol): InboundOccurrence[] {
    const kept = new Map<string, InboundOccurrence>();
    for (const edge of gather(node, false, false)) {
      for (const line of edge.lines.length === 0 ? [undefined] : edge.lines) {
        const occurrence: InboundOccurrence = {
          from: edge.from,
          ...(line === undefined ? {} : { line }),
          ...(edge.resource === undefined ? {} : { resource: edge.resource }),
          basis: edge.basis,
          confidence: edge.confidence,
          provenance: edge.provenance ?? null,
          ...(edge.bridge === undefined ? {} : { bridge: edge.bridge }),
          ...(edge.substitutes === undefined ? {} : { substitutes: edge.substitutes }),
        };
        const key = JSON.stringify([edge.from.id, line ?? null, edge.resource ?? null, edge.basis, edge.bridge ?? null, edge.substitutes !== undefined]);
        const held = kept.get(key);
        if (held === undefined || (held.provenance === "heuristic" && occurrence.provenance !== "heuristic") || (held.provenance === occurrence.provenance && occurrence.confidence > held.confidence)) kept.set(key, occurrence);
      }
    }
    return [...kept.values()].sort((a, b) => comparePosition(a.from, b.from) || (a.line ?? Infinity) - (b.line ?? Infinity) || compareText(a.basis, b.basis));
  }

  return {
    callersOf,
    occurrencesOf,
    ownersOf,
    settledUses: (expanded, reached) => new Set(settledUses
      .filter((use) => (expanded === undefined || expanded.has(use.target)) && (use.source === undefined || reached === undefined || reached.has(use.source)))
      .map((use) => use.key)),
    memberProofs: (expanded) => ({
      targets: memberTargets,
      expanded: new Set([...memberExpanded].filter(([, id]) => expanded === undefined || expanded.has(id)).map(([anchor]) => anchor)),
    }),
    followed: () => followed,
  };
}

function strongestPerSymbol(edges: readonly InboundEdge[]): InboundEdge[] {
  const gathered = new Map<GraphNodeId, { edge: InboundEdge; calls: boolean }>();
  const ordered = edges.toSorted((a, b) =>
    (a.lines[0] ?? Infinity) - (b.lines[0] ?? Infinity) ||
    compareText(a.basis, b.basis) ||
    compareText(a.bridge ?? "", b.bridge ?? "") ||
    compareText(a.resource ?? "", b.resource ?? "") ||
    Number(a.substitutes !== undefined) - Number(b.substitutes !== undefined));
  for (const edge of ordered) {
    const held = gathered.get(edge.from.id);
    let selected = held?.edge;
    if (selected === undefined || edge.confidence > selected.confidence) selected = edge;
    else if (edge.confidence === selected.confidence && edge.basis === selected.basis && edge.bridge === selected.bridge && edge.resource === selected.resource && edge.substitutes === selected.substitutes) {
      selected = { ...selected, lines: [...new Set([...selected.lines, ...edge.lines])].sort((a, b) => a - b) };
    }
    gathered.set(edge.from.id, {
      edge: selected,
      calls: (held?.calls ?? false) || (edge.hasCall ?? edge.basis === "call"),
    });
  }
  return [...gathered.values()].map(({ edge, calls }) => ({ ...edge, hasCall: calls }));
}
