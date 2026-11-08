import { calleeOf } from "../../domain/trace/call-place.ts";
import { holdsValue } from "../../domain/impact/edge-policy.ts";
import { containsPosition, declarationSpan, executesInBody, owningBody, type SourceSpan } from "../../domain/trace/owning-body.ts";
import type { GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SyntaxCall } from "../../ports/declared-member-names.port.ts";

type SyntaxScope = SyntaxCall["owners"][number];
type PositionedBody = GraphSymbol & SourceSpan & { scope?: SyntaxScope };
export type OwnedCall = SyntaxCall & { ambiguous?: true; deferred?: true };
const BODY_KINDS: readonly string[] = ["function", "method", "class", "component", "property", "field"];
const scopeSpan = (scope: SyntaxScope): SourceSpan => ({ start: { line: scope.start, column: scope.startColumn }, end: { line: scope.endLine, column: scope.endColumn } });
const spanKey = (span: SourceSpan): string => `${span.start.line}:${span.start.column}:${span.end.line}:${span.end.column}`;
const scopeKey = (scope: SyntaxScope): string => spanKey(scopeSpan(scope));

export function positionedBodies(declarations: readonly GraphSymbol[], calls: readonly SyntaxCall[]): PositionedBody[] {
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
export function matchOwnedCall(calls: readonly OwnedCall[], line: number | null, column: number | null, name: string): OwnedCall | undefined {
  const placed = column !== null && Number.isFinite(column);
  const primary = calls.filter((call) => !call.ambiguous && call.line === line && call.column - 1 === column);
  const at = placed && primary.length > 0 ? primary : calls.filter((call) => !call.ambiguous && (placed ? call.anchors?.some((anchor) => anchor.line === line && anchor.column - 1 === column) : call.line === line));
  const spelled = at.filter((call) => call.name === name);
  if (spelled.length > 0) return spelled.length === 1 ? spelled[0] : undefined;
  const callee = calleeOf(name);
  const named = at.filter((call) => callee.form !== "computed" && call.callee === callee.name);
  return named.length === 1 ? named[0] : named.length === 0 && at.length === 1 ? at[0] : undefined;
}
