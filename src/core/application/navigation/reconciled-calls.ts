import { calleeOf } from "../../domain/shared/call-place.ts";
import { CALL_EDGE_KINDS, holdsValue, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import { containsPosition, declarationSpan, executesInBody, owningBody, type SourceSpan } from "../../domain/shared/owning-body.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames, SyntaxCall } from "../../ports/declared-member-names.port.ts";
import type { DeclarationUses } from "./declaration-uses.ts";
import type { FollowedEdge } from "./edge-targets.ts";

type SyntaxScope = SyntaxCall["owners"][number];
type PositionedBody = GraphSymbol & SourceSpan & { scope?: SyntaxScope };
export type OwnedCall = SyntaxCall & { ambiguous?: true; deferred?: true };
const BODY_KINDS: readonly string[] = ["function", "method", "class", "component", "property", "field"];
const scopeSpan = (scope: SyntaxScope): SourceSpan => ({ start: { line: scope.start, column: scope.startColumn }, end: { line: scope.endLine, column: scope.endColumn } });
const spanKey = (span: SourceSpan): string => `${span.start.line}:${span.start.column}:${span.end.line}:${span.end.column}`;
const scopeKey = (scope: SyntaxScope): string => spanKey(scopeSpan(scope));

function positionedBodies(declarations: readonly GraphSymbol[], calls: readonly SyntaxCall[]): PositionedBody[] {
  const scopes = [...new Map(calls.flatMap((call) => call.owners).map((scope) => [scopeKey(scope), { ...scopeSpan(scope), scope }])).values()];
  return declarations.flatMap((symbol): PositionedBody[] => {
    if (!BODY_KINDS.includes(symbol.kind) && !holdsValue(symbol.kind)) return [];
    const indexed = { ...symbol, ...declarationSpan(symbol) };
    const atStart = owningBody(scopes, { line: symbol.startLine, column: symbol.startColumn });
    const anchors = scopes.filter(({ scope }) => scope.nameLine === symbol.startLine && scope.nameColumn === symbol.startColumn);
    const header = atStart !== undefined && ((atStart.start.line === symbol.startLine && atStart.start.column === symbol.startColumn) ||
      symbol.startLine < atStart.scope.nameLine || (symbol.startLine === atStart.scope.nameLine && symbol.startColumn <= atStart.scope.nameColumn));
    const scope = anchors.length === 1 ? anchors[0] : header ? atStart : undefined;
    const initializer = holdsValue(symbol.kind) && !declarations.some((other) => other.id !== symbol.id && ["function", "method"].includes(other.kind) && containsPosition(declarationSpan(other), { line: symbol.startLine, column: symbol.startColumn }));
    if (!BODY_KINDS.includes(symbol.kind) && scope === undefined && !initializer) return [];
    return [{ ...indexed, ...(scope === undefined ? {} : { ...scopeSpan(scope.scope), scope: scope.scope }) }];
  });
}

/** Exact lexical ownership, with uninvoked function-value boundaries retained for reconciliation only. */
export function callsByOwner(calls: readonly SyntaxCall[], declarations: readonly GraphSymbol[], functionValues: readonly SourceSpan[]): ReadonlyMap<GraphNodeId, readonly OwnedCall[]> {
  const found = new Map<GraphNodeId, OwnedCall[]>();
  const bodies = positionedBodies(declarations, calls);
  for (const call of calls) {
    const scopeKeys = new Set(call.owners.map(scopeKey));
    const valuesInScope = functionValues.filter((value) => scopeKeys.has(spanKey(value)));
    const eligible = bodies.filter((body) => body.scope === undefined || scopeKeys.has(scopeKey(body.scope)));
    const owner = owningBody(eligible, { line: call.line, column: call.column - 1 });
    const possible = owner === undefined ? declarations.filter((symbol) => BODY_KINDS.includes(symbol.kind) &&
      ((symbol.startLine <= call.line && call.line <= symbol.endLine) || call.owners.some((scope) => scope.start <= symbol.startLine && symbol.startLine <= scope.endLine))) : [owner];
    for (const body of possible) found.set(body.id, [...found.get(body.id) ?? [], owner === undefined ? { ...call, ambiguous: true } : executesInBody(owner, valuesInScope, { line: call.line, column: call.column - 1 }) ? call : { ...call, deferred: true }]);
  }
  return found;
}

/** A line-only record can name a site only when the owner and callee leave exactly one occurrence on that line. */
function matchOwnedCall(calls: readonly OwnedCall[], line: number | null, column: number | null, name: string): OwnedCall | undefined {
  const placed = column !== null && Number.isFinite(column);
  const primary = calls.filter((call) => !call.ambiguous && call.line === line && call.column - 1 === column);
  const at = placed && primary.length > 0 ? primary : calls.filter((call) => !call.ambiguous && (placed ? call.anchors?.some((anchor) => anchor.line === line && anchor.column - 1 === column) : call.line === line));
  const spelled = at.filter((call) => call.name === name);
  if (spelled.length > 0) return spelled.length === 1 ? spelled[0] : undefined;
  const callee = calleeOf(name);
  const named = at.filter((call) => callee.form !== "computed" && call.callee === callee.name);
  return named.length === 1 ? named[0] : named.length === 0 && at.length === 1 ? at[0] : undefined;
}

/**
 * A body's call-bearing records aligned with the calls its source writes. A record keeps the index's place when its source
 * is unread, when it matches a deferred call, or when it matches none and has no column or lies in a function value the
 * body does not run; every other record is at its written call or index-only.
 */
export interface BodyCalls {
  /** The body's call edges whose target the store holds, in the store's order. */
  edges: readonly FollowedEdge[];
  /** The body's unresolved call references, in the store's order. */
  references: readonly GraphUnresolvedReference[];
  /** Records no call the body writes at their place matches: edges first, then references. */
  indexOnly: readonly GraphUnresolvedReference[];
  /** Calls the body writes and runs that no record matches, in written order. */
  writtenOnly: readonly GraphUnresolvedReference[];
  /** Calls written where no single index body owns them, in written order. */
  ambiguous: readonly GraphUnresolvedReference[];
}

/** The one owner of what a body calls: the index's call-bearing records aligned with the written calls, per snapshot read. */
export interface ReconciledCalls {
  callsOf(body: GraphSymbol): Promise<BodyCalls>;
  /** The written calls of `file` by the index body that owns them. */
  ownedIn(file: string): Promise<ReadonlyMap<GraphNodeId, readonly OwnedCall[]>>;
}

export interface ReconciledCallsInput {
  store: CodeGraphReader;
  uses: DeclarationUses;
  syntaxOf: (file: string) => Promise<DeclaredMemberNames>;
}

/** The call edges of `symbol` no policy ignores. */
export function callEdgesOf(store: CodeGraphReader, symbol: GraphSymbol): GraphEdge[] {
  return store.outgoingEdges([symbol.id], CALL_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge));
}

export function createReconciledCalls({ store, uses, syntaxOf }: ReconciledCallsInput): ReconciledCalls {
  const ownedIn = oncePerFile(async (file) => {
    const syntax = await syntaxOf(file);
    return callsByOwner(syntax.calls ?? [], store.symbolsInFiles([file]), syntax.functionValues);
  });
  const bodiesIn = oncePerFile(async (file) =>
    positionedBodies(store.symbolsInFiles([file]), (await syntaxOf(file)).calls ?? []).map((body) => ({ ...body, ...declarationSpan(body) })));
  return {
    ownedIn,
    async callsOf(node) {
      const syntax = await syntaxOf(node.file);
      const calls = (await ownedIn(node.file)).get(node.id) ?? [];
      const accounted = new Set<OwnedCall>();
      const indexOnly: GraphUnresolvedReference[] = [];
      const indexedBodies = await bodiesIn(node.file);
      const aligned = (line: number | null, column: number | null, name: string): boolean => {
        if (syntax.calls === undefined) return false;
        const site = matchOwnedCall(calls, line, column, name);
        return site !== undefined ? site.deferred !== true : line === null || column === null || executesInBody(declarationSpan(node), syntax.functionValues, { line, column });
      };
      const accountedSite = (line: number | null, column: number | null, name: string): OwnedCall | undefined => {
        const owner = line === null || column === null || !Number.isFinite(column) ? undefined : owningBody(indexedBodies, { line, column });
        const site = owner !== undefined && owner.id !== node.id ? undefined : matchOwnedCall(calls, line, column, name);
        if (site !== undefined) accounted.add(site);
        return site;
      };
      const edges = uses.followed(node, callEdgesOf(store, node)).flatMap((followed) => {
        if (!aligned(followed.edge.line, followed.edge.column, followed.target.name)) return [followed];
        const site = accountedSite(followed.edge.line, followed.edge.column, followed.target.name);
        if (site === undefined) {
          indexOnly.push({ from: node.id, file: node.file, line: followed.edge.line ?? node.startLine, column: followed.edge.column ?? 0, name: followed.target.name, kind: followed.edge.kind, candidates: [] });
          return [];
        }
        return [{ ...followed, edge: { ...followed.edge, line: site.line, column: site.column - 1 } }];
      });
      const references = uses.referencesFrom(node, CALL_EDGE_KINDS).flatMap((reference) => {
        if (!aligned(reference.line, reference.column, reference.name)) return [reference];
        const site = accountedSite(reference.line, reference.column, reference.name);
        if (site === undefined) { indexOnly.push(reference); return []; }
        return [{ ...reference, line: site.line, column: site.column - 1 }];
      });
      const writtenOnly: GraphUnresolvedReference[] = [];
      const ambiguous: GraphUnresolvedReference[] = [];
      for (const call of calls) {
        if (accounted.has(call) || call.deferred) continue;
        const reference = { from: node.id, file: node.file, line: call.line, column: call.column - 1, name: call.name, kind: call.kind, candidates: [] };
        (call.ambiguous ? ambiguous : writtenOnly).push(reference);
      }
      return { edges, references, indexOnly, writtenOnly, ambiguous };
    },
  };
}

function oncePerFile<V>(derive: (file: string) => Promise<V>): (file: string) => Promise<V> {
  const known = new Map<string, Promise<V>>();
  return (file) => {
    let found = known.get(file);
    if (found === undefined) {
      found = derive(file);
      known.set(file, found);
    }
    return found;
  };
}
