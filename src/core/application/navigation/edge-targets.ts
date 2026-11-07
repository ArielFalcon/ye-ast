import { edgeVerdict, FOLLOWED_EDGE_KINDS, type EdgeVerdict } from "../../domain/impact/edge-policy.ts";
import { isTypeScriptFile } from "../../domain/languages/typescript.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames, ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { ModuleDependencies, ModuleDependency } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { createGraphNavigation } from "./graph-navigation.ts";
import { declarationAt, importBindings } from "./import-bindings.ts";

/**
 * What the edges the graph resolved really reach, read from the root of the name each spells at its position through
 * the source file's own bindings (`ImportOrigins.rootOrigins`) and, for a root an import binds, the declaration the
 * module statements and the graph's `imports` edges join it to (`importBindings`). An edge whose root proof reads past
 * its root (`RootOrigin.pastRoot`) is kept: the root says where the chain starts, not what the call runs. A kept edge of a
 * TypeScript source into a member of a class whose receiver is a value names that receiver (`EdgeTarget.receiver`): the
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
 * declarations. `receiver` is the value a kept member call is made on: the field's name for `this.f.m`, the parameter's or
 * variable's root for `v.m`, and empty for a call result or another expression.
 */
export type EdgeTarget = Exclude<EdgeVerdict<GraphSymbol>, { kind: "keep" | "drop" }> | { kind: "keep"; receiver?: string } | { kind: "drop"; root: ImportOrigin };

const KEEP: EdgeTarget = { kind: "keep" };
const IMPORT = "imports";
/** Declarations that hold a value, which a call may find any object in. */
const VALUE_KINDS: readonly string[] = ["constant", "variable"];
/** The types whose members a value receiver may stand for. */
const CLASS_KINDS: readonly string[] = ["class", "component"];

const bindingKey = (line: number, column: number, member: string): string => `${line}:${column}:${member}`;

export function createEdgeTargets({ origins, store, modules, syntaxOf }: EdgeTargetsDeps): EdgeTargets {
  const verdicts = new Map<string, EdgeTarget>();
  const navigation = createGraphNavigation(store, () => false);
  const receiverBindings = new Map<string, Promise<ReadonlyMap<string, ReceiverBinding | "ambiguous">>>();
  const bindingsIn = (read: (file: string) => Promise<DeclaredMemberNames>, file: string): Promise<ReadonlyMap<string, ReceiverBinding | "ambiguous">> => {
    let held = receiverBindings.get(file);
    if (held === undefined) {
      held = read(file).then(({ receiverBindings: found }) => {
        const byPlace = new Map<string, ReceiverBinding | "ambiguous">();
        for (const binding of found) {
          const key = bindingKey(binding.line, binding.column, binding.member);
          byPlace.set(key, byPlace.has(key) ? "ambiguous" : binding);
        }
        return byPlace;
      });
      receiverBindings.set(file, held);
    }
    return held;
  };
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
    const fresh = [...new Map(edges.filter(({ edge }) => edge.line !== null && edge.column !== null && !verdicts.has(edgeKey(edge))).map((followed) => [edgeKey(followed.edge), followed])).values()];
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
      for (const [index, { edge }] of kept.entries()) {
        const receiver = receivers[index];
        verdicts.set(edgeKey(edge), receiver === undefined ? KEEP : { kind: "keep", receiver });
      }
    }
    return edges.map(({ edge }) => verdicts.get(edgeKey(edge)) ?? KEEP);
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
    const asked = edges.flatMap((followed, index) => (isTypeScriptFile(followed.source.file) && navigation.ownersOf(followed.target).some((owner) => CLASS_KINDS.includes(owner.kind)) ? [{ ...followed, index }] : []));
    if (asked.length === 0) return [];
    const bindings = await origins.rootBindings(asked.map(({ edge, source, target }): UseSite => ({ file: source.file, line: edge.line!, column: edge.column! + 1, spelled: target.name, owner: { name: source.name, line: source.startLine, endLine: source.endLine } })), signal);
    /** The body's own binding, or a declaration of the file the index holds as no class, function or other non-value node. */
    const isValue = (file: string, binding: RootBinding | undefined): binding is Extract<RootBinding, { kind: "local" | "declared" }> =>
      binding?.kind === "local" ||
      (binding?.kind === "declared" && !navigation.symbolsInFile(file).some((symbol) => symbol.name === binding.root && !VALUE_KINDS.includes(symbol.kind) && binding.lines.some((line) => symbol.startLine <= line && line <= symbol.endLine)));
    const receivers: (string | undefined)[] = [];
    for (const [k, { edge, source, target, index }] of asked.entries()) {
      const bound = (await bindingsIn(read, source.file)).get(bindingKey(edge.line!, edge.column! + 1, target.name));
      const binding = bindings[k];
      if (bound !== undefined) receivers[index] = bound === "ambiguous" ? "" : bound.receiver;
      else if (binding?.kind === "this") receivers[index] = binding.member === undefined || binding.member === target.name ? undefined : binding.member;
      else if (isValue(source.file, binding)) receivers[index] = binding.root;
    }
    return receivers;
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
