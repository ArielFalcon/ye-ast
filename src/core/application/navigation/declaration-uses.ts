import { EDGE_POLICY, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import { referenceKey } from "../../domain/impact/impact-cuts.ts";
import type { OutlinePlace, OutlineUseTarget } from "../../domain/outline/outline-fact.ts";
import type { FoundUse, UnprovedUse } from "../../domain/outline/outline-uses.ts";
import { sameOccurrence, type EdgeOccurrence } from "../../domain/trace/call-place.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOrigins, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import { containmentTree } from "./containment-tree.ts";
import { branchesOf, declarationPath } from "../../domain/shared/declaration-tree.ts";
import type { EdgeTargets, FollowedEdge } from "./edge-targets.ts";
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

/** The edges a use is: what a body runs, builds or names, and the types a type extends or implements. */
export const USE_EDGE_KINDS: readonly string[] = ["calls", "instantiates", "references", "extends", "implements"];

/** The identifier, `this` or `super` the index's spelling of a use starts with. */
const SPELLED = /^[A-Za-z_$][\w$]*/;

export interface UsesInput {
  store: CodeGraphReader;
  navigation: GraphNavigation;
  uses: DeclarationUses;
  targets: EdgeTargets;
  origins: ImportOrigins;
  signal?: AbortSignal;
}

/**
 * What `node`'s own body uses that is bound outside the body (plan Part B): every resolved edge, corrected by where its
 * root is bound (`EdgeTargets.verdictsOf`), and every unresolved reference no edge records at its place, settled by
 * what binds its root there (`ImportOrigins.rootBindings`). A local value, a parameter included, and a declaration inside
 * the body are not uses; a declaration outside it is the node of its name whose lines hold the line its name is written
 * on, or, with no such node, a local root when it is a value a function around the body declares; a use nothing proves
 * is unproved, never dropped.
 */
export async function usesOf(node: GraphSymbol, input: UsesInput): Promise<{ found: FoundUse[]; unproved: UnprovedUse[] }> {
  const { store, navigation, uses, targets, origins, signal } = input;
  const nested = containedIn(navigation, node);
  const found: FoundUse[] = [];
  const unproved: UnprovedUse[] = [];
  const declared = (symbol: GraphSymbol, relation: string, place: OutlinePlace | undefined): void => {
    if (!nested.has(symbol.id)) found.push({ target: { declaration: { file: symbol.file, name: symbol.name, kind: symbol.kind, line: symbol.startLine, endLine: symbol.endLine } }, relation, ...(place === undefined ? {} : { place }) });
  };

  const edges = uses.followed(node, store.outgoingEdges([node.id], USE_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge)));
  const verdicts = await targets.verdictsOf(edges, signal);
  for (const [index, { edge, target }] of edges.entries()) {
    const verdict = verdicts[index]!;
    const place = edge.line === null ? undefined : { line: edge.line, ...(edge.column === null ? {} : { column: edge.column + 1 }) };
    if (verdict.kind !== "drop") declared(verdict.kind === "redirect" ? verdict.to : target, edge.kind, place);
    else if (verdict.root.kind === "external") found.push({ target: { module: verdict.root.module }, relation: edge.kind, ...(place === undefined ? {} : { place }) });
    else if (verdict.root.kind === "ambient") found.push({ target: { global: verdict.root.name }, relation: edge.kind, ...(place === undefined ? {} : { place }) });
  }

  const references = unsettledBy(uses.referencesFrom(node, USE_EDGE_KINDS), edges);
  const spelled = references.map((reference) => ({ reference, spelled: SPELLED.exec(reference.name)?.[0] }));
  const sites = spelled.flatMap(({ reference, spelled: name }): UseSite[] => (name === undefined ? [] : [{ file: reference.file, line: reference.line, column: reference.column + 1, spelled: name, owner: { name: node.name, line: node.startLine, endLine: node.endLine } }]));
  const bindings = await origins.rootBindings(sites, signal);
  let next = 0;
  for (const { reference, spelled: name } of spelled) {
    const binding: RootBinding = name === undefined ? { kind: "unknown" } : bindings[next++] ?? { kind: "unknown" };
    const place = { line: reference.line, column: reference.column + 1 };
    const settled = await settle(reference, binding);
    if (settled === "local") continue;
    if (settled === undefined) unproved.push({ root: "root" in binding ? binding.root : name ?? reference.name, line: reference.line, spelling: reference.name });
    else if ("id" in settled) declared(settled, reference.kind, place);
    else found.push({ target: settled, relation: reference.kind, place });
  }
  return { found, unproved };

  async function settle(reference: GraphUnresolvedReference, binding: RootBinding): Promise<GraphSymbol | OutlineUseTarget | "local" | undefined> {
    if (binding.kind === "ambient") return { global: binding.root };
    if (binding.kind === "this") {
      const members = binding.member === undefined ? [] : uses.ownMembers(node, binding.member, EDGE_POLICY.memberKinds);
      return members.length === 1 ? members[0] : undefined;
    }
    if (binding.kind === "local") return "local";
    if (binding.kind === "declared") {
      const candidates = navigation.symbolsInFile(reference.file).filter((symbol) => symbol.name === binding.root && binding.lines.some((line) => symbol.startLine <= line && line <= symbol.endLine));
      /** A value a function around the body declares and the index holds no node of is a local root (plan D4). */
      return candidates.length === 0 && binding.captured ? "local" : single(candidates);
    }
    if (binding.kind === "located") return single(branchesOf(containmentTree(store, navigation.symbolsInFile(binding.file))).filter((branch) => declarationPath(branch) === binding.path).map((branch) => branch.declaration));
    if (binding.kind !== "import") return undefined;
    if (binding.origin.kind === "external") return { module: binding.origin.module };
    const imported = (await targets.importedDeclarations(reference.file)).get(binding.root);
    if (imported !== undefined) return imported;
    const member = binding.member;
    return member === undefined ? undefined : single(containmentTree(store, navigation.symbolsInFile(binding.origin.file)).map((branch) => branch.declaration).filter((symbol) => symbol.name === member));
  }
}

/** The declarations the graph's `contains` edges place under `node`, at any depth. */
function containedIn(navigation: GraphNavigation, node: GraphSymbol): ReadonlySet<GraphNodeId> {
  const found = new Set<GraphNodeId>();
  for (let frontier: readonly GraphSymbol[] = [node]; frontier.length > 0; ) {
    frontier = frontier.flatMap((parent) => navigation.membersOf(parent)).filter((child) => !found.has(child.id) && child.id !== node.id);
    for (const child of frontier) found.add(child.id);
  }
  return found;
}

function single(symbols: readonly GraphSymbol[]): GraphSymbol | undefined {
  const distinct = [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()];
  return distinct.length === 1 ? distinct[0] : undefined;
}
