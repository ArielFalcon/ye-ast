import { isSeedable } from "../../domain/change/seeds.ts";
import { mayRunDeclarationOf } from "../../domain/languages/call-targets.ts";
import { CALL_EDGE_KINDS, EDGE_POLICY, FIELD_KINDS, isClassKind } from "../../domain/impact/edge-policy.ts";
import { declarationAnchor, placeAt } from "../../domain/impact/impact-cuts.ts";
import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import { branchesOf, declarationPath } from "../../domain/shared/declaration-tree.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import { boundCut, distinctEvidence, type Evidence, type Cut, type CutReason, type CutSubReason } from "../../domain/shared/fact.ts";
import { calleeOf, compactSpelling, compareOccurrence, receiverOf, type OrderedPlace } from "../../domain/shared/call-place.ts";
import type { TraceVia } from "../../domain/trace/trace-fact.ts";
import type { ExternalCall, TraceDeclaration, WalkedStep } from "../../domain/trace/trace-tree.ts";
import type { DeclaredCallable, DeclaredMemberNames, FunctionValueCall, ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DeclaredType, DispatchTargets, ImportOrigins, ReceiverMethod, ReplacedRoots, ResolvedNameSite } from "../../ports/import-origins.port.ts";
import type { TraceBudget } from "../../ports/trace-queries.port.ts";
import { createGraphNavigation, placedBetween, SUPERTYPE_EDGES } from "../navigation/graph-navigation.ts";
import { containmentTree } from "../navigation/containment-tree.ts";
import type { EdgeTargets, FollowedEdge } from "../navigation/edge-targets.ts";
import type { CallPlace, ReceiverProof } from "../navigation/call-binder.ts";
import { unsettledBy, type DeclarationUses, type UnresolvedIn } from "../navigation/declaration-uses.ts";
import { callEdgesOf, valueEdgesOf, type ReconciledCalls } from "../navigation/reconciled-calls.ts";
import type { CallBinding, CallBindings, DeclaredBinding } from "../navigation/call-binding.ts";
import { indexedDeclaration, type ModelDeclaration } from "../navigation/declaration-model.ts";

type TraceNode = GraphSymbol | ModelDeclaration;

/** What a body passes as a value runs later, if at all; only code can. */
const DEFERRED_KINDS: readonly string[] = ["function", "method"];

/** Declarations a supertype reference can name. */
const TYPE_KINDS: readonly string[] = EDGE_POLICY.ownerKinds;

/** Declarations whose syntax says whether they have a body and whether a subtype can override them. */
const CALLABLE_KINDS: readonly string[] = ["method", "function"];


/** What a trace can start from: what an impact walk seeds, or a property or field whose initializer makes calls. */
export function isTraceRoot(store: CodeGraphReader, unresolvedIn: UnresolvedIn, syntaxCalls: ReadonlySet<GraphNodeId> = new Set()): (symbol: GraphSymbol) => boolean {
  return (symbol) =>
    isSeedable(symbol) ||
    ((FIELD_KINDS as readonly string[]).includes(symbol.kind) &&
      (syntaxCalls.has(symbol.id) || callEdgesOf(store, symbol).length > 0 || unresolvedIn(symbol.file).some((reference) => reference.from === symbol.id && CALL_EDGE_KINDS.includes(reference.kind))));
}

export interface TraceWalkInput {
  store: CodeGraphReader;
  /** The query's one read of each file's unresolved references, shared with root selection. */
  unresolvedIn: UnresolvedIn;
  origins: ImportOrigins;
  /** Where each resolved edge really points, judged by the one owner of that decision. */
  targets: EdgeTargets;
  /** What the calls the index left without a target bind to, through the targets' binder. */
  bindings: CallBindings;
  /** The uses of each declaration the walk reads. */
  uses: DeclarationUses;
  /** Each declaration's calls, the index's and the syntax's aligned. */
  reconciled: ReconciledCalls;
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
  /** The roots an entrypoint starts at, of which a class (a UI route's component) runs as a page (R9), and what a component runs as one; absent without such a root. */
  pages?: { roots: ReadonlySet<GraphNodeId>; of: (component: GraphSymbol) => Promise<PagePlan | undefined> };
  signal?: AbortSignal;
}

/** What a component runs as a page, beside its constructor and field initializers. */
export interface PagePlan {
  /** The members the framework calls itself, in the order it calls them. */
  lifecycle: readonly string[];
  /** What template rendering calls, in template text order. */
  render?: PagePlan["handlers"];
  /** What event bindings call, in template text order: an own method or the method a proof names. */
  handlers: readonly ({ file: string; line: number; column: number } & ({ member: string } | { runs: GraphSymbol }))[];
  /** The declarations its template uses, in template order. */
  children: readonly GraphSymbol[];
  cuts: readonly Cut[];
}

export interface TraceWalk {
  /** One per root, in the order given. */
  roots: readonly WalkedStep[];
  cuts: readonly Cut[];
  expanded: number;
  evidence: readonly Evidence[];
}

/**
 * What an external leaf names: a module, or the member path it calls from a global (none for a call nothing roots) and
 * the member. `open` when the call may run anything below its path. Beyond its path, the receiver may inherit the member
 * from any prototype: no syntax proves a receiver's whole prototype chain, so a write of the member on any prototype
 * replaces it.
 */
type LeafRoot = { module: string } | { path: readonly string[]; member: string; open?: true };

/** The leaf root of a call on an instance of a type from outside the repository: its module, or `<global>.prototype.<member>`. */
function rootOfHolds(holds: string, member: string): LeafRoot {
  const at = holds.lastIndexOf("#");
  const module = holds.slice(0, at);
  return module === "global" ? instanceOf(holds.slice(at + 1), member) : { module };
}

function instanceOf(global: string, member: string): LeafRoot {
  return { path: [global, "prototype", member], member };
}

/** Whether a written path covers a call's path: it names the call's path or a path above it, `*` for any name; `open` lets it lie below too. */
function covers(written: readonly string[], path: readonly string[], open = false): boolean {
  return (open || written.length <= path.length) && written.every((segment, index) => index >= path.length || segment === "*" || segment === path[index]);
}

/** A call's path from the global after any name that holds the global object itself. */
function fromGlobal(path: readonly string[], globalObjects: ReadonlySet<string>): readonly string[] {
  let start = 0;
  while (start < path.length - 1 && globalObjects.has(path[start]!)) start += 1;
  return path.slice(start);
}

/** A call on a type from outside the repository, `<module>#<name>`, is a leaf under its module; `global#<name>` is a global. */
function externalOf(holds: string, name: string): ExternalCall {
  const module = holds.slice(0, holds.lastIndexOf("#"));
  return module === "global" ? { kind: "global", name } : { kind: "import", module, name };
}

type Child = ({ symbol: GraphSymbol; declaration?: never } | { declaration: ModelDeclaration; symbol?: never }) & {
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
export async function walkTrace(roots: readonly TraceNode[], input: TraceWalkInput): Promise<TraceWalk | "aborted"> {
  const { store, unresolvedIn, origins, targets, bindings, uses, reconciled, inScope, memberDeclarations, syntaxOf, budget, pages, signal } = input;
  const binder = targets.binder;
  const navigation = createGraphNavigation(store, () => false);
  const callsFrom = (node: GraphSymbol): readonly GraphUnresolvedReference[] => uses.referencesFrom(node, CALL_EDGE_KINDS);

  /** The declarations of a name a call written in `from` may run. */
  const declarationsNamed = (name: string, from: string): readonly GraphSymbol[] => bindings.namedDeclarations(name, from);
  /** What `x.<name>` written in `from` can run: any declaration of that name a value can be, so only type-only kinds leave it out. */
  const membersNamed = (name: string, from: string): readonly GraphSymbol[] => bindings.namedDeclarations(name, from, true);

  const anchorOf = (symbol: TraceNode): string => declarationAnchor(symbol.file, symbol.name);

  const pathsByFile = new Map<string, ReadonlyMap<GraphNodeId, string>>();
  /** A candidate by its file and the dotted containment path the outline gives it, so two members of one name tell their owners apart. */
  const candidateOf = (symbol: GraphSymbol): string => {
    let paths = pathsByFile.get(symbol.file);
    if (paths === undefined) {
      paths = new Map(branchesOf(containmentTree(store, store.symbolsInFiles([symbol.file]))).map((branch) => [branch.declaration.id, declarationPath(branch)]));
      pathsByFile.set(symbol.file, paths);
    }
    const path = paths.get(symbol.id) ?? symbol.name;
    return [...paths.values()].filter((candidate) => candidate === path).length > 1
      ? placeAt(symbol.file, symbol.startLine, path)
      : declarationAnchor(symbol.file, path);
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
  let replacedRoots: Promise<ReplacedRoots> | undefined;
  /**
   * Whether the repository declares or writes a path that covers what an external leaf calls, writes the member on a
   * prototype the receiver may inherit, or writes through the leaf's package.
   */
  const isReplaced = async (root: LeafRoot): Promise<boolean> => {
    const { paths, globalObjects, packages } = await (replacedRoots ??= origins.replacedRoots(signal));
    if ("module" in root) return [...packages].some((name) => root.module === name || root.module.startsWith(`${name}/`));
    const path = fromGlobal(root.path, globalObjects);
    const onPrototype = (written: readonly string[]): boolean => (written.at(-2) === "prototype" || written.at(-2) === "*") && (written.at(-1) === "*" || written.at(-1) === root.member);
    return paths.some((written) => (path.length > 0 && covers(written, path, root.open)) || onPrototype(written));
  };
  /** The 1-based place a reference is written at, which the binder reads a call by. */
  const placeOf = (reference: GraphUnresolvedReference): CallPlace => ({ file: reference.file, line: reference.line, column: reference.column + 1 });
  /** What the binder proves the receiver of a member call holds; nothing without a binder. */
  const receiverAt = async (body: GraphSymbol, reference: GraphUnresolvedReference, member: string, receiver: string, spelling?: string): Promise<ReceiverProof> =>
    binder === undefined ? { link: "none" } : binder.receiverOf({ body, ...placeOf(reference), member, receiver, ...(spelling === undefined ? {} : { spelling }) });
  const unresolvedAt = (reference: GraphUnresolvedReference, declarations: readonly GraphSymbol[], reason?: CutReason, subReason?: CutSubReason): Cut =>
    callCut(placeAt(reference.file, reference.line, reference.name), sortedUnique([...reference.candidates, ...declarations.map(candidateOf)]), reason, subReason);
  /**
   * The types a type extends or implements: the index's edges, and a parameterized supertype (`Port<T>`) the index left
   * unresolved, which names every type declaration of its raw name.
   */
  const supertypesOf = memoizedBy((type: GraphSymbol) => type.id, (type): readonly GraphSymbol[] => {
    const edges = navigation.supertypeEdgesOf(type);
    const parameterized = unresolvedIn(type.file)
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
  const dispatchCut = (symbol: GraphSymbol, implementations: readonly GraphSymbol[], subReason: CutSubReason): Cut =>
    callCut(placeAt(symbol.file, symbol.startLine, symbol.name), sortedUnique(implementations.map(candidateOf)), "dispatch", subReason);
  /** Unresolved heritage may hide a runtime override, even when the binding identifies a declaration. */
  const executionProven = (type: GraphSymbol, member: string): boolean => {
    const lineage = new Set([type.id, ...ancestorsOf(type)]);
    return !store.declarationsNamed([member]).some((declared) => declared.kind === "method" && navigation.ownersOf(declared).some((owner) => !lineage.has(owner.id) && [owner, ...[...ancestorsOf(owner)].flatMap((id) => navigation.symbolOf(id) ?? [])].some((above) =>
      unresolvedIn(above.file).some((reference) => reference.from === above.id && SUPERTYPE_EDGES.includes(reference.kind) && !reference.name.includes("<")) ||
      navigation.supertypeEdgesOf(above).some((edge) => !TYPE_KINDS.includes(navigation.symbolOf(edge.target)?.kind ?? "")))));
  };
  /**
   * The method bodies the proof names, each the one method the index places there; none when one is not placed so.
   */
  const placedBodies = (targets: DispatchTargets): GraphSymbol[] | undefined => {
    if (targets.kind === "unknown") return undefined;
    const placed = targets.bodies.map((body) => placedMethod(body));
    return placed.every((symbol) => symbol !== undefined) ? placed : undefined;
  };
  /** A method a type variable's bound names proves the dependence, never what runs: trace holds it unproven (RFC-0013 R5). */
  const executed = (method: ReceiverMethod): ReceiverMethod => (method.kind === "method" && method.bound === true ? { kind: "unproven" } : method);
  /**
   * The one declaration of `kinds` the index places between a declaration's first token and its name. The index holds a
   * record's methods as functions of no container, so a proof of the method a call names accepts either kind.
   */
  const placedMethod = ({ file, start, nameLine }: Omit<Extract<ReceiverMethod, { kind: "method" }>, "kind">, kinds: readonly string[] = ["method"]): GraphSymbol | undefined => placedBetween(store, file, start, nameLine, kinds);
  /**
   * What dispatch may run instead of the body the walk reads, from the declaration's own syntax: a body-less callable
   * runs whatever implements it, so the sources' declared hierarchy names every body it may run (R7): one is expanded in
   * place, several are a cut listing them, and without that proof, or with no body, it is a cut listing every declaration
   * of its name below its owners, or none; a static, private or final one with a body runs it; an overridable one with a body is a cut
   * only when a type below its owner declares its name, listing those declarations. A declaration its syntax does not
   * state is a cut when an interface owns it.
   */
  const unboundDispatch = async (symbol: GraphSymbol): Promise<Dispatch | undefined> => {
    if (!CALLABLE_KINDS.includes(symbol.kind)) return undefined;
    const declared = (await syntaxIndexOf(symbol.file)).callables.get(symbol.name)?.find(({ start, nameLine }) => start <= symbol.startLine && symbol.startLine <= nameLine);
    const owners = navigation.ownersOf(symbol);
    if (declared === undefined) {
      const interfaces = owners.filter((owner) => owner.kind === "interface");
      return interfaces.length === 0 ? undefined : { cut: dispatchCut(symbol, implementationsBelow(symbol, interfaces), "unproven") };
    }
    if (!declared.body) {
      const [targets] = await origins.dispatchTargets([{ file: symbol.file, line: symbol.startLine, name: symbol.name }], signal);
      const bodies = targets === undefined ? undefined : placedBodies(targets);
      if (bodies === undefined || bodies.length === 0) return { cut: dispatchCut(symbol, implementationsBelow(symbol, owners), (targets?.kind === "unknown" ? targets.reason : undefined) ?? "unproven") };
      return bodies.length === 1 ? { to: bodies[0]!, alternatives: bodies } : { cut: dispatchCut(symbol, bodies, "several-bodies"), alternatives: bodies };
    }
    if (!declared.overridable) return undefined;
    const overriders = implementationsBelow(symbol, owners);
    return overriders.length === 0 ? undefined : { cut: dispatchCut(symbol, overriders, "overridable") };
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

  /** The constructors with a body that a class's syntax declares, as the index places them among its members. */
  const constructorsOf = async (type: GraphSymbol): Promise<GraphSymbol[]> => {
    const declarations = (await syntaxOf(type.file)).callables.filter((callable) => callable.construction && callable.body);
    return navigation.membersOf(type).filter((member) => declarations.some((declared) => declared.name === member.name && declared.start <= member.startLine && member.startLine <= declared.nameLine));
  };

  /** The members of a class root that run code, by their declaration: methods, and properties or fields whose initializer makes calls. */
  const membersOf = async (node: GraphSymbol, construction = false): Promise<Child[]> => {
    if (!isClassKind(node.kind)) return [];
    const syntax = await reconciled.ownedIn(node.file);
    const initializers = (await syntaxOf(node.file)).initializedFields ?? [];
    return navigation
      .membersOf(node)
      .filter((member) => {
        const field = (FIELD_KINDS as readonly string[]).includes(member.kind);
        if (construction) return field && initializers.some(initializer => initializer.name === member.name && initializer.start <= member.startLine && member.startLine <= initializer.nameLine);
        return member.kind === "method" || (field && (syntax.get(member.id)?.some((call) => !call.deferred) || callEdgesOf(store, member).length > 0 || callsFrom(member).length > 0));
      })
      .map((member) => childAt(member, member.startLine, null, member.name, "member"));
  };

  async function bodyOf(node: GraphSymbol, root: boolean): Promise<Body> {
    const values = valueEdgesOf(store, node);
    const syntax = await syntaxOf(node.file);
    const { edges: called, references: indexed, contradicted, writtenOnly: missing, ambiguous, deferredOnly } = await reconciled.callsOf(node);
    const passed = uses.followed(node, values).filter(({ target }) => DEFERRED_KINDS.includes(target.kind));
    const verdicts = await targets.verdictsOf([...called, ...passed], signal);
    const valueRoots = new Map(
      [...called, ...passed].flatMap(({ target }, index) => {
        const verdict = verdicts[index]!;
        return (verdict.kind === "keep" || verdict.kind === "redirect") && verdict.receiver !== undefined && ((FIELD_KINDS as readonly string[]).includes(target.kind) || target.kind === "function" || navigation.ownersOf(target).some((owner) => isClassKind(owner.kind))) ? [[index, verdict.receiver] as const] : [];
      }),
    );
    const external: ExternalCall[] = [];
    const children: Child[] = root ? await membersOf(node) : [];
    const construction = syntax.callables.some(callable => callable.construction && callable.start <= node.startLine && node.startLine <= callable.nameLine && callable.name === node.name);
    if (construction) {
      for (const owner of navigation.ownersOf(node)) {
        children.push(...await membersOf(owner, true));
      }
    }
    const cuts: Cut[] = contradicted.map(({ record, target }) => unresolvedAt(record, target === undefined ? [] : [target], "contradicted"));
    /** An external call is a leaf only while the repository writes nothing over what it names; otherwise `replaced` decides. */
    const leafUnlessReplaced = async (call: ExternalCall, root: LeafRoot, replaced: () => unknown): Promise<void> => {
      if (await isReplaced(root)) await replaced();
      else external.push(call);
    };
    /** The kept edges whose receiver a value holds (ADR-0029 decision 11), settled below by what proves it. */
    const unproven: { edge: GraphEdge; target: GraphSymbol; receiver: string }[] = [];
    for (const [index, { edge, target }] of [...called, ...passed].entries()) {
      const receiver = valueRoots.get(index);
      if (receiver !== undefined) unproven.push({ edge, target, receiver });
    }
    /**
     * A member call nothing settled by its receiver: a cut listing the declarations of its name, or, when no declaration and
     * no source names it and the repository replaces nothing the call was found to name, an external call (R6).
     */
    const settleByName = async (reference: GraphUnresolvedReference, name: string, named: readonly GraphSymbol[], replaced = false, subReason?: CutSubReason): Promise<void> => {
      if (named.length > 0) return void cuts.push(unresolvedAt(reference, named, undefined, subReason));
      const receiver = receiverOf(reference.name);
      const declared = [
        ...((await memberDeclarations()).get(name) ?? []).filter((file) => mayRunDeclarationOf(reference.file, file)).map((file) => declarationAnchor(file, name)),
        ...(receiver !== undefined && (await holdsFunctionValue(reference, receiver, name)) ? [declarationAnchor(reference.file, receiver)] : []),
      ];
      const cut = () => cuts.push(callCut(placeAt(reference.file, reference.line, reference.name), sortedUnique([...reference.candidates, ...declared]), undefined, subReason));
      if (declared.length === 0 && !replaced) await leafUnlessReplaced({ kind: "unnamed", name: reference.name }, { path: [], member: name }, cut);
      else cut();
    };
    /** Constructed receivers whose class the binder places in no repository declaration: a global's instance is a leaf. */
    const constructed: { reference: GraphUnresolvedReference; name: string; named: readonly GraphSymbol[]; holds: Extract<ReceiverBinding["holds"], { kind: "constructed" }> }[] = [];
    const annotated: { reference: GraphUnresolvedReference; name: string; named: readonly GraphSymbol[]; holds: Extract<ReceiverBinding["holds"], { kind: "annotated" }>; type: GraphSymbol | undefined; target: GraphSymbol | undefined; unspelled: boolean }[] = [];
    /** Member calls no other proof settles, which the type the sources declare the receiver to hold may (R3, R5). */
    const typed: { reference: GraphUnresolvedReference; name: string; named: readonly GraphSymbol[]; declared?: DeclaredBinding }[] = [];
    /**
     * The method `member` names on what a call returns, when the call is a resolved edge of this body whose own receiver
     * needs no proof and whose declaration states a nominal class as its return type, or the library or package type it
     * states, whose instance the repository does not hold (RFC-0013 R5).
     */
    const returnedMethod = async (head: Extract<ReceiverBinding["holds"], { kind: "returned" }>, member: string, reference: GraphUnresolvedReference): Promise<GraphSymbol | Extract<DeclaredType, { kind: "global" | "package" }> | undefined> => {
      const placed = called.flatMap(({ edge, target }, index) => {
        const verdict = verdicts[index]!;
        const at = edge.line === head.line && edge.column !== null && edge.column + 1 === head.column && target.name === head.name;
        return at && !valueRoots.has(index) && verdict.kind !== "drop" ? [verdict.kind === "redirect" ? verdict.to : target] : [];
      });
      const callee = placed.length === 1 ? placed[0]! : undefined;
      const returns = callee === undefined ? undefined : (await syntaxIndexOf(callee.file)).callables.get(callee.name)?.find(({ start, nameLine }) => start <= callee.startLine && callee.startLine <= nameLine)?.returns;
      if (callee === undefined || returns === undefined) return undefined;
      const [type] = await origins.declaredTypes([{ file: callee.file, line: returns.line, column: returns.column, spelled: returns.type, owner: { name: callee.name, line: callee.startLine, endLine: callee.endLine } }], signal);
      if (type?.kind === "global" || type?.kind === "package") return type;
      if (type?.kind !== "nominal") return undefined;
      const candidates = store.symbolsInFiles([type.file]).filter((symbol) => isClassKind(symbol.kind) && joinsFact(symbol, { path: type.file, line: type.line, symbol: type.name }));
      return candidates.length === 1 && executionProven(candidates[0]!, member) ? (await bindings.memberOfReceiver(candidates[0]!, member, placeOf(reference))).target : undefined;
    };
    /**
     * A member call settled by what the binder proves its receiver holds (ADR-0041 decision 4), narrowed by execution: a
     * receiver a provider may replace runs no proven class, and an annotation binds only a nominal class (ADR-0029
     * decision 11). `unproved` decides a call the binder proves nothing about.
     */
    const settleReceiver = async (reference: GraphUnresolvedReference, name: string, named: readonly GraphSymbol[], proof: ReceiverProof, target: GraphSymbol | undefined, returned: boolean, unproved: () => void, declaration?: ModelDeclaration): Promise<void> => {
      if (declaration !== undefined && !("replaceable" in proof && proof.replaceable)) {
        children.push({ declaration, place: { line: reference.line, column: reference.column, spelling: reference.name, target: declaration.id }, via: "call", ...(declaration.deferredFactory ? { deferred: true } : {}) });
        return;
      }
      const step = (method: GraphSymbol | undefined) => (method === undefined ? settleByName(reference, name, named) : void children.push(childAt(method, reference.line, reference.column, reference.name, "call")));
      const outside = (holds: string) => leafUnlessReplaced(externalOf(holds, reference.name), rootOfHolds(holds, name), () => settleByName(reference, name, named, true));
      if (proof.link === "member") return step(proof.method);
      if (proof.link === "external") return outside(proof.holds);
      if (proof.link === "field" || proof.link === "local") {
        if (proof.replaceable === true) return settleByName(reference, name, named);
        if ("external" in proof.holds) return outside(proof.holds.external);
        return step(proof.type === undefined ? undefined : await binder?.memberOf(proof.type, name, placeOf(reference)));
      }
      if (proof.link === "none") return unproved();
      if (proof.link !== "syntax") return;
      const { holds, type } = proof;
      if ((holds.kind === "token" || holds.kind === "object") && proof.unspelled !== true && proof.replaceable !== true) return step(target);
      if (holds.kind === "returned" && returned) {
        const result = await returnedMethod(holds, name, reference);
        if (result === undefined || "file" in result) return step(result);
        return result.kind === "global" ? leafUnlessReplaced({ kind: "global", name: reference.name }, instanceOf(result.name, name), () => settleByName(reference, name, named, true)) : leafUnlessReplaced({ kind: "import", module: result.module, name: reference.name }, { module: result.module }, () => settleByName(reference, name, named, true));
      }
      if (holds.kind === "literal") return leafUnlessReplaced({ kind: "global", name: reference.name }, instanceOf(holds.type, name), () => settleByName(reference, name, named, true));
      if (holds.kind === "annotated") return void annotated.push({ reference, name, named, holds, type, target, unspelled: returned && proof.unspelled === true });
      if (holds.kind === "constructed" && type === undefined) return void constructed.push({ reference, name, named, holds });
      if (holds.kind === "constructed" || holds.kind === "declared") return step(type === undefined ? undefined : await binder?.memberOf(type, name, placeOf(reference)));
      return settleByName(reference, name, named);
    };
    /**
     * A call the index left without a target, settled by what the base binds it to (ADR-0041 decision 4) and narrowed by
     * execution: a receiver proof by `settleReceiver`, a root outside the repository as a leaf unless the repository
     * replaces it, an unbound member call by its name (R6), and every other unbound call as a cut listing its candidates.
     * `absent` names why the receiver reading that left it unbound could not answer, on the cut it leaves.
     */
    const settleBinding = async (reference: GraphUnresolvedReference, binding: CallBinding, absent?: CutSubReason): Promise<void> => {
      const callee = calleeOf(reference.name);
      const name = callee.form === "computed" ? reference.name : callee.name;
      if (binding.kind === "declared") return void typed.push({ reference, name: binding.member, named: [], declared: binding });
      if (binding.kind === "declaration") {
        if (binding.link === "own-member") return void children.push(childAt(binding.target, reference.line, reference.column, reference.name, "own-member"));
        const constructors = reference.kind === "instantiates" && isClassKind(binding.target.kind) ? await constructorsOf(binding.target) : [binding.target];
        if (constructors.length !== 1) return void cuts.push(unresolvedAt(reference, constructors.length > 0 ? constructors : [binding.target], "constructor-unsettled"));
        return void children.push(childAt(constructors[0]!, reference.line, reference.column, reference.name, "call"));
      }
      if (binding.kind === "receiver") return settleReceiver(reference, name, binding.candidates, binding.proof, binding.target, false, () => undefined, binding.declaration);
      if (binding.kind === "outside") {
        const { origin } = binding;
        const cut = binding.form === "bare" ? () => void cuts.push(unresolvedAt(reference, declarationsNamed(name, reference.file))) : () => settleByName(reference, name, membersNamed(name, reference.file), true);
        if (origin.kind === "external") return leafUnlessReplaced({ kind: "import", module: origin.module, name: reference.name }, { module: origin.module }, cut);
        return leafUnlessReplaced({ kind: "global", name: reference.name }, binding.form === "bare" ? { path: [origin.name], member: name, open: true } : { path: compactSpelling(reference.name).split("."), member: name }, cut);
      }
      if (binding.form === "member") return settleByName(reference, name, binding.candidates, false, absent);
      cuts.push(unresolvedAt(reference, binding.candidates, undefined, absent));
    };
    /**
     * A resolved call whose receiver is a value or a field the walk has not proven: settled by what the binder proves the
     * receiver holds, otherwise a cut listing the declarations of its name.
     */
    for (const { edge, target, receiver } of unproven) {
      const reference: GraphUnresolvedReference = { from: node.id, file: node.file, line: edge.line!, column: edge.column!, kind: edge.kind, name: target.name, candidates: [] };
      const members = membersNamed(target.name, node.file);
      const named = members.length > 0 ? members : [target];
      const proof = await receiverAt(node, reference, target.name, receiver);
      const binding = await bindings.ofReceiver(proof, target.name, named, placeOf(reference));
      await settleReceiver(reference, target.name, named, proof, binding.target, true, () => void cuts.push(unresolvedAt(reference, named)), binding.declaration);
    }
    for (const reference of ambiguous) cuts.push(unresolvedAt(reference, [], "unowned"));
    const references = [...missing, ...deferredOnly].filter((reference) => reference.kind === "references");
    const unsettled = unsettledBy([...indexed, ...missing.filter((reference) => reference.kind !== "references")], called);
    const bound = await bindings.bindCalls(unsettled.map((reference) => ({ body: node, reference })), signal);
    for (const [index, reference] of unsettled.entries()) await settleBinding(reference, bound[index]!);
    /**
     * A call inside a function value the body does not run that no record matches runs later, if at all (R8): a deferred
     * step where the base binds it to a declaration, and otherwise left out, as an unrecorded call is today.
     */
    const deferredCalls = deferredOnly.filter((reference) => reference.kind !== "references");
    const later = await bindings.boundCalls(deferredCalls.map((reference) => ({ body: node, reference })), signal);
    for (const [index, reference] of deferredCalls.entries()) {
      const binding = later[index]!;
      const target = (binding.kind === "declaration" && binding.link !== "bound-receiver") || binding.kind === "receiver" ? binding.target : undefined;
      if (target !== undefined && !(reference.kind === "instantiates" && isClassKind(target.kind))) children.push(childAt(target, reference.line, reference.column, reference.name, binding.kind === "declaration" && binding.link === "own-member" ? "own-member" : "call", true));
    }
    const referenced = await bindings.boundCalls(references.map((reference) => ({ body: node, reference })), signal);
    for (const [index, reference] of references.entries()) {
      const binding = referenced[index]!;
      const target = binding.kind === "declaration" || binding.kind === "receiver" ? binding.target : undefined;
      if (target !== undefined) children.push(childAt(target, reference.line, reference.column, reference.name, "reference", true));
      else cuts.push(callCut(placeAt(node.file, reference.line, reference.name), binding.kind === "unbound" || binding.kind === "receiver" ? binding.candidates.map(candidateOf) : []));
    }
    if (constructed.length > 0) {
      const sites = constructed.map(({ reference, holds }): ResolvedNameSite => ({ file: reference.file, line: holds.line, column: holds.column, kind: "instantiates", name: holds.name }));
      const roots = await origins.rootOrigins(sites, signal);
      for (const [index, { reference, name, named }] of constructed.entries()) {
        const root = roots[index];
        const origin = root?.status === "complete" ? root.value : undefined;
        if (origin?.kind === "ambient") await leafUnlessReplaced({ kind: "global", name: reference.name }, instanceOf(origin.name, name), () => settleByName(reference, name, named, true));
        else if (origin?.kind === "external") await leafUnlessReplaced({ kind: "import", module: origin.module, name: reference.name }, { module: origin.module }, () => settleByName(reference, name, named, true));
        else await settleByName(reference, name, named);
      }
    }
    if (annotated.length > 0) {
      const owner = { name: node.name, line: node.startLine, endLine: node.endLine };
      const types = await origins.declaredTypes(annotated.map(({ reference, holds }) => ({ file: reference.file, line: holds.line, column: holds.column, spelled: holds.type, owner })), signal);
      for (const [index, { reference, name, named, type: bound, target, unspelled }] of annotated.entries()) {
        const type = types[index];
        const nominal = type?.kind === "nominal" && bound !== undefined && joinsFact(bound, { path: type.file, line: type.line, symbol: type.name }) && executionProven(bound, name) ? target ?? (unspelled ? (await bindings.memberOfReceiver(bound, name, placeOf(reference))).target : undefined) : undefined;
        if (nominal !== undefined) children.push(childAt(nominal, reference.line, reference.column, reference.name, "call"));
        else if (type?.kind === "nominal") await settleByName(reference, name, named);
        else if (type?.kind === "global") await leafUnlessReplaced({ kind: "global", name: reference.name }, instanceOf(type.name, name), () => settleByName(reference, name, named, true));
        else if (type?.kind === "package") await leafUnlessReplaced({ kind: "import", module: type.module, name: reference.name }, { module: type.module }, () => settleByName(reference, name, named, true));
        else typed.push({ reference, name, named });
      }
    }
    /**
     * One read of the receivers' declared types for the body: a call the index resolved on a receiver the call reads is a
     * step only at the method that type names, and a cut when the sources may falsify any declared type (R3, R5); a call
     * no other proof settles is a step at the method it names.
     */
    const placedCalls = called.filter(({ edge }) => edge.line !== null && edge.column !== null);
    const receiverSites = [
      ...placedCalls.map(({ edge, target }) => ({ file: node.file, line: edge.line!, column: edge.column! + 1, member: target.name })),
      ...typed.map(({ reference, name }) => ({ file: reference.file, line: reference.line, column: reference.column + 1, member: name })),
    ];
    const found = receiverSites.length === 0 ? [] : (await origins.receiverMethods(receiverSites, signal)).map(executed);
    const receivers = new Map(placedCalls.map((followed, index): [FollowedEdge, ReceiverMethod] => [followed, found[index] ?? { kind: "unknown" }]));
    for (const [index, followed] of [...called, ...passed].entries()) {
      if (valueRoots.has(index)) continue;
      const { edge, target } = followed;
      const verdict = verdicts[index]!;
      const value = index >= called.length;
      if (verdict.kind === "keep" || verdict.kind === "redirect") {
        const receiver = value ? undefined : receivers.get(followed);
        const proven = receiver?.kind === "method" ? placedMethod(receiver, CALLABLE_KINDS) : undefined;
        let reached = proven ?? (verdict.kind === "redirect" ? verdict.to : target);
        if (edge.kind === "instantiates" && isClassKind(reached.kind)) {
          const constructors = await constructorsOf(reached);
          if (constructors.length !== 1) {
            cuts.push(unresolvedAt({ from: node.id, file: node.file, line: edge.line ?? node.startLine, column: edge.column ?? 0, name: reached.name, kind: "instantiates", candidates: [] }, constructors.length ? constructors : [reached], "constructor-unsettled"));
            continue;
          }
          reached = constructors[0]!;
        }
        if (receiver !== undefined && receiver.kind !== "unknown" && proven === undefined) cuts.push(callCut(placeAt(node.file, edge.line ?? node.startLine, target.name), sortedUnique([candidateOf(target), ...declarationsNamed(target.name, node.file).map(candidateOf)])));
        else children.push(value ? childAt(reached, edge.line, edge.column, target.name, "reference", true) : childAt(reached, edge.line, edge.column, target.name, "call"));
      } else if (verdict.root.kind === "local-parameter" || verdict.root.kind === "lexical") {
        cuts.push(callCut(placeAt(node.file, edge.line ?? node.startLine, target.name), sortedUnique(declarationsNamed(target.name, node.file).map(candidateOf))));
      } else {
        const dropped = verdict.root;
        const place = callCut(placeAt(node.file, edge.line ?? node.startLine, target.name), sortedUnique(declarationsNamed(target.name, node.file).map(candidateOf)));
        await leafUnlessReplaced(dropped.kind === "external" ? { kind: "import", module: dropped.module, name: target.name } : { kind: "global", name: target.name }, dropped.kind === "external" ? { module: dropped.module } : { path: ["name" in dropped ? dropped.name : target.name], member: target.name, open: true }, () => cuts.push(place));
      }
    }
    for (const [index, { reference, name, named, declared }] of typed.entries()) {
      const receiver = found[placedCalls.length + index];
      const absent = receiver?.kind === "unknown" ? receiver.reason : undefined;
      if (declared !== undefined) {
        await settleBinding(reference, bindings.settleDeclared(declared, receiver), absent);
        continue;
      }
      const method = receiver?.kind === "method" ? placedMethod(receiver, CALLABLE_KINDS) : undefined;
      if (method !== undefined) children.push(childAt(method, reference.line, reference.column, reference.name, "call"));
      else await settleByName(reference, name, named, false, absent);
    }
    return { children: children.sort((a, b) => compareOccurrence(a.place, b.place)), external, cuts };
  }

  async function syntaxBody(declaration: ModelDeclaration): Promise<Body> {
    const owned = ((await reconciled.ownedIn(declaration.file)).get(declaration.id) ?? []).filter((call) => !declaration.deferredFactory || call.deferred);
    const calls = owned.map((call) => ({ body: declaration, reference: { file: declaration.file, line: call.line, column: call.column - 1, kind: call.kind, name: call.name, candidates: [] } }));
    const bound = await bindings.boundCalls(calls, signal);
    const body: Body = { children: [], external: [], cuts: [] };
    for (const [index, binding] of bound.entries()) {
      const call = owned[index]!;
      const target = binding.kind === "declaration" ? binding.target : binding.kind === "receiver" ? binding.declaration ?? binding.target : undefined;
      const place = { line: call.line, column: call.column - 1, spelling: call.name, target: target?.id ?? declaration.id };
      if (target !== undefined && !(binding.kind === "receiver" && "replaceable" in binding.proof && binding.proof.replaceable)) {
        const symbol = indexedDeclaration(target);
        const via = call.kind === "references" ? "reference" : "call";
        const deferred = call.kind === "references" || call.deferred;
        body.children.push(symbol === undefined ? { declaration: target as ModelDeclaration, place, via, ...(deferred ? { deferred: true } : {}) } : childAt(symbol, call.line, call.column - 1, call.name, via, deferred));
      } else if (binding.kind === "outside") {
        const root: LeafRoot = binding.origin.kind === "external" ? { module: binding.origin.module } : { path: [binding.origin.name], member: call.callee ?? call.name, open: true };
        if (await isReplaced(root)) body.cuts.push(callCut(placeAt(declaration.file, call.line, call.name), []));
        else body.external.push(binding.origin.kind === "external" ? { kind: "import", module: binding.origin.module, name: call.name } : { kind: "global", name: call.name });
      } else if (!call.deferred || call.kind === "references") body.cuts.push(callCut(placeAt(declaration.file, call.line, call.name), binding.kind === "unbound" || binding.kind === "receiver" ? binding.candidates.map(candidateOf) : []));
    }
    return body;
  }

  const expandedAt = new Map<string, WalkedStep>();
  const evidence: Evidence[] = [];
  const rootExpansions = new Set<WalkedStep>();
  const stopped = { depth: new Set<string>(), expansions: new Set<string>() };
  const cuts: Cut[] = [];
  let expansions = 0;

  async function visit(step: WalkedStep, node: TraceNode, depth: number): Promise<void> {
    if (signal?.aborted) return;
    const symbol = indexedDeclaration(node);
    const declaration = symbol ?? node;
    if ("bindingEvidence" in node) evidence.push(...node.bindingEvidence ?? []);
    if (symbol !== undefined && runsValue(step, symbol)) {
      step.unsettled = true;
      cuts.push(callCut(placeAt(symbol.file, symbol.startLine, symbol.name), [], "function-value"));
      return;
    }
    const first = expandedAt.get(declaration.id);
    const ownsMembers = symbol !== undefined && (depth === 0 || step.via === "template");
    const page = ownsMembers && pages !== undefined && isClassKind(symbol.kind) && (step.via === "template" || pages.roots.has(symbol.id));
    const owesMembers = ownsMembers && isClassKind(symbol.kind) && (first === undefined || !rootExpansions.has(first));
    if (first !== undefined && !owesMembers) { step.seen = first; return; }
    if (budget.depth !== undefined && depth >= budget.depth) { stopped.depth.add(anchorOf(declaration)); return; }
    if (budget.expansions !== undefined && expansions >= budget.expansions) { stopped.expansions.add(anchorOf(declaration)); return; }
    expansions += 1;
    if (first === undefined) expandedAt.set(declaration.id, step);
    if (ownsMembers) rootExpansions.add(step);
    step.expanded = true;
    const body = symbol === undefined ? await syntaxBody(node as ModelDeclaration) : await bodyOf(symbol, ownsMembers);
    if ("bindingConflict" in node && node.bindingConflict) body.cuts.push(callCut(placeAt(node.file, node.startLine, node.name), (node.bindingEvidence ?? []).map(({ path, line, via }) => placeAt(path, line, via ?? node.name))));
    if (page) {
      const plan = await pages!.of(symbol);
      if (plan === undefined) {
        if (depth === 0) body.cuts.push(callCut(placeAt(symbol.file, symbol.startLine, symbol.name), [], "page-unplanned"));
      } else body.children = pageOrder(body.children, plan, body.cuts);
    }
    const dispatch = symbol === undefined ? undefined : await unboundDispatch(symbol);
    if (dispatch?.cut !== undefined) body.cuts.push(dispatch.cut);
    if (dispatch?.alternatives !== undefined) step.alternatives = dispatch.alternatives.map(declarationOf);
    if (dispatch?.to !== undefined) body.children.push(childAt(dispatch.to, null, null, dispatch.to.name, "dispatch"));
    step.external = body.external;
    step.unsettled = body.cuts.length > 0;
    cuts.push(...body.cuts);
    for (const child of body.children) {
      const { line, column } = child.place;
      const next = child.symbol ?? child.declaration;
      const walked = stepOf(next, {
        ...(line === null || child.via === "member" || child.via === "dispatch" || child.via === "template" ? {} : { at: { line, ...(column === null ? {} : { column: column + 1 }) } }),
        via: child.via,
        ...(child.deferred === undefined ? {} : { deferred: child.deferred }),
      });
      step.children.push(walked);
      await visit(walked, next, depth + 1);
    }
  }

  const walked: WalkedStep[] = [];
  for (const root of roots) {
    const step = stepOf(root, {});
    walked.push(step);
    await visit(step, root, 0);
  }
  if (signal?.aborted) return "aborted";
  const boundCuts = (kind: "depth" | "caller-budget", anchors: ReadonlySet<string>, limit: number | undefined): Cut[] => [...anchors].sort().map((anchor) => boundCut(kind, anchor, limit as number));
  return {
    roots: walked,
    cuts: [...cuts, ...boundCuts("depth", stopped.depth, budget.depth), ...boundCuts("caller-budget", stopped.expansions, budget.expansions)],
    expanded: expansions,
    evidence: distinctEvidence(evidence),
  };
}

/**
 * A page's children in the order it runs them (R9): its constructor, its field initializers and what its class body
 * calls, in source order; its lifecycle hooks in the framework's order; render calls then event handlers, each in
 * template order; the declarations its template uses; then its other members, in source order. A handler the class
 * runs no member of is a cut at the binding.
 */
function pageOrder(children: readonly Child[], plan: PagePlan, cuts: Cut[]): Child[] {
  const handlerRank = new Map<string, readonly [number, number]>();
  const runs: { child: Child; rank: readonly [number, number] }[] = [];
  const members = new Set(children.filter(({ via }) => via === "member").map((child) => (child.symbol ?? child.declaration).name));
  for (const [phase, calls] of [[2, plan.render ?? []], [3, plan.handlers]] as const) for (const [index, handler] of calls.entries()) {
    if ("runs" in handler) runs.push({ child: { symbol: handler.runs, place: { line: null, column: null, spelling: handler.runs.name, target: handler.runs.id }, via: "template" }, rank: [phase, index] });
    else if (!members.has(handler.member)) cuts.push(callCut(placeAt(handler.file, handler.line, handler.member), [], "page-unplanned"));
    else if (!handlerRank.has(handler.member)) handlerRank.set(handler.member, [phase, index]);
  }
  cuts.push(...plan.cuts);
  const rankOf = (child: Child): readonly [number, number] => {
    const { via, place } = child;
    const symbol = child.symbol ?? child.declaration;
    const line = place.line ?? symbol.startLine;
    if (via !== "member" || symbol.name === "constructor" || (FIELD_KINDS as readonly string[]).includes(symbol.kind)) return [0, line];
    const hook = plan.lifecycle.indexOf(symbol.name);
    if (hook >= 0) return [1, hook];
    const handler = handlerRank.get(symbol.name);
    return handler ?? [5, line];
  };
  const ranked = children.map((child) => ({ child, rank: rankOf(child) }));
  const used = plan.children.map((symbol, index) => ({ child: { symbol, place: { line: null, column: null, spelling: symbol.name, target: symbol.id }, via: "template" as const }, rank: [4, index] as const }));
  return [...ranked, ...runs, ...used].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map(({ child }) => child);
}

/**
 * What dispatch decides for a body-less or overridable callable: the one body it runs, or a cut; `alternatives` when the
 * declared hierarchy names every body it may run.
 */
/**
 * A call the walk cannot follow, at its place in a walked body, with the declarations it may run: a call no rule settles
 * is `receiver-unproven` when it lists candidates and `callee-unknown` when it lists none, unless its situation names another reason.
 */
function callCut(place: string, candidates: readonly string[], reason: CutReason = candidates.length > 0 ? "receiver-unproven" : "callee-unknown", subReason?: CutSubReason): Cut {
  return { kind: "unresolved-link", at: [place, ...candidates], reason, ...(subReason === undefined ? {} : { subReason }), reach: { kind: "call-at", place } };
}

type Dispatch = { to: GraphSymbol; alternatives: readonly GraphSymbol[]; cut?: undefined } | { to?: undefined; cut: Cut; alternatives?: readonly GraphSymbol[] };

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

function declarationOf(symbol: TraceNode): TraceDeclaration {
  const declaration = indexedDeclaration(symbol) ?? symbol;
  return { key: declaration.id, file: declaration.file, symbol: declaration.name, kind: declaration.kind, start: declaration.startLine, end: declaration.endLine };
}

function stepOf(symbol: TraceNode, occurrence: Pick<WalkedStep, "at" | "via" | "deferred">): WalkedStep {
  return { declaration: declarationOf(symbol), ...occurrence, expanded: false, unsettled: false, children: [], external: [] };
}
