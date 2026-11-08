import { mayRunDeclarationOf } from "../../domain/languages/call-targets.ts";
import { isJavaSource } from "../../domain/languages/java.ts";
import { isClassKind } from "../../domain/impact/edge-policy.ts";
import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import { calleeOf, compactSpelling, ownMemberOf, receiverOf } from "../../domain/shared/call-place.ts";
import type { CodeGraphReader, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOrigins, ReceiverCallSite, ReceiverMethod } from "../../ports/import-origins.port.ts";
import type { CallBinder, ReceiverProof } from "./call-binder.ts";
import { ownMembersOf, type GraphNavigation } from "./graph-navigation.ts";

/** A call the index left without a target: its body, and the reference the index or the syntax states for it. */
export interface UnboundCall {
  body: GraphSymbol;
  reference: GraphUnresolvedReference;
}

type Outside = Extract<ImportOrigin, { kind: "external" | "ambient" }>;

/**
 * Which declaration a call the index left without a target binds to at compile time (ADR-0041 decision 4), by the first
 * link of one chain:
 * - `declaration`: the body's own member (`this.m`), the constructor `super(...)` or `this(...)` chains to, the
 *   declaration a bare name's import or the file's own scope binds, or the method a Java receiver's declared type names;
 * - `receiver`: a member call whose receiver a proof decides, with the declaration the proof binds it to, if any;
 * - `outside`: a bare name or a plain chain rooted at a package or the language's libraries;
 * - `unbound`: nothing binds it, with the declarations of its name the language rule admits (`candidates`) and those
 *   the call is attributed to (`attributed`): the members of `this` it may run, the constructors its chaining may run,
 *   the declarations of its file a bare name may name, or the members of its receiver's proven type.
 * `form` tells how the call spells its callee, for a family that settles each form its own way.
 */
export type CallBinding =
  | { kind: "declaration"; target: GraphSymbol; link: "own-member" | "chain" | "import" | "file" | "declared-receiver" }
  | { kind: "receiver"; proof: ReceiverProof; target?: GraphSymbol; outside?: true; candidates: readonly GraphSymbol[]; attributed: readonly GraphSymbol[] }
  | { kind: "outside"; form: "bare" | "chain"; origin: Outside }
  | { kind: "unbound"; form: "own" | "computed" | "bare" | "member" | "chain"; candidates: readonly GraphSymbol[]; attributed: readonly GraphSymbol[] }
  | DeclaredBinding;

/**
 * A call that only the method its receiver's declared type names can bind (a Java call, `super(...)` or `this(...)`):
 * `receiverSiteOf` is the site to read, which a family reads with its own sites at once, and `settleDeclared` the binding
 * the answer gives.
 */
export interface DeclaredBinding {
  kind: "declared";
  member: string;
  form: "bare" | "member" | "chain";
  call: UnboundCall;
}

/** A binding no read is pending on. */
export type SettledBinding = Exclude<CallBinding, DeclaredBinding>;

/** The receiver-method site a `declared` binding waits on. */
export function receiverSiteOf({ member, call: { reference } }: DeclaredBinding): ReceiverCallSite {
  return { file: reference.file, line: reference.line, column: reference.column + 1, member };
}

/** The one owner of what a call the index left without a target binds to, for every family (ADR-0041 decisions 1 and 4). */
export interface CallBindings {
  /** One binding per call, in the order given; the reads each link needs are made once for all of them, save the receiver methods a `declared` binding waits on. */
  bindCalls(calls: readonly UnboundCall[], signal?: AbortSignal): Promise<readonly CallBinding[]>;
  /** What the method a `declared` binding's receiver reading names settles it to. */
  settleDeclared(binding: DeclaredBinding, method: ReceiverMethod | undefined): SettledBinding;
  /** `bindCalls` with every `declared` binding settled through one read of the receiver methods. */
  boundCalls(calls: readonly UnboundCall[], signal?: AbortSignal): Promise<readonly SettledBinding[]>;
  /** The declarations of `name` a call written in `from` may run, in scope; `values` leaves out the kinds only types have. */
  namedDeclarations(name: string, from: string, values?: boolean): readonly GraphSymbol[];
  /** What a member call of `member` binds to by what its receiver's proof decides, attributed among `candidates`. */
  ofReceiver(proof: ReceiverProof, member: string, candidates: readonly GraphSymbol[]): Extract<CallBinding, { kind: "receiver" }>;
}

export interface CallBindingsDeps {
  store: CodeGraphReader;
  navigation: GraphNavigation;
  origins: ImportOrigins;
  binder: CallBinder;
  importedDeclarations: (file: string) => Promise<ReadonlyMap<string, GraphSymbol>>;
  /** Whether a declaration's file is in the read's scope; every file by default. */
  inScope?: (path: string) => boolean;
}

const TYPE_ONLY_KINDS: readonly string[] = ["interface", "type_alias"];
const CALLABLE_KINDS: readonly string[] = ["method", "function"];
const PLAIN_CHAIN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
const CHAINING: readonly string[] = ["super", "this"];

const isOutside = (origin: ImportOrigin | undefined): origin is Outside => origin?.kind === "external" || origin?.kind === "ambient";

export function createCallBindings({ store, navigation, origins, binder, importedDeclarations, inScope = () => true }: CallBindingsDeps): CallBindings {
  const named = new Map<string, readonly GraphSymbol[]>();
  function namedDeclarations(name: string, from: string, values = false): readonly GraphSymbol[] {
    let found = named.get(name);
    if (found === undefined) {
      found = store.declarationsNamed([name]).filter((symbol) => inScope(symbol.file) && !NOT_DECLARED_KINDS.includes(symbol.kind));
      named.set(name, found);
    }
    return found.filter((symbol) => mayRunDeclarationOf(from, symbol.file) && (!values || !TYPE_ONLY_KINDS.includes(symbol.kind)));
  }

  /** The one declaration of `kinds` the index places between a declaration's first token and its name. */
  const placed = (file: string, start: number, nameLine: number): GraphSymbol | undefined => {
    const found = store.symbolsInFiles([file]).filter((symbol) => CALLABLE_KINDS.includes(symbol.kind) && start <= symbol.startLine && symbol.startLine <= nameLine);
    return found.length === 1 ? found[0] : undefined;
  };

  /**
   * The constructors of the class a chaining call in `body` runs one of: its own class's for `this`, its superclass's
   * for `super`. The index holds a record's constructors as functions of no container, so `this` in one of them runs
   * another function of its file with its name.
   */
  const classesOf = (body: GraphSymbol): readonly GraphSymbol[] => navigation.ownersOf(body).filter((owner) => isClassKind(owner.kind));
  const superclassesOf = (types: readonly GraphSymbol[]): readonly GraphSymbol[] => store.symbolsByIds(store.outgoingEdges(types.map((type) => type.id), ["extends"]).map((edge) => edge.target)).filter((type) => isClassKind(type.kind));
  const chainedConstructors = (body: GraphSymbol, keyword: string): readonly GraphSymbol[] => {
    const own = classesOf(body);
    if (own.length === 0) return keyword === "this" && body.kind === "function" ? navigation.symbolsInFile(body.file).filter((symbol) => symbol.kind === "function" && symbol.name === body.name && symbol.id !== body.id && navigation.ownersOf(symbol).length === 0) : [];
    const types = keyword === "this" ? own : superclassesOf(own);
    return types.flatMap((type) => navigation.membersOf(type).filter((member) => member.kind === "method" && member.name === type.name && member.id !== body.id));
  };

  /** The declaration a bare name binds in its own file: an import's, a located one, or the file's own declaration of it. */
  async function bareDeclaration({ body, reference }: UnboundCall, name: string, bound: Awaited<ReturnType<ImportOrigins["rootBindings"]>>[number] | undefined): Promise<CallBinding | undefined> {
    const imported = (await importedDeclarations(reference.file)).get(name);
    if (imported !== undefined) return { kind: "declaration", target: imported, link: "import" };
    if (bound?.kind !== "declared" || bound.captured) return undefined;
    const declared = navigation.symbolsInFile(reference.file).filter((symbol) => symbol.name === name && symbol.id !== body.id && !NOT_DECLARED_KINDS.includes(symbol.kind) && bound.lines.some((line) => symbol.startLine <= line && line <= symbol.endLine));
    return declared.length === 1 ? { kind: "declaration", target: declared[0]!, link: "file" } : undefined;
  }

  /** What a member call's receiver proof binds it to: the method the proof places, or the member the proven type has. */
  function proven(proof: ReceiverProof, name: string, candidates: readonly GraphSymbol[]): Extract<CallBinding, { kind: "receiver" }> {
    const typed = (type: GraphSymbol | undefined) => {
      const target = type === undefined ? undefined : binder.memberOf(type, name);
      return { ...(target === undefined ? {} : { target }), attributed: target !== undefined || type === undefined ? [] : candidates.filter((candidate) => binder.declares(type, candidate)) };
    };
    if (proof.link === "member") return { kind: "receiver", proof, candidates, attributed: [], ...(proof.method === undefined ? {} : { target: proof.method }) };
    if (proof.link === "external") return { kind: "receiver", proof, candidates, attributed: [], outside: true };
    if (proof.link === "field" || proof.link === "local") return "external" in proof.holds ? { kind: "receiver", proof, candidates, attributed: [], outside: true } : { kind: "receiver", proof, candidates, ...typed(proof.type) };
    if (proof.link === "syntax" && proof.holds.kind === "literal") return { kind: "receiver", proof, candidates, attributed: [], outside: true };
    if (proof.link === "syntax" && proof.unspelled !== true && ["declared", "annotated", "constructed"].includes(proof.holds.kind)) return { kind: "receiver", proof, candidates, ...typed(proof.type) };
    return { kind: "receiver", proof, candidates, attributed: [] };
  }

  async function bindCalls(calls: readonly UnboundCall[], signal?: AbortSignal): Promise<readonly CallBinding[]> {
    const bindings: (CallBinding | undefined)[] = calls.map(() => undefined);
    const bare: { index: number; name: string }[] = [];
    const typed: { index: number; member: string; site: UnboundCall }[] = [];
    const rooted: { index: number; member: string }[] = [];
    for (const [index, call] of calls.entries()) {
      const { body, reference } = call;
      const java = isJavaSource(reference.file);
      const own = ownMemberOf(compactSpelling(reference.name));
      const members = own === undefined || java ? [] : ownMembersOf(navigation, body, own, ["method"]);
      if (members.length === 1) bindings[index] = { kind: "declaration", target: members[0]!, link: "own-member" };
      else if (members.length > 1) bindings[index] = { kind: "unbound", form: "own", candidates: members, attributed: members };
      else if (java && CHAINING.includes(reference.name)) typed.push({ index, member: reference.name, site: call });
      else {
        const callee = calleeOf(reference.name);
        if (callee.form === "computed") bindings[index] = { kind: "unbound", form: "computed", candidates: [], attributed: [] };
        else if (callee.form === "bare") bare.push({ index, name: callee.name });
        else {
          const candidates = namedDeclarations(callee.name, reference.file, true);
          const proof = await binder.receiverOf({ body, line: reference.line, column: reference.column + 1, member: callee.name, receiver: receiverOf(compactSpelling(reference.name)) ?? "", spelling: reference.name });
          if (proof.link !== "none") bindings[index] = proven(proof, callee.name, candidates);
          else if (PLAIN_CHAIN.test(compactSpelling(reference.name)) && !reference.name.startsWith("this.")) rooted.push({ index, member: callee.name });
          else typed.push({ index, member: callee.name, site: call });
        }
      }
    }
    if (rooted.length > 0) {
      const roots = await origins.rootOrigins(rooted.map(({ index, member }) => ({ file: calls[index]!.reference.file, line: calls[index]!.reference.line, column: calls[index]!.reference.column + 1, kind: calls[index]!.reference.kind, name: member })), signal);
      for (const [k, { index, member }] of rooted.entries()) {
        const root = roots[k];
        const origin = root?.status === "complete" && root.pastRoot !== true ? root.value : undefined;
        if (isOutside(origin)) bindings[index] = { kind: "outside", form: "chain", origin };
        else typed.push({ index, member, site: calls[index]! });
      }
    }
    if (bare.length > 0) {
      const sites = bare.map(({ index, name }) => ({ reference: calls[index]!.reference, name }));
      const asked = sites.map(({ reference, name }) => ({ file: reference.file, line: reference.line, column: reference.column + 1, name, fullName: reference.name, kind: reference.kind }));
      const findings = await origins.origins(asked, signal);
      const constructed = await origins.rootOrigins(asked.filter((site) => site.kind === "instantiates"), signal);
      let construction = 0;
      const inside: number[] = [];
      for (const [k, { index }] of bare.entries()) {
        const { reference } = sites[k]!;
        const finding = findings[k];
        const root = reference.kind === "instantiates" ? constructed[construction++] : undefined;
        const origin = reference.kind === "instantiates" ? (root?.status === "complete" && root.pastRoot !== true ? root.value : undefined) : finding?.status === "complete" && finding.occurrence === true ? finding.value : undefined;
        if (isOutside(origin)) bindings[index] = { kind: "outside", form: "bare", origin };
        else inside.push(k);
      }
      const bound = await origins.rootBindings(inside.map((k) => {
        const { reference, name } = sites[k]!;
        const { body } = calls[bare[k]!.index]!;
        return { file: reference.file, line: reference.line, column: reference.column + 1, spelled: name, owner: { name: body.name, line: body.startLine, endLine: body.endLine } };
      }), signal);
      for (const [j, k] of inside.entries()) {
        const { index } = bare[k]!;
        const { reference, name } = sites[k]!;
        const declared = await bareDeclaration(calls[index]!, name, bound[j]);
        if (declared !== undefined) bindings[index] = declared;
        else if (isJavaSource(reference.file)) typed.push({ index, member: name, site: calls[index]! });
        else {
          const candidates = namedDeclarations(name, reference.file);
          bindings[index] = { kind: "unbound", form: "bare", candidates, attributed: candidates.filter((candidate) => candidate.file === reference.file) };
        }
      }
    }
    for (const { index, member, site } of typed) {
      const chaining = CHAINING.includes(site.reference.name);
      bindings[index] = { kind: "declared", member, form: chaining ? "chain" : calleeOf(site.reference.name).form === "bare" ? "bare" : "member", call: site };
    }
    return bindings.map((binding) => binding!);
  }

  /** What the method a `declared` binding's receiver reading names settles it to. */
  function settleDeclared({ member, form, call }: DeclaredBinding, method: ReceiverMethod | undefined): SettledBinding {
    const target = method?.kind === "method" ? placed(method.file, method.start, method.nameLine) : undefined;
    if (target !== undefined) return { kind: "declaration", target, link: form === "chain" ? "chain" : "declared-receiver" };
    if (form === "chain") {
      const constructors = chainedConstructors(call.body, member);
      return method?.kind === "unproven" ? { kind: "unbound", form, candidates: constructors, attributed: constructors } : implicitConstructor(call.body, member) ?? { kind: "unbound", form, candidates: [], attributed: [] };
    }
    const candidates = namedDeclarations(member, call.reference.file, form === "member");
    return { kind: "unbound", form, candidates, attributed: form === "bare" ? candidates.filter((candidate) => candidate.file === call.reference.file) : [] };
  }

  /** A chaining call to a repository class that declares no constructor runs its implicit one: the class itself. */
  function implicitConstructor(body: GraphSymbol, keyword: string): SettledBinding | undefined {
    if (keyword !== "super") return undefined;
    const above = superclassesOf(classesOf(body));
    const [type] = above;
    return above.length === 1 && !navigation.membersOf(type!).some((member) => member.kind === "method" && member.name === type!.name) ? { kind: "declaration", target: type!, link: "chain" } : undefined;
  }

  return {
    bindCalls,
    settleDeclared,
    namedDeclarations,
    ofReceiver: proven,
    async boundCalls(calls, signal) {
      const bound = await bindCalls(calls, signal);
      const pending = bound.flatMap((binding) => (binding.kind === "declared" ? [binding] : []));
      const found = pending.length === 0 ? [] : await origins.receiverMethods(pending.map(receiverSiteOf), signal);
      let next = 0;
      return bound.map((binding) => (binding.kind === "declared" ? settleDeclared(binding, found[next++]) : binding));
    },
  };
}
