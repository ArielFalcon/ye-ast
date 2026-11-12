import { calleeOf, countedAlike, normalizedSpelling, receiverRootOf } from "../../domain/shared/call-place.ts";
import { CALL_EDGE_KINDS, holdsValue, isClassKind, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import { comparePositions, containsPosition, declarationSpan, executesInBody, owningBody, type SourceSpan } from "../../domain/shared/owning-body.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames, SyntaxCall } from "../../ports/declared-member-names.port.ts";
import type { DeclarationUses } from "./declaration-uses.ts";
import type { FollowedEdge } from "./edge-targets.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DeclarationModel, ModelDeclaration } from "./declaration-model.ts";

type SyntaxScope = SyntaxCall["owners"][number];
type PositionedBody = ModelDeclaration & SourceSpan & { key: string; scope?: SyntaxScope };
export type OwnedCall = SyntaxCall & { ambiguous?: true; deferred?: true };
const BODY_KINDS: readonly string[] = ["function", "method", "class", "component", "property", "field"];
const scopeSpan = (scope: SyntaxScope): SourceSpan => ({ start: { line: scope.start, column: scope.startColumn }, end: { line: scope.endLine, column: scope.endColumn } });
const spanKey = (span: SourceSpan): string => `${span.start.line}:${span.start.column}:${span.end.line}:${span.end.column}`;
const scopeKey = (scope: SyntaxScope): string => spanKey(scopeSpan(scope));

function positionedBodies(declarations: readonly ModelDeclaration[], calls: readonly SyntaxCall[]): PositionedBody[] {
  const scopes = [...new Map(calls.flatMap((call) => call.owners).map((scope) => [scopeKey(scope), { ...scopeSpan(scope), scope }])).values()];
  return declarations.flatMap((symbol): PositionedBody[] => {
    if (symbol.kind === "object") return [];
    if (symbol.symbol !== undefined && !BODY_KINDS.includes(symbol.kind) && !holdsValue(symbol.kind)) return [];
    const indexed = { ...symbol, key: symbol.symbol?.id ?? symbol.id, ...declarationSpan(symbol) };
    const atStart = owningBody(scopes, { line: symbol.startLine, column: symbol.startColumn });
    const anchors = scopes.filter(({ scope }) => scope.nameLine === symbol.startLine && scope.nameColumn === symbol.startColumn);
    const header = atStart !== undefined && ((atStart.start.line === symbol.startLine && atStart.start.column === symbol.startColumn) ||
      symbol.startLine < atStart.scope.nameLine || (symbol.startLine === atStart.scope.nameLine && symbol.startColumn <= atStart.scope.nameColumn));
    const scope = anchors.length === 1 ? anchors[0] : header ? atStart : symbol.kind === "class" ? classBodyScope(scopes, indexed) : undefined;
    const initializer = holdsValue(symbol.kind) && !declarations.some((other) => other.id !== symbol.id && ["function", "method"].includes(other.kind) && containsPosition(declarationSpan(other), { line: symbol.startLine, column: symbol.startColumn }));
    if (symbol.symbol !== undefined && !BODY_KINDS.includes(symbol.kind) && scope === undefined && !initializer) return [];
    return [{ ...indexed, ...(scope === undefined ? {} : { ...scopeSpan(scope.scope), scope: scope.scope }) }];
  });
}

/**
 * The body of a class the index places at its construction (`new X() { ... }`): the one scope inside it that ends where it
 * ends, so the construction itself stays with the body that runs it.
 */
function classBodyScope<T extends SourceSpan>(scopes: readonly T[], indexed: SourceSpan): T | undefined {
  const inside = scopes.filter((scope) => comparePositions(indexed.start, scope.start) < 0 && comparePositions(scope.end, indexed.end) === 0);
  return inside.length === 1 ? inside[0] : undefined;
}

/**
 * Exact lexical ownership, with uninvoked function-value boundaries retained for reconciliation only. A call no body
 * encloses belongs to its file's top level.
 */
export function callsByOwner(calls: readonly SyntaxCall[], declarations: readonly ModelDeclaration[], functionValues: readonly SourceSpan[], topLevel?: GraphSymbol): ReadonlyMap<string, readonly OwnedCall[]> {
  const found = new Map<string, OwnedCall[]>();
  const bodies = positionedBodies(declarations, calls);
  for (const call of calls) {
    const scopeKeys = new Set(call.owners.map(scopeKey));
    const valuesInScope = functionValues.filter((value) => scopeKeys.has(spanKey(value)));
    const eligible = bodies.filter((body) => body.scope?.runsInEnclosingBody !== true && (body.scope === undefined || scopeKeys.has(scopeKey(body.scope))));
    const owner = owningBody(eligible, { line: call.line, column: call.column - 1 });
    const enclosing = owner === undefined ? declarations.filter((symbol) => BODY_KINDS.includes(symbol.kind) &&
      ((symbol.startLine <= call.line && call.line <= symbol.endLine) || call.owners.some((scope) => scope.start <= symbol.startLine && symbol.startLine <= scope.endLine))) : [];
    const sole = owner ?? (enclosing.length === 0 && topLevel !== undefined ? { ...topLevel, ...declarationSpan(topLevel) } : undefined);
    if (sole !== undefined) {
      const key = "key" in sole ? sole.key : sole.id;
      found.set(key, [...found.get(key) ?? [], executesInBody(sole, valuesInScope, { line: call.line, column: call.column - 1 }) ? call : { ...call, deferred: true }]);
    }
    else for (const body of enclosing) {
      const key = body.symbol?.id ?? body.id;
      found.set(key, [...found.get(key) ?? [], { ...call, ambiguous: true }]);
    }
  }
  return found;
}

/** What alignment reads of an index record that names a call: a call edge whose target the store holds, or an unresolved call reference. */
interface CallRecord {
  node: GraphSymbol;
  line: number | null;
  column: number | null;
  name: string;
  synthesized: boolean;
  /** The local names the file's imports bind to the edge's target, which a call may spell instead of its name. */
  aliases: () => readonly string[];
}

/** What alignment decided for a record: at a written call, in `body`, as the index has it, or contradicted by its source. */
type Alignment = { kind: "matched"; call: SyntaxCall; deferred: boolean; body: GraphSymbol } | { kind: "kept" } | { kind: "contradicted" };

const callKey = (call: SyntaxCall): string => `${call.kind}:${call.line}:${call.column}:${call.name}`;

/**
 * The written calls a record is compared with: those at its line and column, or at an anchor the reader lists there, or,
 * when the record has no column or its column lies past its line's first character outside ASCII, those on its line.
 */
function callsAtPlace(calls: readonly SyntaxCall[], { line, column }: CallRecord, text: string | undefined): readonly SyntaxCall[] {
  if (column === null || !Number.isFinite(column) || !countedAlike(column, text ?? "")) return calls.filter((call) => call.line === line);
  const primary = calls.filter((call) => call.line === line && call.column - 1 === column);
  return primary.length > 0 ? primary : calls.filter((call) => call.anchors?.some((anchor) => anchor.line === line && anchor.column - 1 === column));
}

/**
 * The written calls at a record's place that agree with its name: those spelled as the record, before or after
 * normalization, or else those whose callee is the record's last name. More than one is undecidable.
 */
function agreeingCalls(at: readonly SyntaxCall[], { name, aliases }: CallRecord): readonly SyntaxCall[] {
  const normalized = normalizedSpelling(name);
  const spelled = at.filter((call) => call.name === name || normalizedSpelling(call.name) === normalized);
  if (spelled.length > 0) return spelled;
  const callee = calleeOf(name);
  const named = callee.form === "computed" ? [] : at.filter((call) => call.callee === callee.name);
  return named.length > 0 ? named : at.filter((call) => call.callee !== undefined && aliases().includes(call.callee));
}

/** A call record the file's source contradicts, with the target the index held for an edge. */
export interface ContradictedRecord {
  record: GraphUnresolvedReference;
  target?: GraphSymbol;
}

/**
 * A body's call-bearing records aligned with the calls its file writes (ADR-0041 decision 3). A record keeps the index's
 * place when its source is unread, its edge is synthesized, it matches a deferred call, it names the receiver a written
 * call starts from, or more than one written call agrees with it; it is contradicted when it names a line and a column and
 * no written call of its file at its place agrees with it; otherwise it is at its written call, in the body the index
 * gives it.
 */
export interface BodyCalls {
  /** The body's call edges whose target the store holds and no policy ignores, in the store's order. */
  edges: readonly FollowedEdge[];
  /** The body's unresolved call references, in the store's order. */
  references: readonly GraphUnresolvedReference[];
  /** Records placed where the file writes no call they name, with the edge's target: edges first, then references. */
  contradicted: readonly ContradictedRecord[];
  /** Calls the body writes and runs that no record matches, in written order. */
  writtenOnly: readonly GraphUnresolvedReference[];
  /** Calls written where no single index body owns them and no record matches, in written order. */
  ambiguous: readonly GraphUnresolvedReference[];
  /** Calls the body writes inside a function value it does not run that no record matches, in written order. */
  deferredOnly: readonly GraphUnresolvedReference[];
}

/** The one owner of what a body calls: the index's call-bearing records aligned with the written calls, per snapshot read. */
export interface ReconciledCalls {
  callsOf(body: GraphSymbol): Promise<BodyCalls>;
  /** Every call record of `file` the source contradicts, in the store's order. */
  contradictedIn(file: string): Promise<readonly ContradictedRecord[]>;
  /** The written calls of `file` by their model body key: index handle when available, syntax identity otherwise. */
  ownedIn(file: string): Promise<ReadonlyMap<string, readonly OwnedCall[]>>;
}

export interface ReconciledCallsInput {
  declarations: DeclarationModel;
  store: CodeGraphReader;
  uses: DeclarationUses;
  syntaxOf: (file: string) => Promise<DeclaredMemberNames>;
  /** A line of a source, to tell where two parsers stop counting columns alike. */
  lineOf: (file: string, line: number) => string | undefined;
  /** Per local name a file's imports bind, the declaration the join proves it reaches; none without it. */
  importedDeclarations?: ((file: string) => Promise<ReadonlyMap<string, GraphSymbol>>) | undefined;
}

/** The call edges of `symbol` no policy ignores. */
export function callEdgesOf(store: CodeGraphReader, symbol: GraphSymbol): GraphEdge[] {
  return store.outgoingEdges([symbol.id], CALL_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge));
}

/** The `references` edges of `symbol`: the declarations its body names as values, which it may pass to run later. */
export function valueEdgesOf(store: CodeGraphReader, symbol: GraphSymbol): readonly GraphEdge[] {
  return store.outgoingEdges([symbol.id], ["references"]);
}

const NO_CALLS: BodyCalls = { edges: [], references: [], contradicted: [], writtenOnly: [], ambiguous: [], deferredOnly: [] };

export function createReconciledCalls({ store, uses, syntaxOf, lineOf, importedDeclarations, declarations }: ReconciledCallsInput): ReconciledCalls {
  const ownedIn = oncePerFile(async (file) => {
    const syntax = await syntaxOf(file);
    return callsByOwner(syntax.calls ?? [], await declarations.list(file), syntax.functionValues, store.symbolsInFiles([file]).find(({ kind }) => kind === "file"));
  });
  const alignedIn = oncePerFile(async (file): Promise<ReadonlyMap<GraphNodeId, BodyCalls>> => {
    const syntax = await syntaxOf(file);
    const owned = await ownedIn(file);
    const bodies = store.symbolsInFiles([file]).map((node) => ({ node, edges: uses.followed(node, callEdgesOf(store, node)), references: uses.referencesFrom(node, CALL_EDGE_KINDS) }));
    let imported: ReadonlyMap<string, GraphSymbol> | undefined;
    let consulted = false;
    const aliasesOf = (target: GraphSymbol) => (): string[] => {
      consulted = true;
      return [...(imported ?? [])].flatMap(([local, declaration]) => (declaration.id === target.id && local !== target.name ? [local] : []));
    };
    const records = bodies.flatMap(({ node, edges, references }): CallRecord[] => [
      ...edges.map(({ edge, target }) => ({ node, line: edge.line, column: edge.column, name: target.name, synthesized: edge.synthesizedBy !== null, aliases: aliasesOf(target) })),
      ...references.map(({ line, column, name }) => ({ node, line, column, name, synthesized: false, aliases: () => [] })),
    ]);
    const align = () => alignRecords(records, syntax, owned, store.symbolsInFiles([file]), (line) => lineOf(file, line));
    let aligned = align();
    if (consulted && importedDeclarations !== undefined) {
      imported = await importedDeclarations(file);
      aligned = align();
    }
    const { alignments, accounted } = aligned;
    const placed = new Map(bodies.map(({ node }) => [node.id, { edges: [] as FollowedEdge[], references: [] as GraphUnresolvedReference[], contradicted: [] as BodyCalls["contradicted"][number][] }]));
    let next = 0;
    for (const { node, edges, references } of bodies) {
      for (const followed of edges) {
        const alignment = alignments[next++]!;
        const { edge, target } = followed;
        if (alignment.kind === "contradicted") placed.get(node.id)!.contradicted.push({ record: { from: node.id, file: node.file, line: edge.line!, column: edge.column!, name: target.name, kind: edge.kind, candidates: [] }, target });
        else if (alignment.kind === "kept") placed.get(node.id)!.edges.push(followed);
        else placed.get(alignment.body.id)!.edges.push(alignment.deferred ? followed : { ...followed, source: alignment.body, edge: { ...edge, source: alignment.body.id, line: alignment.call.line, column: alignment.call.column - 1 } });
      }
      for (const reference of references) {
        const alignment = alignments[next++]!;
        if (alignment.kind === "contradicted") placed.get(node.id)!.contradicted.push({ record: reference });
        else if (alignment.kind === "kept") placed.get(node.id)!.references.push(reference);
        else placed.get(alignment.body.id)!.references.push(alignment.deferred ? reference : { ...reference, from: alignment.body.id, line: alignment.call.line, column: alignment.call.column - 1 });
      }
    }
    return new Map(bodies.map(({ node }) => {
      const writtenOnly: GraphUnresolvedReference[] = [];
      const ambiguous: GraphUnresolvedReference[] = [];
      const deferredOnly: GraphUnresolvedReference[] = [];
      for (const call of owned.get(node.id) ?? []) {
        if (accounted.has(callKey(call))) continue;
        const reference = { from: node.id, file: node.file, line: call.line, column: call.column - 1, name: call.name, kind: call.kind, candidates: [] };
        (call.deferred ? deferredOnly : call.ambiguous ? ambiguous : writtenOnly).push(reference);
      }
      return [node.id, { ...placed.get(node.id)!, writtenOnly, ambiguous, deferredOnly }];
    }));
  });
  return {
    ownedIn,
    async contradictedIn(file) {
      return [...(await alignedIn(file)).values()].flatMap(({ contradicted }) => contradicted);
    },
    async callsOf(node) {
      return (await alignedIn(node.file)).get(node.id) ?? NO_CALLS;
    },
  };
}

/**
 * Aligns a file's records with its written calls, in the records' order. A record stays in the body the index gives it
 * whichever body owns its call, except a source-proven enclosing execution or a record of the file's top level whose
 * call a class owns: a decorator and its arguments, which the class's declaration runs. A written call is accounted
 * when a record matches it or is undecided between it and others.
 */
function alignRecords(records: readonly CallRecord[], syntax: DeclaredMemberNames, owned: ReadonlyMap<string, readonly OwnedCall[]>, declarations: readonly GraphSymbol[], lineOf: (line: number) => string | undefined): { alignments: readonly Alignment[]; accounted: ReadonlySet<string> } {
  const accounted = new Set<string>();
  const classOwning = new Map(declarations.flatMap((body) => isClassKind(body.kind) ? (owned.get(body.id) ?? []).filter((call) => !call.ambiguous).map((call) => [callKey(call), body] as const) : []));
  const enclosingExecutions = new Map(declarations.flatMap((body) => (owned.get(body.id) ?? []).filter((call) => !call.ambiguous && call.owners.some((scope) => scope.runsInEnclosingBody)).map((call) => [callKey(call), body] as const)));
  const { calls } = syntax;
  const alignments = records.map((record): Alignment => {
    if (calls === undefined || record.synthesized) return { kind: "kept" };
    const at = callsAtPlace(calls, record, record.line === null ? undefined : lineOf(record.line));
    const agreeing = agreeingCalls(at, record);
    for (const call of agreeing) accounted.add(callKey(call));
    const [call] = agreeing;
    if (call !== undefined && agreeing.length === 1) {
      const body = enclosingExecutions.get(callKey(call)) ?? (record.node.kind === "file" ? classOwning.get(callKey(call)) : undefined) ?? record.node;
      const own = owned.get(body.id)?.find((candidate) => callKey(candidate) === callKey(call));
      return { kind: "matched", call, body, deferred: own !== undefined ? own.deferred === true : !executesInBody(declarationSpan(body), syntax.functionValues, { line: call.line, column: call.column - 1 }) };
    }
    const receiver = at.some((written) => receiverRootOf(written.name) === record.name);
    return agreeing.length > 1 || receiver || !alignable(record) ? { kind: "kept" } : { kind: "contradicted" };
  });
  return { alignments, accounted };
}

/** Whether a record names a place that can contradict a written call: a line and a column, both in range. */
function alignable({ line, column }: Pick<CallRecord, "line" | "column">): boolean {
  return line !== null && Number.isInteger(line) && line >= 1 && column !== null && Number.isInteger(column) && column >= 0;
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

/** A line of a source, splitting each source once for the life of one query. */
export function linesOncePerFile(sources: ReadonlyMap<string, SourceFile>): (file: string, line: number) => string | undefined {
  const split = new Map<string, readonly string[]>();
  return (file, line) => {
    let lines = split.get(file);
    if (lines === undefined) {
      lines = sources.get(file)?.content.split("\n") ?? [];
      split.set(file, lines);
    }
    return lines[line - 1];
  };
}
