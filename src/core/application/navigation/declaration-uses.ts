import { referenceKey } from "../../domain/impact/impact-cuts.ts";
import { sameOccurrence, type EdgeOccurrence } from "../../domain/trace/call-place.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { FollowedEdge } from "./edge-targets.ts";
import type { GraphNavigation } from "./graph-navigation.ts";

/**
 * What one declaration's own body names, as the index records it: the edges it resolved and the references it left
 * unresolved, read once per file for the life of one query. Shared by every family that reads a body's uses.
 */
export interface DeclarationUses {
  /** `edges` from `node` whose target the store holds, each with both ends. */
  followed(node: GraphSymbol, edges: readonly GraphEdge[]): FollowedEdge[];
  /** The unresolved references `node` makes of `kinds`, once per occurrence, in the store's order. */
  referencesFrom(node: GraphSymbol, kinds: readonly string[]): readonly GraphUnresolvedReference[];
  /** The members named `member` of the types that declare `node`, of `kinds`, once each. */
  ownMembers(node: GraphSymbol, member: string, kinds: readonly string[]): GraphSymbol[];
}

/** A file's unresolved references, read on demand and once per file for the life of one query. */
export type UnresolvedIn = (file: string) => readonly GraphUnresolvedReference[];

export function unresolvedOncePerFile(store: CodeGraphReader): UnresolvedIn {
  const read = new Map<string, readonly GraphUnresolvedReference[]>();
  return (file) => {
    let references = read.get(file);
    if (references === undefined) {
      references = store.unresolvedReferences([file]);
      read.set(file, references);
    }
    return references;
  };
}

export function createDeclarationUses(store: CodeGraphReader, navigation: GraphNavigation, unresolvedIn: UnresolvedIn = unresolvedOncePerFile(store)): DeclarationUses {
  const referencesByFile = new Map<string, ReadonlyMap<GraphNodeId, readonly GraphUnresolvedReference[]>>();
  return {
    followed(node, edges) {
      navigation.load(edges.map((edge) => edge.target));
      return edges.flatMap((edge) => {
        const target = navigation.symbolOf(edge.target);
        return target === undefined ? [] : [{ edge, source: node, target }];
      });
    },
    referencesFrom(node, kinds) {
      let byNode = referencesByFile.get(node.file);
      if (byNode === undefined) {
        byNode = Map.groupBy(unresolvedIn(node.file), (reference) => reference.from);
        referencesByFile.set(node.file, byNode);
      }
      const found = (byNode.get(node.id) ?? []).filter((reference) => kinds.includes(reference.kind));
      return [...new Map(found.map((reference) => [referenceKey(reference) ?? reference, reference])).values()];
    },
    ownMembers(node, member, kinds) {
      const members = navigation.ownersOf(node).flatMap((owner) => navigation.membersOf(owner)).filter((symbol) => symbol.name === member && kinds.includes(symbol.kind));
      return [...new Map(members.map((symbol) => [symbol.id, symbol])).values()];
    },
  };
}

/** The references no resolved edge records at the same occurrence. */
export function unsettledBy(references: readonly GraphUnresolvedReference[], edges: readonly FollowedEdge[]): GraphUnresolvedReference[] {
  const resolved: EdgeOccurrence[] = edges.map(({ edge, target }) => ({ source: edge.source, line: edge.line, column: edge.column, targetName: target.name }));
  return references.filter((reference) => !resolved.some((edge) => sameOccurrence(edge, reference)));
}
