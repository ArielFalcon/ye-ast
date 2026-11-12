import { CALL_EDGE_KINDS, FIELD_KINDS, EDGE_POLICY, edgeVerdict, FOLLOWED_EDGE_KINDS, holdsValue, type EdgeVerdict, type ReceiverSettlement, type RootOrigin } from "../../domain/impact/edge-policy.ts";
import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import { hasTyping } from "../../domain/languages/profiles.ts";
import { compactSpelling } from "../../domain/shared/call-place.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { ModuleDependencies, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { TypeTarget } from "../../ports/type-bindings.port.ts";
import { createGraphNavigation, isInside } from "./graph-navigation.ts";
import { declarationAt, importBindings } from "./import-bindings.ts";
import { provenKey, typedDeclaration } from "./proven-calls.ts";
import { createCallBindings, type CallBindings } from "./call-binding.ts";
import { bindingKey, createCallBinder, receiverBindingsByPlace, type CallBinder, type ReceiverProofs, type ReceiverSyntax } from "./call-binder.ts";
import type { DeclarationModel } from "./declaration-model.ts";

export { SYNTAX_ONLY, type ReceiverProofs } from "./call-binder.ts";

/**
 * What the edges the graph resolved really reach, read from the root of the name each spells at its position through
 * the source file's own bindings (`ImportOrigins.rootOrigins`) and, for a root an import binds, the declaration the
 * module statements and the graph's `imports` edges join it to (`importBindings`). A root spelled alone that a declaration
 * of its file's own scope binds at the edge's place (a local, a destructured, caught or iterated binding, a local class, a
 * type parameter) reaches that declaration, never the one an outer binding of the name names (`lexicalVerdictsOf`). An
 * edge whose root proof reads past its root (`RootOrigin.pastRoot`) is kept: the root says where the chain starts, not what the call runs. A kept edge of a
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
  /** The binder of member calls' receivers this read's proofs settle; absent without syntax or proofs. */
  binder: CallBinder | undefined;
  /** What the calls the index left without a target bind to, through `binder`; absent without it. */
  bindings: CallBindings | undefined;
}

export interface EdgeTargetsDeps {
  declarations: DeclarationModel;
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
  /** Whether a declaration's file is in the read's scope, for the candidates of an unbound call; every file by default. */
  inScope?: ((path: string) => boolean) | undefined;
}

/** The syntax of a source no reader parses: it states nothing. */
export const NOTHING_DECLARED: DeclaredMemberNames = { names: [], declarations: [], functionValueCalls: [], callables: [], receiverBindings: [], functionValues: [] };

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
 * kept call the type checker binds to the edge's own target is `typed`, as is a call it moves to the declaration it binds;
 * either still names its receiver, since a typed binding proves the dependence, never what runs (ADR-0045 decision 5).
 */
export type EdgeTarget =
  | Exclude<EdgeVerdict<GraphSymbol>, { kind: "keep" | "drop" | "redirect" }>
  | { kind: "keep"; receiver?: string; derivation?: ReceiverSettlement }
  | { kind: "redirect"; to: GraphSymbol; derivation?: "typed"; receiver?: string }
  | { kind: "drop"; root: ImportOrigin | LexicalRoot };

/** A root spelled alone that a declaration of its own file's scope binds, and the graph places no declaration of. */
export interface LexicalRoot {
  kind: "lexical";
  name: string;
}

const KEEP: EdgeTarget = { kind: "keep" };
const TYPED: EdgeTarget = { kind: "keep", derivation: "typed" };
const IMPORT = "imports";
/** The types whose members a value receiver may stand for. */
const TYPE_KINDS: readonly string[] = EDGE_POLICY.ownerKinds;

export function createEdgeTargets({ origins, store, modules, syntaxOf, proofs, typed, inScope, declarations }: EdgeTargetsDeps): EdgeTargets {
  const verdicts = new Map<string, EdgeTarget>();
  const navigation = createGraphNavigation(store, () => false);
  const syntaxIndexes = new Map<string, Promise<ReceiverSyntax>>();
  const syntaxIn = (read: (file: string) => Promise<DeclaredMemberNames>, file: string): Promise<ReceiverSyntax> => {
    let held = syntaxIndexes.get(file);
    if (held === undefined) {
      held = read(file).then(({ receiverBindings, calls }) => {
        const callees = Map.groupBy(calls ?? [], (call) => `${call.line}:${call.column}`);
        return { receiverBindings: receiverBindingsByPlace(receiverBindings), callees: new Map([...callees].map(([place, at]) => [place, at.map((call) => compactSpelling(call.name))])) };
      });
      syntaxIndexes.set(file, held);
    }
    return held;
  };
  const binder = syntaxOf === undefined || proofs === undefined ? undefined : createCallBinder({ store, navigation, declarations, syntaxIn: (file) => syntaxIn(syntaxOf, file), proofs, importedDeclarations: (file) => bindingsOf(file), callablesIn: async (file) => (await syntaxOf(file)).callables });
  const bindings = binder === undefined ? undefined : createCallBindings({ store, navigation, origins, binder, declarations, importedDeclarations: (file) => bindingsOf(file), ...(inScope === undefined ? {} : { inScope }) });
  /** Per file, the declaration each local name its imports bind reaches, when the join proves exactly one. */
  const bound = new Map<string, ReadonlyMap<string, GraphSymbol>>();
  let extracted: ReadonlyMap<string, readonly ModuleDependency[]> | undefined;

  async function bindingsOf(file: string): Promise<ReadonlyMap<string, GraphSymbol>> {
    let held = bound.get(file);
    if (held === undefined) {
      const dependencies = modules === undefined ? [] : "dependencies" in modules ? (extracted ??= Map.groupBy(modules.dependencies, (dependency) => dependency.file)).get(file) ?? [] : (await modules.reader.extract(modules.sources, { files: [file] })).dependencies.filter((dependency) => dependency.file === file);
      const byLocal = new Map<string, GraphSymbol[]>();
      for (const [binding, declaration] of await importBindings(store, file, dependencies, declarations)) {
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
    const typedKept: { followed: FollowedEdge; verdict: Extract<EdgeTarget, { kind: "keep" | "redirect" }> }[] = [];
    for (const followed of placed) {
      const verdict = typedVerdictOf(followed);
      if (verdict === undefined) fresh.push(followed);
      else if (verdict.kind === "keep" || verdict.kind === "redirect") typedKept.push({ followed, verdict });
      else verdicts.set(edgeKey(followed.edge), verdict);
    }
    const typedReceivers = typedKept.length === 0 ? [] : await receiversOf(typedKept.map(({ followed }) => followed), signal);
    for (const [index, { followed, verdict }] of typedKept.entries()) {
      const receiver = typedReceivers[index];
      verdicts.set(edgeKey(followed.edge), receiver === undefined ? verdict : { ...verdict, receiver });
    }
    if (fresh.length > 0) {
      const roots = await origins.rootOrigins(fresh.map(({ edge, source, target }) => ({ file: source.file, line: edge.line!, column: edge.column! + 1, kind: edge.kind, name: target.name })), signal);
      const lexical = await lexicalVerdictsOf(fresh, roots, signal);
      const kept: FollowedEdge[] = [];
      for (const [index, followed] of fresh.entries()) {
        const { edge, source, target } = followed;
        const root = roots[index];
        const shadowed = lexical.get(index);
        if (shadowed !== undefined) {
          verdicts.set(edgeKey(edge), shadowed);
          continue;
        }
        const proven = root === undefined || root.pastRoot === true || root.status !== "complete" || root.value.kind !== "repository" || root.bare !== true ? undefined : root.value.declared !== undefined ? await declarationAt(declarations, root.value.file, root.value.declared) : (await bindingsOf(source.file)).get(target.name);
        const verdict = root === undefined || root.pastRoot === true ? undefined : edgeVerdict<GraphNodeId>(root, proven?.id, target);
        if (verdict?.kind === "redirect") verdicts.set(edgeKey(edge), { kind: "redirect", to: proven! });
        else if (verdict?.kind === "drop" && root!.status === "complete") verdicts.set(edgeKey(edge), { kind: "drop", root: root!.value });
        else kept.push(followed);
      }
      const receivers = await receiversOf(kept, signal);
      const declared = await declaredMethodsOf(kept.filter((followed, index) => receivers[index] === undefined), signal);
      for (const [index, followed] of kept.entries()) {
        const receiver = receivers[index];
        const method = declared.get(followed);
        if (method !== undefined && method.id !== followed.target.id) verdicts.set(edgeKey(followed.edge), { kind: "redirect", to: method });
        else if (receiver === undefined) verdicts.set(edgeKey(followed.edge), KEEP);
        else if (binder === undefined || bindings === undefined) verdicts.set(edgeKey(followed.edge), { kind: "keep", receiver });
        else verdicts.set(edgeKey(followed.edge), await receiverVerdict(followed, receiver, binder, bindings));
      }
    }
    return edges.map(({ edge }) => verdicts.get(edgeKey(edge)) ?? KEEP);
  }

  /**
   * Per edge whose root is spelled alone and no origin proves, what the declaration of the file's own scope that binds the
   * root at the edge's place reaches: the edge stays when its target is that declaration, moves to the one the graph
   * places there otherwise, and reaches nothing the graph holds when the graph places none or several. An import of the
   * name, or any binding but a declaration, leaves the edge to the root's verdict.
   */
  async function lexicalVerdictsOf(edges: readonly FollowedEdge[], roots: readonly (RootOrigin | undefined)[], signal?: AbortSignal): Promise<ReadonlyMap<number, EdgeTarget>> {
    const asked = edges.flatMap((followed, index) => (roots[index]?.bare === true && roots[index].status !== "complete" ? [{ ...followed, index }] : []));
    if (asked.length === 0) return new Map();
    const bindings = await origins.rootBindings(asked.map(({ edge, source, target }): UseSite => ({ file: source.file, line: edge.line!, column: edge.column! + 1, spelled: target.name, owner: { name: source.name, line: source.startLine, endLine: source.endLine } })), signal);
    const found = new Map<number, EdgeTarget>();
    for (const [k, { source, target, index }] of asked.entries()) {
      const binding = bindings[k];
      if (binding?.kind !== "local" && binding?.kind !== "declared") continue;
      const declared = navigation.symbolsInFile(source.file).filter((symbol) => symbol.name === binding.root && !NOT_DECLARED_KINDS.includes(symbol.kind) && binding.lines.some((line) => symbol.startLine <= line && line <= symbol.endLine));
      if (declared.some((symbol) => symbol.id === target.id)) continue;
      found.set(index, declared.length === 1 ? { kind: "redirect", to: declared[0]! } : { kind: "drop", root: { kind: "lexical", name: binding.root } });
    }
    return found;
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
    const asked = edges.flatMap((followed, index) => (hasTyping(followed.source.file, "structural") && ((FIELD_KINDS as readonly string[]).includes(followed.target.kind) || navigation.ownersOf(followed.target).some((owner) => TYPE_KINDS.includes(owner.kind))) ? [{ ...followed, index }] : []));
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
   * What the base binds an edge on a value receiver to (ADR-0041 decision 4): `proven` at the declaration it binds, a
   * redirect from a homonym or a method above it, `proven` where its receiver's type offers that one declaration, and a
   * `name-match` otherwise. Dependence is the binding the language makes at compile time, so a declared type proves it
   * even where what runs is unproven.
   */
  async function receiverVerdict({ edge, source, target }: FollowedEdge, receiver: string, settle: CallBinder, bind: CallBindings): Promise<EdgeTarget> {
    const place = { file: source.file, line: edge.line!, column: edge.column! + 1 };
    const proof = await settle.receiverOf({ body: source, ...place, member: target.name, receiver });
    const binding = await bind.ofReceiver(proof, target.name, [target], place);
    if (binding.target !== undefined && binding.target.id !== target.id) return { kind: "redirect", to: binding.target, receiver };
    const offered = binding.candidates.length === 1 && binding.candidates[0]!.id === target.id && binding.attributed.length > 0;
    return { kind: "keep", receiver, derivation: binding.target !== undefined || offered ? "proven" : "name-match" };
  }

  /** Per Java call edge, the method the receiver reading names at its place (ADR-0044 decision 1); none where it settles nothing. */
  async function declaredMethodsOf(edges: readonly FollowedEdge[], signal?: AbortSignal): Promise<ReadonlyMap<FollowedEdge, GraphSymbol>> {
    const asked = bindings === undefined ? [] : edges.filter(({ edge, source }) => edge.kind === "calls" && hasTyping(source.file, "nominal"));
    if (bindings === undefined || asked.length === 0) return new Map();
    const found = await origins.receiverMethods(asked.map(({ edge, source, target }) => ({ file: source.file, line: edge.line!, column: edge.column! + 1, member: target.name })), signal);
    return new Map(asked.flatMap((followed, index) => {
      const { edge, source, target } = followed;
      const call = { body: source, reference: { from: source.id, file: source.file, line: edge.line!, column: edge.column!, name: target.name, kind: edge.kind, candidates: [] } };
      const settled = bindings.settleDeclared({ kind: "declared", member: target.name, form: "member", call }, found[index]);
      return settled.kind === "declaration" ? [[followed, settled.target] as const] : [];
    }));
  }

  return {
    verdictsOf,
    importedDeclarations: bindingsOf,
    binder,
    bindings,
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
