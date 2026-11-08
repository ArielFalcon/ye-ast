import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import { CALL_EDGE_KINDS, EDGE_POLICY, edgeVerdict, FOLLOWED_EDGE_KINDS, holdsValue, type EdgeVerdict, type ReceiverSettlement } from "../../domain/impact/edge-policy.ts";
import { isTypeScriptFile } from "../../domain/languages/typescript.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { ExternalMemberUseOrigin, MemberUseOrigin } from "../../domain/relations/member-use.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader, ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { ModuleDependencies, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { TypeTarget } from "../../ports/type-bindings.port.ts";
import { createGraphNavigation, isInside } from "./graph-navigation.ts";
import { declarationAt, importBindings } from "./import-bindings.ts";
import { provenCallsOf, provenKey, typedDeclaration, type ProvenCalls } from "./proven-calls.ts";

/**
 * What the edges the graph resolved really reach, read from the root of the name each spells at its position through
 * the source file's own bindings (`ImportOrigins.rootOrigins`) and, for a root an import binds, the declaration the
 * module statements and the graph's `imports` edges join it to (`importBindings`). An edge whose root proof reads past
 * its root (`RootOrigin.pastRoot`) is kept: the root says where the chain starts, not what the call runs. A kept edge of a
 * TypeScript source into a member of a class or interface whose receiver is a value names that receiver (`EdgeTarget.receiver`): the
 * index matched such a call by name, and the language types structurally, so another object may stand there (ADR-0029
 * decision 11). The one owner of that decision for every family that reads graph edges as dependences.
 */
export interface EdgeTargets {
  /** One verdict per edge, in the order received; an edge the graph placed nowhere is kept. */
  verdictsOf(edges: readonly FollowedEdge[], signal?: AbortSignal): Promise<readonly EdgeTarget[]>;
  /**
   * The edges the graph matched elsewhere that the source's bindings prove reach one of `nodes`, each with that node as
   * its target, node by node in the order given: a name an import binds to it, or a name of it the graph matched to a
   * homonym declaration where it is in scope. Every candidate of every node is judged in one `verdictsOf`.
   */
  redirectedInto(nodes: readonly GraphSymbol[], signal?: AbortSignal): Promise<readonly FollowedEdge[]>;
  /** Per local name `file`'s imports bind, the declaration the join proves it reaches, when it proves exactly one. */
  importedDeclarations(file: string): Promise<ReadonlyMap<string, GraphSymbol>>;
}

export interface EdgeTargetsDeps {
  origins: ImportOrigins;
  store: CodeGraphReader;
  /**
   * The module statements that bind a root to a declaration: already read, or a reader asked file by file. Without them no
   * edge is redirected.
   */
  modules?: ModuleDependencies | { reader: ModuleDependenciesReader; sources: readonly SourceFile[] } | undefined;
  /** What a source's syntax states, read once per file; without it no kept edge names a receiver. */
  syntaxOf?: ((file: string) => Promise<DeclaredMemberNames>) | undefined;
  /**
   * The relations' origins and member proofs, read when an edge's receiver first needs them; with them every kept edge
   * that names a receiver is settled (`EdgeTarget.derivation`).
   */
  proofs?: (() => Promise<ReceiverProofs>) | undefined;
  /**
   * The declaration the type checker binds each call to, by `provenKey` (`typedCallsOf`), consulted before any other
   * proof (ADR-0037 decision 10); without it every edge is settled as ADR-0036 settles it.
   */
  typed?: ReadonlyMap<string, TypeTarget> | undefined;
}

/** What the relations prove a receiver holds: a field's or an `inject()` local's origin, and the member calls they prove. */
export interface ReceiverProofs {
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
  memberUses?: readonly MemberUseOrigin[] | undefined;
  externalUses?: readonly ExternalMemberUseOrigin[] | undefined;
}

/** The syntax of a source no reader parses: it states nothing. */
export const NOTHING_DECLARED: DeclaredMemberNames = { names: [], functionValueCalls: [], callables: [], receiverBindings: [], functionValues: [] };

/** No relation proof: for a family that reads no Angular relations, only a receiver's syntax binds it. */
export const SYNTAX_ONLY: ReceiverProofs = { fields: [], locals: [] };

/** What each of `sources` states in its syntax, kept between requests in `facts` where the reader can; nothing without a reader. */
export function syntaxOfSources(reader: DeclaredMemberNamesReader | undefined, sources: readonly SourceFile[], facts?: DerivedFacts): EdgeTargetsDeps["syntaxOf"] {
  if (reader === undefined) return undefined;
  const byPath = new Map(sources.map((file) => [file.path, file]));
  return async (path) => {
    const file = byPath.get(path);
    return file === undefined ? NOTHING_DECLARED : reader.memberNames(file, facts);
  };
}

/** A graph edge with both of its ends. */
export interface FollowedEdge {
  edge: GraphEdge;
  source: GraphSymbol;
  target: GraphSymbol;
}

/** One edge of the store, for naming it in a set; a handle inside one store, never output. */
export function edgeKey({ source, target, kind, line, column }: GraphEdge): string {
  return JSON.stringify([source, target, kind, line, column]);
}

/**
 * What an edge reaches (`EdgeVerdict`); a dropped one carries the root that binds its name outside the repository's
 * declarations. `receiver` is the value a kept call into a member of a class or interface is made on: the field's name for `this.f.m`, the parameter's or
 * variable's root for `v.m`, and empty for a call result or another expression. With the relations' proofs such an edge is
 * `proven` when a source proof binds the receiver to the class of the member it reaches, and a `name-match` otherwise. A
 * kept call the type checker binds to the edge's own target is `typed`, receiver or not, as is a call it moves to the declaration it binds.
 */
export type EdgeTarget =
  | Exclude<EdgeVerdict<GraphSymbol>, { kind: "keep" | "drop" | "redirect" }>
  | { kind: "keep"; receiver?: string; derivation?: ReceiverSettlement }
  | { kind: "redirect"; to: GraphSymbol; derivation?: "typed" }
  | { kind: "drop"; root: ImportOrigin };

const KEEP: EdgeTarget = { kind: "keep" };
const TYPED: EdgeTarget = { kind: "keep", derivation: "typed" };
const IMPORT = "imports";
/** The types whose members a value receiver may stand for, and a receiver's store or annotation may name. */
const TYPE_KINDS: readonly string[] = EDGE_POLICY.ownerKinds;

export const bindingKey = (line: number, column: number, member: string): string => `${line}:${column}:${member}`;

/** A source's receiver bindings by `bindingKey`; a place two bindings name is ambiguous. */
export function receiverBindingsByPlace(found: readonly ReceiverBinding[]): ReadonlyMap<string, ReceiverBinding | "ambiguous"> {
  const byPlace = new Map<string, ReceiverBinding | "ambiguous">();
  for (const binding of found) {
    const key = bindingKey(binding.line, binding.column, binding.member);
    byPlace.set(key, byPlace.has(key) ? "ambiguous" : binding);
  }
  return byPlace;
}

/** What the one binding at a place proves `receiver` holds, for a call of `member` starting there. */
export function holdsAt(bindings: ReadonlyMap<string, ReceiverBinding | "ambiguous">, line: number, column: number, member: string, receiver: string): ReceiverBinding["holds"] | undefined {
  const binding = bindings.get(bindingKey(line, column, member));
  return binding !== undefined && binding !== "ambiguous" && binding.receiver === receiver ? binding.holds : undefined;
}

interface SyntaxIndex {
  receiverBindings: ReadonlyMap<string, ReceiverBinding | "ambiguous">;
  /** The callee each call starting at a place spells, without white space, by `line:column`. */
  callees: ReadonlyMap<string, readonly string[]>;
}

export function createEdgeTargets({ origins, store, modules, syntaxOf, proofs, typed }: EdgeTargetsDeps): EdgeTargets {
  const verdicts = new Map<string, EdgeTarget>();
  const navigation = createGraphNavigation(store, () => false);
  const syntaxIndexes = new Map<string, Promise<SyntaxIndex>>();
  const syntaxIn = (read: (file: string) => Promise<DeclaredMemberNames>, file: string): Promise<SyntaxIndex> => {
    let held = syntaxIndexes.get(file);
    if (held === undefined) {
      held = read(file).then(({ receiverBindings, calls }) => {
        const callees = Map.groupBy(calls ?? [], (call) => `${call.line}:${call.column}`);
        return { receiverBindings: receiverBindingsByPlace(receiverBindings), callees: new Map([...callees].map(([place, at]) => [place, at.map((call) => call.name.replace(/\s+/g, ""))])) };
      });
      syntaxIndexes.set(file, held);
    }
    return held;
  };
  let proofsRead: Promise<{ held: ReceiverProofs; calls: ProvenCalls }> | undefined;
  const provenReceivers = (read: () => Promise<ReceiverProofs>) => (proofsRead ??= read().then((held) => ({ held, calls: provenCallsOf(held.memberUses, held.externalUses) })));
  /** Per file, the declaration each local name its imports bind reaches, when the join proves exactly one. */
  const bound = new Map<string, ReadonlyMap<string, GraphSymbol>>();
  let extracted: ReadonlyMap<string, readonly ModuleDependency[]> | undefined;

  async function bindingsOf(file: string): Promise<ReadonlyMap<string, GraphSymbol>> {
    let held = bound.get(file);
    if (held === undefined) {
      const dependencies = modules === undefined ? [] : "dependencies" in modules ? (extracted ??= Map.groupBy(modules.dependencies, (dependency) => dependency.file)).get(file) ?? [] : (await modules.reader.extract(modules.sources, { files: [file] })).dependencies.filter((dependency) => dependency.file === file);
      const byLocal = new Map<string, GraphSymbol[]>();
      for (const [binding, declaration] of importBindings(store, file, dependencies)) {
        if (binding.local !== undefined) byLocal.set(binding.local, [...(byLocal.get(binding.local) ?? []), declaration]);
      }
      held = new Map([...byLocal].flatMap(([local, declarations]) => (new Set(declarations.map(({ id }) => id)).size === 1 ? [[local, declarations[0]!] as const] : [])));
      bound.set(file, held);
    }
    return held;
  }

  async function verdictsOf(edges: readonly FollowedEdge[], signal?: AbortSignal): Promise<readonly EdgeTarget[]> {
    const placed = [...new Map(edges.filter(({ edge }) => edge.line !== null && edge.column !== null && !verdicts.has(edgeKey(edge))).map((followed) => [edgeKey(followed.edge), followed])).values()];
    const fresh: FollowedEdge[] = [];
    for (const followed of placed) {
      const verdict = typedVerdictOf(followed);
      if (verdict === undefined) fresh.push(followed);
      else verdicts.set(edgeKey(followed.edge), verdict);
    }
    if (fresh.length > 0) {
      const roots = await origins.rootOrigins(fresh.map(({ edge, source, target }) => ({ file: source.file, line: edge.line!, column: edge.column! + 1, kind: edge.kind, name: target.name })), signal);
      const kept: FollowedEdge[] = [];
      for (const [index, followed] of fresh.entries()) {
        const { edge, source, target } = followed;
        const root = roots[index];
        const proven = root === undefined || root.pastRoot === true || root.status !== "complete" || root.value.kind !== "repository" || root.bare !== true ? undefined : root.value.declared !== undefined ? declarationAt(store, root.value.file, root.value.declared) : (await bindingsOf(source.file)).get(target.name);
        const verdict = root === undefined || root.pastRoot === true ? undefined : edgeVerdict<GraphNodeId>(root, proven?.id, target);
        if (verdict?.kind === "redirect") verdicts.set(edgeKey(edge), { kind: "redirect", to: proven! });
        else if (verdict?.kind === "drop" && root!.status === "complete") verdicts.set(edgeKey(edge), { kind: "drop", root: root!.value });
        else kept.push(followed);
      }
      const receivers = await receiversOf(kept, signal);
      for (const [index, followed] of kept.entries()) {
        const receiver = receivers[index];
        if (receiver === undefined) verdicts.set(edgeKey(followed.edge), KEEP);
        else if (proofs === undefined) verdicts.set(edgeKey(followed.edge), { kind: "keep", receiver });
        else verdicts.set(edgeKey(followed.edge), { kind: "keep", receiver, derivation: (await bindsClass(followed, receiver, proofs)) ? "proven" : "name-match" });
      }
    }
    return edges.map(({ edge }) => verdicts.get(edgeKey(edge)) ?? KEEP);
  }

  /**
   * What the type checker binds an edge's call to: its own target keeps it, another declaration the graph holds takes it,
   * and a declaration outside the repository drops it. A call bound to nothing the graph places is settled as before.
   */
  function typedVerdictOf({ edge, source, target }: FollowedEdge): EdgeTarget | undefined {
    if (typed === undefined || !CALL_EDGE_KINDS.includes(edge.kind)) return undefined;
    const bound = typed.get(provenKey(source.file, edge.line!, edge.column! + 1, target.name));
    if (bound === undefined) return undefined;
    if (bound.kind === "external") return { kind: "drop", root: { kind: "external", module: bound.module } };
    if (bound.kind === "ambient") return { kind: "drop", root: { kind: "ambient", name: bound.name } };
    const declared = typedDeclaration(store, bound);
    if (declared === undefined) return undefined;
    return declared.id === target.id ? TYPED : { kind: "redirect", to: declared, derivation: "typed" };
  }

  /**
   * Per kept edge, the receiver it is called on when that receiver is a value (a parameter or a variable, by the binder's
   * scoping), a field read through `this` (`this.f.m`) or no name at all (a call result, `f().m`, empty), rather than a
   * class, a function, an import or `this` itself. The receiver the source's syntax binds at the call decides first,
   * whatever it holds; the root's binding decides otherwise.
   */
  async function receiversOf(edges: readonly FollowedEdge[], signal?: AbortSignal): Promise<readonly (string | undefined)[]> {
    const read = syntaxOf;
    if (read === undefined) return [];
    const asked = edges.flatMap((followed, index) => (isTypeScriptFile(followed.source.file) && navigation.ownersOf(followed.target).some((owner) => TYPE_KINDS.includes(owner.kind)) ? [{ ...followed, index }] : []));
    if (asked.length === 0) return [];
    const bindings = await origins.rootBindings(asked.map(({ edge, source, target }): UseSite => ({ file: source.file, line: edge.line!, column: edge.column! + 1, spelled: target.name, owner: { name: source.name, line: source.startLine, endLine: source.endLine } })), signal);
    /** The body's own binding, or a declaration of the file the index holds as no class, function or other non-value node. */
    const isValue = (file: string, binding: RootBinding | undefined): binding is Extract<RootBinding, { kind: "local" | "declared" }> =>
      binding?.kind === "local" ||
      (binding?.kind === "declared" && !navigation.symbolsInFile(file).some((symbol) => symbol.name === binding.root && !holdsValue(symbol.kind) && binding.lines.some((line) => symbol.startLine <= line && line <= symbol.endLine)));
    const receivers: (string | undefined)[] = [];
    for (const [k, { edge, source, target, index }] of asked.entries()) {
      const bound = (await syntaxIn(read, source.file)).receiverBindings.get(bindingKey(edge.line!, edge.column! + 1, target.name));
      const binding = bindings[k];
      if (bound !== undefined) receivers[index] = bound === "ambiguous" ? "" : bound.receiver;
      else if (binding?.kind === "this") receivers[index] = binding.member === undefined || binding.member === target.name ? undefined : binding.member;
      else if (isValue(source.file, binding)) receivers[index] = binding.root;
    }
    return receivers;
  }

  /**
   * Whether a source proof binds an edge's value receiver to the class that declares the member it reaches, or to a class
   * below it: a member proof of the call itself, or, for an immediate receiver (`this.f.m`, `v.m`), the class a field's or
   * an `inject()` local's origin holds, or the class the receiver's one store or declared annotation names. Dependence is
   * the binding the language makes at compile time, so a declared type proves it even where what runs is unproven. A
   * receiver further down a chain (`this.f.g.m`) is bound by nothing here.
   */
  async function bindsClass({ edge, source, target }: FollowedEdge, receiver: string, read: () => Promise<ReceiverProofs>): Promise<boolean> {
    const line = edge.line!;
    const column = edge.column! + 1;
    const owners = navigation.ownersOf(target);
    const declares = (type: GraphSymbol | undefined): boolean =>
      type !== undefined && [type, ...navigation.typesAround(type, "up").map((around) => around.type)].some((candidate) => owners.some((owner) => owner.id === candidate.id));
    const { held, calls } = await provenReceivers(read);
    const proof = calls.byMember.get(provenKey(source.file, line, column, target.name));
    if (proof?.kind === "member") return joinsFact(target, proof.member) && owners.some((owner) => joinsFact(owner, proof.receiver));
    if (proof?.kind === "external") return false;
    if (receiver === "" || syntaxOf === undefined) return false;
    const syntax = await syntaxIn(syntaxOf, source.file);
    const callees = syntax.callees.get(`${line}:${column}`) ?? [];
    const found = callees.includes(`this.${receiver}.${target.name}`)
      ? navigation.fieldOriginAt(source, receiver, held.fields)
      : callees.includes(`${receiver}.${target.name}`)
        ? navigation.localOriginAt(source, receiver, held.locals)
        : "unbound";
    if (found === "unbound") return false;
    const origin = typeof found === "object" ? found.origin : undefined;
    if (origin !== undefined) return "class" in origin.holds && declares(navigation.declarationAt(origin.holds.class, TYPE_KINDS));
    const holds = holdsAt(syntax.receiverBindings, line, column, target.name, receiver);
    if (holds === undefined) return false;
    if (holds.kind === "declared") return declares(navigation.declarationAt({ path: source.file, line: holds.line, symbol: holds.name }, TYPE_KINDS));
    if (holds.kind === "annotated") return declares(await typeNamed(source.file, holds.type));
    if (holds.kind === "constructed") return declares(await typeNamed(source.file, holds.name));
    return false;
  }

  /** The one type `name` names in `file`: the declaration an import of it binds, or the one the file declares. */
  async function typeNamed(file: string, name: string): Promise<GraphSymbol | undefined> {
    const imported = (await bindingsOf(file)).get(name);
    if (imported !== undefined) return TYPE_KINDS.includes(imported.kind) ? imported : undefined;
    const declared = navigation.symbolsInFile(file).filter((symbol) => symbol.name === name && TYPE_KINDS.includes(symbol.kind));
    return declared.length === 1 ? declared[0] : undefined;
  }

  return {
    verdictsOf,
    importedDeclarations: bindingsOf,
    async redirectedInto(nodes, signal) {
      const candidatesOf: { node: GraphSymbol; found: readonly FollowedEdge[] }[] = [];
      for (const node of nodes) candidatesOf.push({ node, found: await candidatesInto(node) });
      const judged = await verdictsOf(candidatesOf.flatMap(({ found }) => found), signal);
      const moved: FollowedEdge[] = [];
      let index = 0;
      for (const { node, found } of candidatesOf) {
        for (const { edge, source } of found) {
          const verdict = judged[index++]!;
          if (verdict.kind === "redirect" && verdict.to.id === node.id) moved.push({ edge, source, target: node });
        }
      }
      return moved;
    },
  };

  /** The edges the graph matched elsewhere that may name `node`: through an import of it, or to a homonym declaration. */
  async function candidatesInto(node: GraphSymbol): Promise<readonly FollowedEdge[]> {
    const candidates = new Map<string, FollowedEdge>();
    const collect = (edges: readonly GraphEdge[], named: (target: GraphSymbol) => boolean): void => {
      const placed = edges.filter((edge) => edge.target !== node.id && edge.line !== null && edge.column !== null);
      const symbols = new Map(store.symbolsByIds([...new Set(placed.flatMap((edge) => [edge.source, edge.target]))]).map((symbol) => [symbol.id, symbol]));
      for (const edge of placed) {
        const source = symbols.get(edge.source);
        const target = symbols.get(edge.target);
        if (source !== undefined && target !== undefined && named(target)) candidates.set(edgeKey(edge), { edge, source, target });
      }
    };
    const importing = store.symbolsByIds([...new Set(store.incomingEdges([node.id], [IMPORT]).map((edge) => edge.source))]);
    for (const file of new Set(importing.map((symbol) => symbol.file))) {
      const locals = new Set([...(await bindingsOf(file))].filter(([, declaration]) => declaration.id === node.id).map(([local]) => local));
      if (locals.size > 0) collect(store.outgoingEdges(store.symbolsInFiles([file]).map((symbol) => symbol.id), FOLLOWED_EDGE_KINDS), (target) => locals.has(target.name));
    }
    const homonyms = store.declarationsNamed([node.name]).filter((symbol) => symbol.id !== node.id);
    collect(store.incomingEdges(homonyms.map((symbol) => symbol.id), FOLLOWED_EDGE_KINDS), () => true);
    return [...candidates.values()];
  }
}
