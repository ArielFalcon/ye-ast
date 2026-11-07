import { isSeedable } from "../../domain/change/seeds.ts";
import { CALL_EDGE_KINDS, FIELD_KINDS, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import { declarationAnchor, placeAt } from "../../domain/impact/impact-cuts.ts";
import { NOT_DECLARED_KINDS, sortedUnique } from "../../domain/impact/importers-fact.ts";
import { branchesOf, declarationPath } from "../../domain/shared/declaration-tree.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import { calleeOf, compareOccurrence, ownMemberOf, receiverOf, type OrderedPlace } from "../../domain/trace/call-place.ts";
import type { TraceVia } from "../../domain/trace/trace-fact.ts";
import type { ExternalCall, TraceDeclaration, WalkedStep } from "../../domain/trace/trace-tree.ts";
import type { SymbolRef } from "../../domain/relations/relation.ts";
import type { DeclaredCallable, DeclaredMemberNames, FunctionValueCall, ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOriginSite, ImportOrigins, ReplacedRoots, ResolvedNameSite } from "../../ports/import-origins.port.ts";
import type { TraceBudget } from "../../ports/trace-queries.port.ts";
import { createGraphNavigation, SUPERTYPE_EDGES } from "../navigation/graph-navigation.ts";
import { containmentTree } from "../navigation/containment-tree.ts";
import type { RelationExtraction } from "../relations/relation-extractor.ts";
import type { EdgeTargets, FollowedEdge } from "../navigation/edge-targets.ts";
import { createDeclarationUses, unsettledBy, type UnresolvedIn } from "../navigation/declaration-uses.ts";

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
export function isTraceRoot(store: CodeGraphReader, unresolvedIn: UnresolvedIn): (symbol: GraphSymbol) => boolean {
  return (symbol) =>
    isSeedable(symbol) ||
    ((FIELD_KINDS as readonly string[]).includes(symbol.kind) &&
      (callEdgesOf(store, symbol).length > 0 || unresolvedIn(symbol.file).some((reference) => reference.from === symbol.id && CALL_EDGE_KINDS.includes(reference.kind))));
}

function callEdgesOf(store: CodeGraphReader, symbol: GraphSymbol) {
  return store.outgoingEdges([symbol.id], CALL_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge));
}

export interface TraceWalkInput {
  store: CodeGraphReader;
  /** The query's one read of each file's unresolved references, shared with root selection. */
  unresolvedIn: UnresolvedIn;
  origins: ImportOrigins;
  /** Where each resolved edge really points, judged by the one owner of that decision. */
  targets: EdgeTargets;
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
  /** The relations impact reads, for the member calls they prove; read when a member call first needs them. */
  memberProofs: () => Promise<Pick<RelationExtraction, "memberUses" | "externalUses">>;
  budget: TraceBudget;
  signal?: AbortSignal;
}

export interface TraceWalk {
  /** One per root, in the order given. */
  roots: readonly WalkedStep[];
  cuts: readonly Cut[];
  expanded: number;
}

/** A spelling that is a chain of plain names, `a.b.m`: no call, index or computed link the value could come from. */
const PLAIN_CHAIN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

/** What the relations prove a member call runs. */
type ProvenCall = { kind: "member"; receiver: SymbolRef; member: SymbolRef } | { kind: "external"; holds: string } | { kind: "replaceable" };

const provenKey = (file: string, line: number, column: number, name: string): string => JSON.stringify([file, line, column, name]);

const placeKey = (line: number, column: number): string => `${line}:${column}`;

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
  const { store, unresolvedIn, origins, targets, inScope, memberDeclarations, syntaxOf, memberProofs, budget, signal } = input;
  const navigation = createGraphNavigation(store, () => false);
  const uses = createDeclarationUses(store, navigation, unresolvedIn);
  const callsFrom = (node: GraphSymbol): readonly GraphUnresolvedReference[] => uses.referencesFrom(node, CALL_EDGE_KINDS);

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
    const { callables, functionValueCalls, receiverBindings } = await syntaxOf(file);
    const byName = new Map<string, DeclaredCallable[]>();
    for (const callable of callables) byName.set(callable.name, [...(byName.get(callable.name) ?? []), callable]);
    return { callables: byName, functionValueCalls: new Set(functionValueCalls.map(functionValueKey)), receiverBindings: new Map(receiverBindings.map((binding) => [placeKey(binding.line, binding.column), binding])) };
  });
  /**
   * What the relations prove a member call runs, by its place: a repository method of the class a field or local holds
   * (RFC-0013 R3), or a type from outside the repository a field holds. A place two proofs name, a template's call and a
   * receiver a provider may replace prove nothing here.
   */
  let provenByPlace: Promise<ReadonlyMap<string, ProvenCall>> | undefined;
  const provenAt = async (reference: GraphUnresolvedReference): Promise<ProvenCall | undefined> => {
    provenByPlace ??= memberProofs().then(({ memberUses, externalUses }) => {
      const byPlace = new Map<string, ProvenCall[]>();
      const add = (site: { file: string; line: number; column: number; name: string }, call: ProvenCall): void => {
        const key = provenKey(site.file, site.line, site.column, site.name);
        byPlace.set(key, [...(byPlace.get(key) ?? []), call]);
      };
      for (const use of memberUses ?? []) if (use.template !== true) add(use.reference, use.substitutes === undefined ? { kind: "member", receiver: use.receiver, member: use.member } : { kind: "replaceable" });
      for (const use of externalUses ?? []) add(use.reference, { kind: "external", holds: use.holds });
      return new Map([...byPlace].flatMap(([key, calls]) => (calls.length === 1 ? [[key, calls[0]!]] : [])));
    });
    return (await provenByPlace).get(provenKey(reference.file, reference.line, reference.column + 1, reference.name));
  };
  /** The one method a member proof names, declared by the one class it names; none when the index does not place it so. */
  const provenMember = (call: Extract<ProvenCall, { kind: "member" }>): GraphSymbol | undefined => {
    const members = store.symbolsInFiles([call.member.path]).filter((symbol) => symbol.kind === "method" && joinsFact(symbol, call.member));
    const owners = members.length === 1 ? navigation.ownersOf(members[0]!) : [];
    return owners.length === 1 && owners[0]!.kind === "class" && joinsFact(owners[0]!, call.receiver) ? members[0] : undefined;
  };
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
  /** The receiver binding the call's own source proves at the place the call starts, for the member and receiver it spells. */
  const boundAt = async (reference: GraphUnresolvedReference, member: string): Promise<ReceiverBinding["holds"] | undefined> => {
    const binding = (await syntaxIndexOf(reference.file)).receiverBindings.get(placeKey(reference.line, reference.column + 1));
    return binding !== undefined && binding.member === member && binding.receiver === receiverOf(reference.name) ? binding.holds : undefined;
  };
  /** The one method named `member` the one class of `name` in `file` (at `line`, when given) declares itself; none otherwise. */
  const ownMethodOf = (file: string, name: string, member: string, line?: number): GraphSymbol | undefined => {
    const classes = store.symbolsInFiles([file]).filter((symbol) => symbol.kind === "class" && joinsFact(symbol, { path: file, line: line ?? symbol.startLine, symbol: name }));
    const methods = classes.length === 1 ? navigation.methodsOf(classes[0]!).filter((method) => method.name === member) : [];
    return methods.length === 1 ? methods[0] : undefined;
  };
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
    return navigation
      .membersOf(node)
      .filter((member) => member.kind === "method" || ((FIELD_KINDS as readonly string[]).includes(member.kind) && (callEdgesOf(store, member).length > 0 || callsFrom(member).length > 0)))
      .map((member) => childAt(member, member.startLine, null, member.name, "member"));
  };

  async function bodyOf(node: GraphSymbol, root: boolean): Promise<Body> {
    const calls = callEdgesOf(store, node);
    const values = store.outgoingEdges([node.id], ["references"]);
    const called = uses.followed(node, calls);
    const passed = uses.followed(node, values).filter(({ target }) => DEFERRED_KINDS.includes(target.kind));
    const verdicts = await targets.verdictsOf([...called, ...passed], signal);
    const external: ExternalCall[] = [];
    const children: Child[] = root ? membersOf(node) : [];
    const cuts: Cut[] = [];
    /** An external call is a leaf only while the repository writes nothing over what it names; otherwise `replaced` decides. */
    const leafUnlessReplaced = async (call: ExternalCall, root: LeafRoot, replaced: () => unknown): Promise<void> => {
      if (await isReplaced(root)) await replaced();
      else external.push(call);
    };
    for (const [index, { edge, target }] of [...called, ...passed].entries()) {
      const verdict = verdicts[index]!;
      const value = index >= called.length;
      if (verdict.kind === "keep" || verdict.kind === "redirect") {
        const reached = verdict.kind === "redirect" ? verdict.to : target;
        children.push(value ? childAt(reached, edge.line, edge.column, target.name, "reference", true) : childAt(reached, edge.line, edge.column, target.name, "call"));
      } else if (verdict.root.kind === "local-parameter") {
        cuts.push({ kind: "unresolved-link", at: [placeAt(node.file, edge.line ?? node.startLine, target.name), ...sortedUnique(declarationsNamed(target.name).map(candidateOf))] });
      } else {
        const dropped = verdict.root;
        const place: Cut = { kind: "unresolved-link", at: [placeAt(node.file, edge.line ?? node.startLine, target.name), ...sortedUnique(declarationsNamed(target.name).map(candidateOf))] };
        await leafUnlessReplaced(dropped.kind === "external" ? { kind: "import", module: dropped.module, name: target.name } : { kind: "global", name: target.name }, dropped.kind === "external" ? { module: dropped.module } : { path: ["name" in dropped ? dropped.name : target.name], member: target.name, open: true }, () => cuts.push(place));
      }
    }
    /**
     * A member call nothing settled by its receiver: a cut listing the declarations of its name, or, when no declaration and
     * no source names it and the repository replaces nothing the call was found to name, an external call (R6).
     */
    const settleByName = async (reference: GraphUnresolvedReference, name: string, named: readonly GraphSymbol[], replaced = false): Promise<void> => {
      if (named.length > 0) return void cuts.push(unresolvedAt(reference, named));
      const receiver = receiverOf(reference.name);
      const declared = [
        ...((await memberDeclarations()).get(name) ?? []).map((file) => declarationAnchor(file, name)),
        ...(receiver !== undefined && (await holdsFunctionValue(reference, receiver, name)) ? [declarationAnchor(reference.file, receiver)] : []),
      ];
      const cut = () => cuts.push({ kind: "unresolved-link", at: [placeAt(reference.file, reference.line, reference.name), ...sortedUnique([...reference.candidates, ...declared])] });
      if (declared.length === 0 && !replaced) await leafUnlessReplaced({ kind: "unnamed", name: reference.name }, { path: [], member: name }, cut);
      else cut();
    };
    const bare: { reference: GraphUnresolvedReference; name: string }[] = [];
    const rooted: { reference: GraphUnresolvedReference; name: string; named: readonly GraphSymbol[] }[] = [];
    const constructed: { reference: GraphUnresolvedReference; name: string; named: readonly GraphSymbol[]; holds: Extract<ReceiverBinding["holds"], { kind: "constructed" }> }[] = [];
    const annotated: { reference: GraphUnresolvedReference; name: string; named: readonly GraphSymbol[]; holds: Extract<ReceiverBinding["holds"], { kind: "annotated" }> }[] = [];
    for (const reference of unsettledBy(callsFrom(node), called)) {
      const own = ownMemberOf(reference.name);
      const members = own === undefined ? [] : uses.ownMembers(node, own, ["method"]);
      if (members.length === 1) children.push(childAt(members[0]!, reference.line, reference.column, reference.name, "own-member"));
      else if (members.length > 1) cuts.push(unresolvedAt(reference, members));
      else {
        const callee = calleeOf(reference.name);
        if (callee.form === "computed") cuts.push(unresolvedAt(reference, []));
        else if (callee.form === "bare") bare.push({ reference, name: callee.name });
        else {
          const proven = await provenAt(reference);
          let bound: ReceiverBinding["holds"] | undefined;
          const member = proven?.kind === "member" ? provenMember(proven) : undefined;
          const named = membersNamed(callee.name);
          if (member !== undefined) children.push(childAt(member, reference.line, reference.column, reference.name, "call"));
          else if (proven?.kind === "external") await leafUnlessReplaced(externalOf(proven.holds, reference.name), rootOfHolds(proven.holds, callee.name), () => settleByName(reference, callee.name, named, true));
          else if ((bound = await boundAt(reference, callee.name)) !== undefined) {
            const declared = bound.kind === "declared" ? ownMethodOf(reference.file, bound.name, callee.name, bound.line) : undefined;
            if (bound.kind === "literal") await leafUnlessReplaced({ kind: "global", name: reference.name }, instanceOf(bound.type, callee.name), () => settleByName(reference, callee.name, named, true));
            else if (bound.kind === "constructed") constructed.push({ reference, name: callee.name, named, holds: bound });
            else if (bound.kind === "annotated") annotated.push({ reference, name: callee.name, named, holds: bound });
            else if (declared !== undefined) children.push(childAt(declared, reference.line, reference.column, reference.name, "call"));
            else await settleByName(reference, callee.name, named);
          } else if (PLAIN_CHAIN.test(reference.name) && !reference.name.startsWith("this.")) rooted.push({ reference, name: callee.name, named });
          else await settleByName(reference, callee.name, named);
        }
      }
    }
    if (constructed.length > 0) {
      const sites = constructed.map(({ reference, holds }): ResolvedNameSite => ({ file: reference.file, line: holds.line, column: holds.column, kind: "instantiates", name: holds.name }));
      const roots = await origins.rootOrigins(sites, signal);
      for (const [index, { reference, name, named, holds }] of constructed.entries()) {
        const root = roots[index];
        const origin = root?.status === "complete" ? root.value : undefined;
        const method = origin?.kind === "repository" ? ownMethodOf(origin.file, holds.name, name) : undefined;
        if (origin?.kind === "ambient") await leafUnlessReplaced({ kind: "global", name: reference.name }, instanceOf(origin.name, name), () => settleByName(reference, name, named, true));
        else if (method !== undefined) children.push(childAt(method, reference.line, reference.column, reference.name, "call"));
        else await settleByName(reference, name, named);
      }
    }
    if (annotated.length > 0) {
      const owner = { name: node.name, line: node.startLine, endLine: node.endLine };
      const types = await origins.declaredTypes(annotated.map(({ reference, holds }) => ({ file: reference.file, line: holds.line, column: holds.column, spelled: holds.type, owner })), signal);
      for (const [index, { reference, name, named }] of annotated.entries()) {
        const type = types[index];
        if (type?.kind === "global") await leafUnlessReplaced({ kind: "global", name: reference.name }, instanceOf(type.name, name), () => settleByName(reference, name, named, true));
        else if (type?.kind === "package") await leafUnlessReplaced({ kind: "import", module: type.module, name: reference.name }, { module: type.module }, () => settleByName(reference, name, named, true));
        else await settleByName(reference, name, named);
      }
    }
    if (rooted.length > 0) {
      const sites = rooted.map(({ reference, name }): ResolvedNameSite => ({ file: reference.file, line: reference.line, column: reference.column + 1, kind: reference.kind, name }));
      const roots = await origins.rootOrigins(sites, signal);
      for (const [index, { reference, name, named }] of rooted.entries()) {
        const root = roots[index];
        const origin = root?.status === "complete" ? root.value : undefined;
        if (origin?.kind === "external") await leafUnlessReplaced({ kind: "import", module: origin.module, name: reference.name }, { module: origin.module }, () => settleByName(reference, name, named, true));
        else if (origin?.kind === "ambient") await leafUnlessReplaced({ kind: "global", name: reference.name }, { path: reference.name.split("."), member: name }, () => settleByName(reference, name, named, true));
        else await settleByName(reference, name, named);
      }
    }
    if (bare.length > 0) {
      const sites = bare.map(({ reference, name }): ImportOriginSite => ({ file: reference.file, line: reference.line, column: reference.column + 1, name, fullName: reference.name, kind: reference.kind }));
      const findings = await origins.origins(sites, signal);
      for (const [index, { reference, name }] of bare.entries()) {
        const finding = findings[index];
        const origin = finding?.status === "complete" && finding.occurrence === true ? finding.value : undefined;
        const cut = () => cuts.push(unresolvedAt(reference, declarationsNamed(name)));
        if (origin?.kind === "external") await leafUnlessReplaced({ kind: "import", module: origin.module, name: reference.name }, { module: origin.module }, cut);
        else if (origin?.kind === "ambient") await leafUnlessReplaced({ kind: "global", name: reference.name }, { path: [origin.name], member: name, open: true }, cut);
        else cut();
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
  /** By the place the call starts. */
  receiverBindings: ReadonlyMap<string, ReceiverBinding>;
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
