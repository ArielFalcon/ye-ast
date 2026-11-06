import { isSeedable } from "../../domain/change/seeds.ts";
import { CALL_EDGE_KINDS, FIELD_KINDS, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import { declarationAnchor, placeAt, referenceKey } from "../../domain/impact/impact-cuts.ts";
import { NOT_DECLARED_KINDS, sortedUnique } from "../../domain/impact/importers-fact.ts";
import { branchesOf, declarationPath } from "../../domain/shared/declaration-tree.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import { calleeOf, compareOccurrence, ownMemberOf, receiverOf, sameOccurrence, type EdgeOccurrence, type OrderedPlace } from "../../domain/trace/call-place.ts";
import type { TraceVia } from "../../domain/trace/trace-fact.ts";
import type { ExternalCall, TraceDeclaration, WalkedStep } from "../../domain/trace/trace-tree.ts";
import type { DeclaredCallable, DeclaredMemberNames, FunctionValueCall } from "../../ports/declared-member-names.port.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOriginSite, ImportOrigins } from "../../ports/import-origins.port.ts";
import type { TraceBudget } from "../../ports/trace-queries.port.ts";
import { createGraphNavigation, SUPERTYPE_EDGES } from "../navigation/graph-navigation.ts";
import { containmentTree } from "../navigation/containment-tree.ts";
import { edgesRootedOutside, type EdgeWithEnds } from "../navigation/rooted-edges.ts";

/** What a body passes as a value runs later, if at all; only code can. */
const DEFERRED_KINDS: readonly string[] = ["function", "method"];

/** Kinds that name a type and never a value, so a call through a member of that name cannot reach them. */
const TYPE_ONLY_KINDS: readonly string[] = ["interface", "type_alias"];

/** Declarations a supertype reference can name. */
const TYPE_KINDS: readonly string[] = ["class", "interface", "component"];

/** Declarations whose syntax says whether they have a body and whether a subtype can override them. */
const CALLABLE_KINDS: readonly string[] = ["method", "function"];

/** Types whose methods have bodies, so a root of one of them runs what its members run. */
const CLASS_KINDS: readonly string[] = ["class", "component"];

/** What a trace can start from: what an impact walk seeds, or a property or field whose initializer makes calls. */
export function isTraceRoot(store: CodeGraphReader): (symbol: GraphSymbol) => boolean {
  return (symbol) =>
    isSeedable(symbol) ||
    ((FIELD_KINDS as readonly string[]).includes(symbol.kind) &&
      (callEdgesOf(store, symbol).length > 0 || store.unresolvedReferences([symbol.file]).some((reference) => reference.from === symbol.id && CALL_EDGE_KINDS.includes(reference.kind))));
}

function callEdgesOf(store: CodeGraphReader, symbol: GraphSymbol) {
  return store.outgoingEdges([symbol.id], CALL_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge));
}

export interface TraceWalkInput {
  store: CodeGraphReader;
  origins: ImportOrigins;
  /** Whether a path is inside the declared scope: a declaration outside it cannot make a call repository code. */
  inScope: (path: string) => boolean;
  /**
   * The in-scope sources that declare each member name in a value position, by name, sorted; read when R6 first needs it.
   * The index holds no node for some of those declarations (an object-literal key outside a top-level initializer, a
   * record component), so a name only they declare still runs repository code.
   */
  memberDeclarations: () => Promise<ReadonlyMap<string, readonly string[]>>;
  /**
   * What a source's syntax states, read once per file: its callables, for each method the walk expands, and the member
   * calls whose receiver it binds to a function value, for a member call R6 reaches.
   */
  syntaxOf: (file: string) => Promise<DeclaredMemberNames>;
  budget: TraceBudget;
  signal?: AbortSignal;
}

export interface TraceWalk {
  /** One per root, in the order given. */
  roots: readonly WalkedStep[];
  cuts: readonly Cut[];
  expanded: number;
}

interface Child {
  symbol: GraphSymbol;
  place: OrderedPlace;
  via: TraceVia;
  deferred?: true;
}

interface Body {
  children: Child[];
  external: ExternalCall[];
  cuts: Cut[];
}

/**
 * Outbound from the roots in one depth-first pre-order traversal, which alone decides depth, the expansions charge, cuts
 * and `seen`: a declaration is expanded at its first occurrence within the bounds, and an occurrence a bound stops is a
 * cut that leaves it free to expand at a later, shallower one. Every read is cached for this walk only.
 */
export async function walkTrace(roots: readonly GraphSymbol[], input: TraceWalkInput): Promise<TraceWalk | "aborted"> {
  const { store, origins, inScope, memberDeclarations, syntaxOf, budget, signal } = input;
  const navigation = createGraphNavigation(store, () => false);

  const referencesByFile = new Map<string, ReadonlyMap<GraphNodeId, readonly GraphUnresolvedReference[]>>();
  const callsFrom = (node: GraphSymbol): readonly GraphUnresolvedReference[] => {
    let byNode = referencesByFile.get(node.file);
    if (byNode === undefined) {
      byNode = Map.groupBy(store.unresolvedReferences([node.file]).filter((reference) => CALL_EDGE_KINDS.includes(reference.kind)), (reference) => reference.from);
      referencesByFile.set(node.file, byNode);
    }
    const found = byNode.get(node.id) ?? [];
    return [...new Map(found.map((reference) => [referenceKey(reference) ?? reference, reference])).values()];
  };

  const namedCache = new Map<string, readonly GraphSymbol[]>();
  const declarationsNamed = (name: string): readonly GraphSymbol[] => {
    let named = namedCache.get(name);
    if (named === undefined) {
      named = store.declarationsNamed([name]).filter((symbol) => inScope(symbol.file) && !NOT_DECLARED_KINDS.includes(symbol.kind));
      namedCache.set(name, named);
    }
    return named;
  };

  /** What `x.<name>` can run: any declaration of that name a value can be, so only type-only kinds leave it out. */
  const membersNamed = (name: string): readonly GraphSymbol[] => declarationsNamed(name).filter((symbol) => !TYPE_ONLY_KINDS.includes(symbol.kind));

  const anchorOf = (symbol: GraphSymbol): string => declarationAnchor(symbol.file, symbol.name);

  const pathsByFile = new Map<string, ReadonlyMap<GraphNodeId, string>>();
  /** A candidate by its file and the dotted containment path the outline gives it, so two members of one name tell their owners apart. */
  const candidateOf = (symbol: GraphSymbol): string => {
    let paths = pathsByFile.get(symbol.file);
    if (paths === undefined) {
      paths = new Map(branchesOf(containmentTree(store, store.symbolsInFiles([symbol.file]))).map((branch) => [branch.declaration.id, declarationPath(branch)]));
      pathsByFile.set(symbol.file, paths);
    }
    return declarationAnchor(symbol.file, paths.get(symbol.id) ?? symbol.name);
  };
  /**
   * The place reads `<path>:<line> <spelling>`: the path is repository-relative and the line digits, so the first
   * `:<digits>` followed by a space ends the path, whatever spaces the path or the spelling hold; only a path that
   * itself holds `:<digits> ` reads differently.
   */
  /** A source's callables by name and its function-value calls by place, built once per file for the walk. */
  const syntaxIndexOf = memoizedBy((file: string) => file, async (file): Promise<SyntaxIndex> => {
    const { callables, functionValueCalls } = await syntaxOf(file);
    const byName = new Map<string, DeclaredCallable[]>();
    for (const callable of callables) byName.set(callable.name, [...(byName.get(callable.name) ?? []), callable]);
    return { callables: byName, functionValueCalls: new Set(functionValueCalls.map(functionValueKey)) };
  });
  const unresolvedAt = (reference: GraphUnresolvedReference, declarations: readonly GraphSymbol[]): Cut => ({
    kind: "unresolved-link",
    at: [placeAt(reference.file, reference.line, reference.name), ...sortedUnique([...reference.candidates, ...declarations.map(candidateOf)])],
  });
  /**
   * The types a type extends or implements: the index's edges, and a parameterized supertype (`Port<T>`) the index left
   * unresolved, which names every type declaration of its raw name.
   */
  const supertypesOf = memoizedBy((type: GraphSymbol) => type.id, (type): readonly GraphSymbol[] => {
    const edges = store.outgoingEdges([type.id], SUPERTYPE_EDGES);
    navigation.load(edges.map((edge) => edge.target));
    const parameterized = store
      .unresolvedReferences([type.file])
      .filter((reference) => reference.from === type.id && SUPERTYPE_EDGES.includes(reference.kind) && reference.name.includes("<"))
      .flatMap((reference) => store.declarationsNamed([rawTypeName(reference.name)]).filter((declared) => TYPE_KINDS.includes(declared.kind)));
    return [...edges.flatMap((edge) => navigation.symbolOf(edge.target) ?? []), ...parameterized];
  });
  /** Every type above `type`, through any number of supertypes. */
  const ancestorsOf = memoizedBy((type: GraphSymbol) => type.id, (type): ReadonlySet<GraphNodeId> => {
    const above = new Set<GraphNodeId>();
    for (let frontier = [type]; frontier.length > 0; ) {
      frontier = frontier.flatMap(supertypesOf).filter((next) => next.id !== type.id && !above.has(next.id));
      for (const next of frontier) above.add(next.id);
    }
    return above;
  });
  const isBelow = (type: GraphSymbol, owners: ReadonlySet<GraphNodeId>): boolean => {
    const above = ancestorsOf(type);
    return [...owners].some((owner) => above.has(owner));
  };
  /** The methods of the same name that any type below `owners` declares: a re-declaration in an interface counts, since a body or a type below it may still replace the call. */
  const implementationsBelow = (symbol: GraphSymbol, owners: readonly GraphSymbol[]): GraphSymbol[] => {
    const ownerIds = new Set(owners.map((owner) => owner.id));
    return store
      .declarationsNamed([symbol.name])
      .filter((method) => method.kind === "method" && navigation.ownersOf(method).some((type) => !ownerIds.has(type.id) && isBelow(type, ownerIds)));
  };
  const dispatchCut = (symbol: GraphSymbol, implementations: readonly GraphSymbol[]): Cut => ({
    kind: "unresolved-link",
    at: [placeAt(symbol.file, symbol.startLine, symbol.name), ...sortedUnique(implementations.map(candidateOf))],
  });
  /**
   * What dispatch may run instead of the body the walk reads, from the declaration's own syntax: a body-less callable
   * runs whatever implements it, so it is a cut listing every declaration of its name below its owners, or none; a
   * static, private or final one with a body runs it; an overridable one with a body is a cut only when a type below its
   * owner declares its name, listing those declarations. A declaration its syntax does not state is a cut when an
   * interface owns it.
   */
  const unboundDispatch = async (symbol: GraphSymbol): Promise<Cut | undefined> => {
    if (!CALLABLE_KINDS.includes(symbol.kind)) return undefined;
    const declared = (await syntaxIndexOf(symbol.file)).callables.get(symbol.name)?.find(({ start, nameLine }) => start <= symbol.startLine && symbol.startLine <= nameLine);
    const owners = navigation.ownersOf(symbol);
    if (declared === undefined) {
      const interfaces = owners.filter((owner) => owner.kind === "interface");
      return interfaces.length === 0 ? undefined : dispatchCut(symbol, implementationsBelow(symbol, interfaces));
    }
    if (!declared.body) return dispatchCut(symbol, implementationsBelow(symbol, owners));
    if (!declared.overridable) return undefined;
    const overriders = implementationsBelow(symbol, owners);
    return overriders.length === 0 ? undefined : dispatchCut(symbol, overriders);
  };
  /** Whether the call's own source binds its receiver to a function value, which a library member such as `call` runs. */
  const holdsFunctionValue = async (reference: GraphUnresolvedReference, receiver: string, member: string): Promise<boolean> =>
    (await syntaxIndexOf(reference.file)).functionValueCalls.has(functionValueKey({ line: reference.line, receiver, member }));
  const childAt = (symbol: GraphSymbol, line: number | null, column: number | null, spelling: string, via: TraceVia, deferred?: true): Child => ({
    symbol,
    place: { line, column, spelling, target: symbol.id },
    via,
    ...(deferred === undefined ? {} : { deferred }),
  });

  /** The members of a class root that run code, by their declaration: methods, and properties or fields whose initializer makes calls. */
  const membersOf = (node: GraphSymbol): Child[] => {
    if (!CLASS_KINDS.includes(node.kind)) return [];
    const contains = store.outgoingEdges([node.id], ["contains"]);
    navigation.load(contains.map((edge) => edge.target));
    return contains
      .flatMap((edge) => navigation.symbolOf(edge.target) ?? [])
      .filter((member) => member.kind === "method" || ((FIELD_KINDS as readonly string[]).includes(member.kind) && (callEdgesOf(store, member).length > 0 || callsFrom(member).length > 0)))
      .map((member) => childAt(member, member.startLine, null, member.name, "member"));
  };

  async function bodyOf(node: GraphSymbol, root: boolean): Promise<Body> {
    const calls = callEdgesOf(store, node);
    const values = store.outgoingEdges([node.id], ["references"]);
    navigation.load([...calls, ...values].map((edge) => edge.target));
    const withEnds = (edges: readonly GraphEdge[]): EdgeWithEnds[] => edges.flatMap((edge) => {
      const target = navigation.symbolOf(edge.target);
      return target === undefined ? [] : [{ edge, source: node, target }];
    });
    const called = withEnds(calls);
    const passed = withEnds(values).filter(({ target }) => DEFERRED_KINDS.includes(target.kind));
    const outside = await edgesRootedOutside(origins, [...called, ...passed], signal);
    const followed = (edge: EdgeWithEnds): boolean => !outside.some((dropped) => dropped.edge === edge);
    const external: ExternalCall[] = outside.map(({ edge, origin }) => (origin.kind === "external" ? { kind: "import", module: origin.module, name: edge.target.name } : { kind: "global", name: edge.target.name }));
    const children: Child[] = root ? membersOf(node) : [];
    const resolved: EdgeOccurrence[] = called.map(({ edge, target }) => ({ source: edge.source, line: edge.line, column: edge.column, targetName: target.name }));
    for (const { edge, target } of called.filter(followed)) children.push(childAt(target, edge.line, edge.column, target.name, "call"));
    for (const { edge, target } of passed.filter(followed)) children.push(childAt(target, edge.line, edge.column, target.name, "reference", true));

    const cuts: Cut[] = [];
    const bare: { reference: GraphUnresolvedReference; name: string }[] = [];
    for (const reference of callsFrom(node).filter((candidate) => !resolved.some((edge) => sameOccurrence(edge, candidate)))) {
      const own = ownMemberOf(reference.name);
      const members = own === undefined ? [] : [...new Map(navigation.ownersOf(node).flatMap((owner) => navigation.methodsOf(owner)).filter((method) => method.name === own).map((method) => [method.id, method])).values()];
      if (members.length === 1) children.push(childAt(members[0]!, reference.line, reference.column, reference.name, "own-member"));
      else if (members.length > 1) cuts.push(unresolvedAt(reference, members));
      else {
        const callee = calleeOf(reference.name);
        if (callee.form === "computed") cuts.push(unresolvedAt(reference, []));
        else if (callee.form === "bare") bare.push({ reference, name: callee.name });
        else {
          const named = membersNamed(callee.name);
          if (named.length > 0) cuts.push(unresolvedAt(reference, named));
          else {
            const receiver = receiverOf(reference.name);
            const declared = [
              ...((await memberDeclarations()).get(callee.name) ?? []).map((file) => declarationAnchor(file, callee.name)),
              ...(receiver !== undefined && (await holdsFunctionValue(reference, receiver, callee.name)) ? [declarationAnchor(reference.file, receiver)] : []),
            ];
            if (declared.length === 0) external.push({ kind: "unnamed", name: reference.name });
            else cuts.push({ kind: "unresolved-link", at: [placeAt(reference.file, reference.line, reference.name), ...sortedUnique([...reference.candidates, ...declared])] });
          }
        }
      }
    }
    if (bare.length > 0) {
      const sites = bare.map(({ reference, name }): ImportOriginSite => ({ file: reference.file, line: reference.line, column: reference.column + 1, name, fullName: reference.name, kind: reference.kind }));
      const findings = await origins.origins(sites, signal);
      for (const [index, { reference, name }] of bare.entries()) {
        const finding = findings[index];
        const origin = finding?.status === "complete" && finding.occurrence === true ? finding.value : undefined;
        if (origin?.kind === "external") external.push({ kind: "import", module: origin.module, name: reference.name });
        else if (origin?.kind === "ambient") external.push({ kind: "global", name: reference.name });
        else cuts.push(unresolvedAt(reference, declarationsNamed(name)));
      }
    }
    return { children: children.sort((a, b) => compareOccurrence(a.place, b.place)), external, cuts };
  }

  const expandedAt = new Map<GraphNodeId, WalkedStep>();
  const rootExpansions = new Set<WalkedStep>();
  const stopped = { depth: new Set<string>(), expansions: new Set<string>() };
  const cuts: Cut[] = [];
  let expansions = 0;

  async function visit(step: WalkedStep, symbol: GraphSymbol, depth: number): Promise<void> {
    if (signal?.aborted) return;
    if (runsValue(step, symbol)) {
      step.unsettled = true;
      cuts.push({ kind: "unresolved-link", at: [placeAt(symbol.file, symbol.startLine, symbol.name)] });
      return;
    }
    const first = expandedAt.get(symbol.id);
    /** A class root also owes its members, which no expansion below a root made. */
    const owesMembers = depth === 0 && CLASS_KINDS.includes(symbol.kind) && (first === undefined || !rootExpansions.has(first));
    if (first !== undefined && !owesMembers) {
      step.seen = first;
      return;
    }
    if (budget.depth !== undefined && depth >= budget.depth) {
      stopped.depth.add(anchorOf(symbol));
      return;
    }
    if (budget.expansions !== undefined && expansions >= budget.expansions) {
      stopped.expansions.add(anchorOf(symbol));
      return;
    }
    expansions += 1;
    if (first === undefined) expandedAt.set(symbol.id, step);
    if (depth === 0) rootExpansions.add(step);
    step.expanded = true;
    const body = await bodyOf(symbol, depth === 0);
    const dispatch = await unboundDispatch(symbol);
    if (dispatch !== undefined) body.cuts.push(dispatch);
    step.external = body.external;
    step.unsettled = body.cuts.length > 0;
    cuts.push(...body.cuts);
    for (const child of body.children) {
      const { line, column } = child.place;
      const walked = stepOf(child.symbol, {
        ...(line === null || child.via === "member" ? {} : { at: { line, ...(column === null ? {} : { column: column + 1 }) } }),
        via: child.via,
        ...(child.deferred === undefined ? {} : { deferred: child.deferred }),
      });
      step.children.push(walked);
      await visit(walked, child.symbol, depth + 1);
    }
  }

  const walked: WalkedStep[] = [];
  for (const root of roots) {
    const step = stepOf(root, {});
    walked.push(step);
    await visit(step, root, 0);
  }
  if (signal?.aborted) return "aborted";
  const boundCuts = (kind: Cut["kind"], anchors: ReadonlySet<string>, limit: number | undefined): Cut[] => [...anchors].sort().map((anchor): Cut => ({ kind, at: [anchor], limit: limit as number }));
  return {
    roots: walked,
    cuts: [...cuts, ...boundCuts("depth", stopped.depth, budget.depth), ...boundCuts("caller-budget", stopped.expansions, budget.expansions)],
    expanded: expansions,
  };
}

/** `Port` for `Port<T>` and for `pkg.Port<T>`. */
interface SyntaxIndex {
  callables: ReadonlyMap<string, readonly DeclaredCallable[]>;
  functionValueCalls: ReadonlySet<string>;
}

function functionValueKey({ line, receiver, member }: FunctionValueCall): string {
  return `${line}:${receiver}.${member}`;
}

/** `derive`, computed once per key for the life of one walk. */
function memoizedBy<A, K, V>(keyOf: (argument: A) => K, derive: (argument: A) => V): (argument: A) => V {
  const known = new Map<K, V>();
  return (argument) => {
    const key = keyOf(argument);
    if (!known.has(key)) known.set(key, derive(argument));
    return known.get(key)!;
  };
}

function rawTypeName(name: string): string {
  return name.slice(0, name.indexOf("<")).split(".").at(-1)!;
}

/** A call that reaches a property or field runs the value it holds, which its initializer built at construction. */
function runsValue(step: WalkedStep, symbol: GraphSymbol): boolean {
  return (step.via === "call" || step.via === "own-member") && (FIELD_KINDS as readonly string[]).includes(symbol.kind);
}

function declarationOf(symbol: GraphSymbol): TraceDeclaration {
  return { key: symbol.id, file: symbol.file, symbol: symbol.name, kind: symbol.kind, start: symbol.startLine, end: symbol.endLine };
}

function stepOf(symbol: GraphSymbol, occurrence: Pick<WalkedStep, "at" | "via" | "deferred">): WalkedStep {
  return { declaration: declarationOf(symbol), ...occurrence, expanded: false, unsettled: false, children: [], external: [] };
}
