import { sharesRuntime } from "../../domain/languages/call-targets.ts";
import { isChaining, profileOf } from "../../domain/languages/profiles.ts";
import { isClassKind } from "../../domain/impact/edge-policy.ts";
import { calleeOf } from "../../domain/shared/call-place.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphEdge, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { CallBindings, SettledBinding, UnboundCall } from "./call-binding.ts";
import type { FollowedEdge } from "./edge-targets.ts";
import type { GraphNavigation } from "./graph-navigation.ts";
import type { ReconciledCalls } from "./reconciled-calls.ts";

/** A recovered call nothing binds that is attributed to a reached declaration (ADR-0041 decision 8): a cut at the call. */
export interface AttributedCall {
  node: GraphSymbol;
  call: UnboundCall;
}

/**
 * The calls into declarations a reverse walk reached that the index does not record (ADR-0041 decision 8): the written
 * calls no record matches, `deferred` ones included, looked up by the name each spells as its callee and bound by the
 * base. A bound call is an edge into the declaration; an unbound one is a cut only when attributed to it.
 */
export interface ReverseCalls {
  into(nodes: readonly GraphSymbol[], signal?: AbortSignal): Promise<{ edges: readonly FollowedEdge[]; attributed: readonly AttributedCall[] }>;
}

export interface ReverseCallsDeps {
  store: CodeGraphReader;
  navigation: GraphNavigation;
  reconciled: ReconciledCalls;
  bindings: CallBindings;
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

export function createReverseCalls({ store, navigation, reconciled, bindings, importedDeclarations, sources, constructs, retained }: ReverseCallsDeps): ReverseCalls {
  const contents = new Map<string, string>();
  const byName = new Map<string, UnboundCall[]>();
  const aligned = new Set<string>();
  const bound = new Map<UnboundCall, Promise<SettledBinding>>();
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
    return calls.flatMap(({ writtenOnly, deferredOnly }) => [...writtenOnly, ...deferredOnly]);
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
    const aliases = async (target: GraphSymbol): Promise<void> => {
      const importing = store.symbolsByIds([...new Set(store.incomingEdges([target.id], ["imports"]).map((edge) => edge.source))]);
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
    async into(nodes, signal) {
      const asked = await Promise.all(nodes.map(async (node) => ({ node, keys: await keysOf(node) })));
      await align(asked.flatMap(({ keys }) => keys));
      const candidates = asked.map(({ node, keys }) => ({
        node,
        calls: [...new Set(keys.flatMap(({ name, files }) => (byName.get(name) ?? []).filter((call) => (files === undefined || files.has(call.reference.file)) && sharesRuntime(call.reference.file, node.file))))],
      }));
      const fresh = [...new Set(candidates.flatMap(({ calls }) => calls))].filter((call) => !bound.has(call));
      if (fresh.length > 0) {
        const settled = bindings.boundCalls(fresh, signal);
        for (const [index, call] of fresh.entries()) bound.set(call, settled.then((all) => all[index]!));
      }
      const edges: FollowedEdge[] = [];
      const attributed: AttributedCall[] = [];
      for (const { node, calls } of candidates) {
        for (const call of calls) {
          const binding = await bound.get(call)!;
          if (reaches(binding, call, node)) {
            const edge: GraphEdge = { source: call.body.id, target: node.id, kind: call.reference.kind, line: call.reference.line, column: call.reference.column, confidence: null, provenance: null, synthesizedBy: null, resolvedFrom: null };
            edges.push({ edge, source: call.body, target: node });
          } else if ((binding.kind === "unbound" || binding.kind === "receiver") && binding.attributed.some((symbol) => symbol.id === node.id)) {
            attributed.push({ node, call });
          }
        }
      }
      return { edges, attributed };
    },
  };
}
