import { sharesRuntime } from "../../domain/languages/call-targets.ts";
import { isChaining, profileOf } from "../../domain/languages/profiles.ts";
import { isClassKind } from "../../domain/impact/edge-policy.ts";
import { calleeOf } from "../../domain/shared/call-place.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";
import { receiverSiteOf, type CallBindings, type SettledBinding, type UnboundCall } from "./call-binding.ts";
import type { FollowedEdge } from "./edge-targets.ts";
import type { GraphNavigation } from "./graph-navigation.ts";
import type { BodyCalls, ReconciledCalls } from "./reconciled-calls.ts";
import type { ModelDeclaration } from "./declaration-model.ts";
import { ANYTHING, type Cut } from "../../domain/shared/fact.ts";
import { placeAt, referenceKey } from "../../domain/impact/impact-cuts.ts";

export interface DeclarationCaller {
  from: GraphSymbol;
  declaration: ModelDeclaration;
  line: number;
  column: number;
  kind: string;
}

/** A recovered call nothing binds that is attributed to a reached declaration (ADR-0041 decision 8): a cut at the call. */
export interface AttributedCall {
  node: GraphSymbol;
  call: UnboundCall;
}

/**
 * An index reference `into` looked up for a reached declaration whose binding decides whether it may call it (ADR-0079
 * decision 3), by the reference's occurrence key. `via`: the caller, when the compile-time binding is an edge into the
 * declaration. `away`: the declarations the binding names instead, none when it binds outside the repository or to
 * generated code, when the declaration is among the candidates a cut attributes it to, or when the receiver's declared
 * type lies outside the repository and the declaration cannot run under it (decisions 4 and 5).
 */
export type SettledReference = { node: GraphSymbol; occurrence: string } & ({ via: GraphSymbol } | { away: readonly GraphSymbol[] });

/**
 * The calls into declarations a reverse walk reached that the index does not record (ADR-0041 decision 8): the written
 * calls no record matches, `deferred` ones included, looked up by the name each spells as its callee and bound by the
 * base. A bound call is an edge into the declaration; an unbound one is a cut only when attributed to it.
 */
export interface ReverseCalls {
  into(nodes: readonly GraphSymbol[], signal?: AbortSignal): Promise<{ edges: readonly FollowedEdge[]; attributed: readonly AttributedCall[]; settled: readonly SettledReference[] }>;
  intoDeclarations(nodes: readonly ModelDeclaration[], signal?: AbortSignal): Promise<{ callers: readonly DeclarationCaller[]; cuts: readonly Cut[] }>;
}

export interface ReverseCallsDeps {
  store: CodeGraphReader;
  navigation: GraphNavigation;
  reconciled: ReconciledCalls;
  bindings: CallBindings;
  /** The receiver methods a `declared` binding waits on, read as the base reads them, so a `generated` answer is told apart. */
  origins: Pick<ImportOrigins, "receiverMethods">;
  importedDeclarations: (file: string) => Promise<ReadonlyMap<string, GraphSymbol>>;
  /** The read's sources a syntax reader parses, with their text. */
  sources: readonly SourceFile[];
  /** Whether a declaration's syntax states it is a constructor, for one the index holds outside any class (a record's). */
  constructs: (node: GraphSymbol) => Promise<boolean>;
  /** Where a read keeps each source's alignment, under the digest of the index it aligned with; none keeps nothing. */
  retained?: { facts: DerivedFacts; index: string };
}

const REVERSE_NAMES = "reverse-looked-up-names";
const REVERSE_UNBOUND = "reverse-unbound-calls";

/** The name a written call is looked up by: its callee, a constructed class's last name, or the chaining keyword, which a reader spells with no callee. */
function lookupName(file: string, name: string): string | undefined {
  if (isChaining(file, name)) return name;
  const callee = calleeOf(name.replace(/<[^]*$/, ""));
  return callee.form === "computed" ? undefined : callee.name;
}

/** A name a reached declaration is looked up by, in every file or only in `files`. */
interface LookupKey {
  name: string;
  files?: ReadonlySet<string>;
}

/** The calls a body writes that no index record matches, `deferred` ones included, in written order. */
export function unmatchedCalls({ writtenOnly, deferredOnly }: Pick<BodyCalls, "writtenOnly" | "deferredOnly">): GraphUnresolvedReference[] {
  return [...writtenOnly, ...deferredOnly];
}

/** A settled binding, and whether the receiver reading it waited on answered that generated code supplies the member. */
interface ReadBinding {
  binding: SettledBinding;
  generated: boolean;
}

/**
 * What a binding that neither reaches nor is attributed to a declaration names instead: another declaration (not the class
 * whose constructor the declaration is), nothing when it lies outside the repository or in generated code, or the
 * candidates it is attributed among; `undefined` when it proves nothing.
 */
function boundAway({ binding, generated }: ReadBinding, constructed: GraphSymbol | undefined): readonly GraphSymbol[] | undefined {
  if (generated || binding.kind === "outside" || (binding.kind === "receiver" && binding.outside === true)) return [];
  const target = binding.kind === "declaration" || binding.kind === "receiver" ? binding.target : undefined;
  if (target !== undefined) return target.id === constructed?.id ? undefined : [target];
  return binding.kind !== "declaration" && binding.attributed.length > 0 ? binding.attributed : undefined;
}

export function createReverseCalls({ store, navigation, reconciled, bindings, origins, importedDeclarations, sources, constructs, retained }: ReverseCallsDeps): ReverseCalls {
  const contents = new Map<string, string>();
  const byName = new Map<string, UnboundCall[]>();
  const aligned = new Set<string>();
  const bound = new Map<UnboundCall, { batch: Promise<readonly ReadBinding[]>; index: number }>();
  const bindingOf = async (call: UnboundCall): Promise<ReadBinding> => {
    const { batch, index } = bound.get(call)!;
    return (await batch)[index]!;
  };
  async function bindAll(calls: readonly UnboundCall[], signal?: AbortSignal): Promise<readonly ReadBinding[]> {
    const read = await bindings.bindCalls(calls, signal);
    const pending = read.flatMap((binding) => (binding.kind === "declared" ? [binding] : []));
    const found = pending.length === 0 ? [] : await origins.receiverMethods(pending.map(receiverSiteOf), signal);
    let next = 0;
    return read.map((binding) => {
      if (binding.kind !== "declared") return { binding, generated: false };
      const answer = found[next++];
      return { binding: bindings.settleDeclared(binding, answer), generated: answer?.kind === "generated" };
    });
  }
  async function bindFresh(calls: readonly UnboundCall[], signal?: AbortSignal): Promise<void> {
    const fresh = [...new Set(calls)].filter((call) => !bound.has(call));
    if (fresh.length === 0) return;
    const settled = bindAll(fresh, signal);
    for (const [index, call] of fresh.entries()) bound.set(call, { batch: settled, index });
    await settled;
  }
  const words = new Map<string, ReadonlySet<string>>();
  const wordsOf = (file: SourceFile): ReadonlySet<string> => {
    let found = words.get(file.path);
    if (found === undefined) {
      found = new Set(file.content.match(/[A-Za-z_$][\w$]*/g) ?? []);
      words.set(file.path, found);
    }
    return found;
  };

  /**
   * Aligns the sources not aligned yet with a written call looked up by one of `keys` there (ADR-0041 open question 1):
   * their text spells the key, and so does a call one of their declarations owns, the only calls alignment leaves unmatched.
   * A retained alignment naming a body the index no longer holds is not used: the source is aligned again.
   */
  async function align(keys: readonly LookupKey[]): Promise<void> {
    const keysIn = (file: string): ReadonlySet<string> => new Set(keys.flatMap(({ name, files }) => (files === undefined || files.has(file) ? [name] : [])));
    const spelled = sources.filter((file) => !aligned.has(file.path) && [...keysIn(file.path)].some((name) => wordsOf(file).has(name)));
    for (const file of spelled) {
      const looked = keysIn(file.path);
      if (!(await lookedUpIn(file)).some((name) => looked.has(name))) continue;
      aligned.add(file.path);
      let references = await retainedOf(REVERSE_UNBOUND, file, () => unboundIn(file));
      let bodies = bodiesOf(references);
      if (references.some(({ from }) => !bodies.has(from))) {
        references = await unboundIn(file);
        bodies = bodiesOf(references);
      }
      for (const reference of references) {
        const name = lookupName(reference.file, reference.name);
        const body = bodies.get(reference.from);
        if (name !== undefined && body !== undefined) byName.set(name, [...(byName.get(name) ?? []), { body, reference }]);
      }
    }
  }

  /** The names the calls a source's declarations own are looked up by. */
  function lookedUpIn(file: SourceFile): Promise<readonly string[]> {
    return retainedOf(REVERSE_NAMES, file, async () => {
      const owned = await reconciled.ownedIn(file.path);
      return [...new Set([...owned.values()].flatMap((calls) => calls.flatMap((call) => lookupName(file.path, call.name) ?? [])))].sort(compareText);
    });
  }

  /** A source's written calls alignment leaves unmatched, `deferred` ones included, by body in the index's order. */
  async function unboundIn(file: SourceFile): Promise<readonly GraphUnresolvedReference[]> {
    const calls = await Promise.all(store.symbolsInFiles([file.path]).map((body) => reconciled.callsOf(body)));
    return calls.flatMap((body) => [...body.references, ...unmatchedCalls(body)]);
  }

  function bodiesOf(references: readonly GraphUnresolvedReference[]): ReadonlyMap<GraphNodeId, GraphSymbol> {
    return new Map(store.symbolsByIds([...new Set(references.map(({ from }) => from))]).map((body) => [body.id, body]));
  }

  /** What `derive` answers for a source, kept by its path, its content and the index digest when the read has both (ADR-0041 decision 9). */
  function retainedOf<T>(slot: string, file: SourceFile, derive: () => Promise<T>): Promise<T> {
    if (retained === undefined) return derive();
    let content = contents.get(file.path);
    if (content === undefined) {
      content = retained.facts.fingerprint({ content: file.content });
      contents.set(file.path, content);
    }
    return retained.facts.ofInputs(slot, { index: retained.index, path: file.path, content }, derive);
  }

  /** The names a reached declaration is looked up by (ADR-0041 decision 8): its own, its proven import aliases, and for a class or its constructor `new` and its language's constructor chaining. */
  async function keysOf(node: GraphSymbol): Promise<LookupKey[]> {
    const keys: LookupKey[] = [{ name: node.name }];
    /** The local names other files bind the declaration to, by the resolution the binder reads: an import whose edge reaches the declaration or its file. */
    const aliases = async (target: GraphSymbol): Promise<void> => {
      const reached = [target.id, ...store.symbolsInFiles([target.file]).filter((symbol) => symbol.kind === "file").map((symbol) => symbol.id)];
      const importing = store.symbolsByIds([...new Set(store.incomingEdges(reached, ["imports"]).map((edge) => edge.source))]);
      for (const file of new Set(importing.map((symbol) => symbol.file))) {
        for (const [local, declaration] of await importedDeclarations(file)) if (declaration.id === target.id && local !== target.name) keys.push({ name: local, files: new Set([file]) });
      }
    };
    await aliases(node);
    const type = typeConstructed(node);
    if (type !== undefined) {
      if (type.id !== node.id) {
        keys.push({ name: type.name });
        await aliases(type);
      }
      const chaining = profileOf(type.file)?.chaining;
      if (chaining !== undefined) {
        const subclasses = store.symbolsByIds(store.incomingEdges([type.id], ["extends"]).map((edge) => edge.source));
        keys.push({ name: chaining.inherited, files: new Set(subclasses.map((subclass) => subclass.file)) }, { name: chaining.own, files: new Set([type.file]) });
      }
    } else {
      const own = profileOf(node.file)?.chaining?.own;
      if (own !== undefined && node.kind === "function" && navigation.ownersOf(node).length === 0 && (await constructs(node))) keys.push({ name: own, files: new Set([node.file]) });
    }
    return keys;
  }

  /** The class a declaration constructs: the class itself, or the class whose constructor it is. */
  function typeConstructed(node: GraphSymbol): GraphSymbol | undefined {
    if (isClassKind(node.kind)) return node;
    const [owner] = navigation.ownersOf(node).filter((type) => isClassKind(type.kind));
    return owner !== undefined && (node.name === owner.name || node.name === "constructor") ? owner : undefined;
  }

  /** Whether a binding reaches `node`: its target, or for `new C()` the one constructor `node` is of the class it binds. */
  function reaches(binding: SettledBinding, call: UnboundCall, node: GraphSymbol): boolean {
    const target = binding.kind === "declaration" || binding.kind === "receiver" ? binding.target : undefined;
    if (target === undefined) return false;
    if (target.id === node.id) return true;
    const constructors = call.reference.kind === "instantiates" && isClassKind(target.kind) ? navigation.membersOf(target).filter((member) => typeConstructed(member)?.id === target.id) : [];
    return constructors.length === 1 && constructors[0]!.id === node.id;
  }

  return {
    async intoDeclarations(nodes, signal) {
      await align(nodes.map(({ name }) => ({ name })));
      const calls = [...new Set(nodes.flatMap(({ name }) => byName.get(name) ?? []))];
      await bindFresh(calls, signal);
      const found: DeclarationCaller[] = [];
      const cuts: Cut[] = [];
      for (const call of calls) {
        const { binding } = await bindingOf(call);
        const declaration = binding.kind === "receiver" ? binding.declaration : undefined;
        if (declaration === undefined) {
          if (binding.kind === "unbound" || (binding.kind === "receiver" && (!binding.outside || binding.dispatch !== undefined))) cuts.push({ kind: "unresolved-link", reason: "receiver-unproven", at: [placeAt(call.reference.file, call.reference.line, call.reference.name), ...nodes.filter(({ name }) => name === lookupName(call.reference.file, call.reference.name)).map((node) => placeAt(node.file, node.startLine, node.path ?? node.name))], reach: ANYTHING });
          continue;
        }
        const target = nodes.find(({ id }) => id === declaration.id);
        if (target !== undefined) found.push({ from: call.body, declaration: target, line: call.reference.line, column: call.reference.column, kind: call.reference.kind });
      }
      return { callers: found, cuts };
    },
    async into(nodes, signal) {
      const asked = await Promise.all(nodes.map(async (node) => ({ node, keys: await keysOf(node) })));
      await align(asked.flatMap(({ keys }) => keys));
      const candidates = asked.map(({ node, keys }) => ({
        node,
        calls: [...new Set(keys.flatMap(({ name, files }) => (byName.get(name) ?? []).filter((call) => (files === undefined || files.has(call.reference.file)) && sharesRuntime(call.reference.file, node.file))))],
      }));
      await bindFresh(candidates.flatMap(({ calls }) => calls), signal);
      const edges: FollowedEdge[] = [];
      const attributed: AttributedCall[] = [];
      const settled: SettledReference[] = [];
      for (const { node, calls } of candidates) {
        const constructed = typeConstructed(node);
        for (const call of calls) {
          const read = await bindingOf(call);
          const { binding } = read;
          const occurrence = referenceKey(call.reference);
          if (reaches(binding, call, node)) {
            const edge: GraphEdge = { source: call.body.id, target: node.id, kind: call.reference.kind, line: call.reference.line, column: call.reference.column, confidence: null, provenance: null, synthesizedBy: null, resolvedFrom: null };
            edges.push({ edge, source: call.body, target: node });
            if (occurrence !== undefined && binding.kind === "declaration") settled.push({ node, occurrence, via: call.body });
          } else if ((binding.kind === "unbound" || binding.kind === "receiver") && binding.attributed.some((symbol) => symbol.id === node.id)) {
            attributed.push({ node, call });
            if (occurrence !== undefined) settled.push({ node, occurrence, away: [] });
          } else if (occurrence !== undefined && binding.kind === "receiver" && binding.dispatch !== undefined) {
            if (!(await bindings.mayRunUnder(binding.dispatch, node, signal))) settled.push({ node, occurrence, away: [] });
          } else if (occurrence !== undefined) {
            const away = boundAway(read, constructed);
            if (away !== undefined) settled.push({ node, occurrence, away });
          }
        }
      }
      return { edges, attributed, settled };
    },
  };
}
