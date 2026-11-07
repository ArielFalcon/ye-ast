import { calleeOf } from "../../domain/trace/call-place.ts";
import { containsPosition, owningBodyAt, type SourceSpan } from "../../domain/shared/source-span.ts";
import type { GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SyntaxCall } from "../../ports/declared-member-names.port.ts";

type SyntaxScope = SyntaxCall["owners"][number];
type PositionedBody = GraphSymbol & SourceSpan & { scope?: SyntaxScope };
export type OwnedCall = SyntaxCall & { ambiguous?: true };
const BODY_KINDS: readonly string[] = ["function", "method", "class", "component", "property", "field"];
const scopeSpan = (scope: SyntaxScope): SourceSpan => ({ startLine: scope.start, startColumn: scope.startColumn, endLine: scope.endLine, endColumn: scope.endColumn });
const scopeKey = (scope: SyntaxScope): string => `${scope.start}:${scope.startColumn}:${scope.endLine}:${scope.endColumn}`;

export function positionedBodies(declarations: readonly GraphSymbol[], calls: readonly SyntaxCall[]): PositionedBody[] {
  const scopes = [...new Map(calls.flatMap((call) => call.owners).map((scope) => [scopeKey(scope), { ...scopeSpan(scope), scope }])).values()];
  return declarations.flatMap((symbol): PositionedBody[] => {
    if ((!BODY_KINDS.includes(symbol.kind) && !["constant", "variable"].includes(symbol.kind)) || symbol.startColumn === undefined || symbol.endColumn === undefined) return [];
    const indexed = symbol as PositionedBody;
    const atStart = owningBodyAt(scopes, symbol.startLine, symbol.startColumn);
    const anchors = scopes.filter(({ scope }) => scope.nameLine === symbol.startLine && scope.nameColumn === symbol.startColumn);
    const header = atStart !== undefined && ((atStart.startLine === symbol.startLine && atStart.startColumn === symbol.startColumn) ||
      symbol.startLine < atStart.scope.nameLine || (symbol.startLine === atStart.scope.nameLine && symbol.startColumn <= atStart.scope.nameColumn));
    const scope = anchors.length === 1 ? anchors[0] : header ? atStart : undefined;
    const initializer = ["constant", "variable"].includes(symbol.kind) && !declarations.some((other) => other.id !== symbol.id && ["function", "method"].includes(other.kind) && other.startColumn !== undefined && other.endColumn !== undefined && containsPosition(other as PositionedBody, symbol.startLine, symbol.startColumn!));
    if (!BODY_KINDS.includes(symbol.kind) && scope === undefined && !initializer) return [];
    return [{ ...indexed, ...(scope === undefined ? {} : { ...scopeSpan(scope.scope), scope: scope.scope }) }];
  });
}

/** Assign inventory by exact position. An anonymous callback without an index node is charged to its enclosing body. */
export function callsByOwner(calls: readonly SyntaxCall[], declarations: readonly GraphSymbol[]): ReadonlyMap<GraphNodeId, readonly OwnedCall[]> {
  const found = new Map<GraphNodeId, OwnedCall[]>();
  const bodies = positionedBodies(declarations, calls);
  for (const call of calls) {
    const eligible = bodies.filter((body) => body.scope === undefined || call.owners.some((scope) => scopeKey(scope) === scopeKey(body.scope!)));
    const owner = owningBodyAt(eligible, call.line, call.column - 1);
    const possible = owner === undefined ? declarations.filter((symbol) => BODY_KINDS.includes(symbol.kind) &&
      ((symbol.startLine <= call.line && call.line <= symbol.endLine) || call.owners.some((scope) => scope.start <= symbol.startLine && symbol.startLine <= scope.endLine))) : [owner];
    for (const body of possible) found.set(body.id, [...found.get(body.id) ?? [], owner === undefined ? { ...call, ambiguous: true } : call]);
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
