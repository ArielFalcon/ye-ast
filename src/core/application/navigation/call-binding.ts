import { mayRunDeclarationOf } from "../../domain/languages/call-targets.ts";
import { hasTyping, isChaining } from "../../domain/languages/profiles.ts";
import { isClassKind } from "../../domain/impact/edge-policy.ts";
import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import { calleeOf, compactSpelling, ownMemberOf, receiverOf } from "../../domain/shared/call-place.ts";
import type { CodeGraphReader, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOrigins, ReceiverCallSite, ReceiverMethod } from "../../ports/import-origins.port.ts";
import type { CallBinder, CallPlace, ReceiverProof } from "./call-binder.ts";
import { ownMembersOf, placedBetween, type GraphNavigation } from "./graph-navigation.ts";
import { indexedDeclaration, type DeclarationModel, type ModelDeclaration } from "./declaration-model.ts";
import type { SymbolRef } from "../../domain/relations/relation.ts";

/** A call the index left without a target: its body, and the reference the index or the syntax states for it. */
export interface UnboundCall {
  body: GraphSymbol;
  reference: GraphUnresolvedReference;
}

export type BindingCall = UnboundCall | { body: ModelDeclaration; reference: Omit<GraphUnresolvedReference, "from"> };

type Outside = Extract<ImportOrigin, { kind: "external" | "ambient" }>;

/**
 * Which declaration a call the index left without a target binds to at compile time (ADR-0041 decision 4), by the first
 * link of one chain:
 * - `declaration`: the body's own member (`this.m`), the constructor `super(...)` or `this(...)` chains to, the
 *   declaration a bare name's import or the file's own scope binds, or the method a Java receiver's declared type names
 *   (`bound-receiver` when a type variable types the receiver: the method its bound names, which any type below the
 *   bound may replace when the call runs);
 *   When the receiver type declares several members of the name without a selection, the edge keeps the index target
 *   as a name match rather than proven (RFC-0024 U3).
 * - `receiver`: a member call whose receiver a proof decides, with the declaration the proof binds it to, if any;
 * - `outside`: a bare name or a plain chain rooted at a package or the language's libraries;
 * - `unbound`: nothing binds it, with the declarations of its name the language rule admits (`candidates`) and those
 *   the call is attributed to (`attributed`): the members of `this` it may run, the constructors its chaining may run,
 *   the declarations of its file a bare name may name, or the members of its receiver's proven type.
 * `form` tells how the call spells its callee, for a family that settles each form its own way.
 */
export type CallBinding =
  | { kind: "declaration"; target: GraphSymbol; link: "own-member" | "chain" | "import" | "file" | "declared-receiver" | "bound-receiver" | "overload" }
  | { kind: "receiver"; proof: ReceiverProof; target?: GraphSymbol; declaration?: ModelDeclaration; outside?: true; candidates: readonly GraphSymbol[]; attributed: readonly GraphSymbol[] }
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
  call: BindingCall;
}

/** A binding no read is pending on. */
export type SettledBinding = Exclude<CallBinding, DeclaredBinding>;

/** The receiver-method site a `declared` binding waits on. */
export function receiverSiteOf({ member, call: { reference } }: DeclaredBinding): ReceiverCallSite {
  return { file: reference.file, line: reference.line, column: reference.column + 1, member };
}

/** What a member call binds to on a value of a proven type: the one answer and the set a cut names. */
export interface ReceiverMemberAnswer {
  /** The declaration the call binds to; absent when the type offers several and no language rule singles one out. */
  target?: GraphSymbol;
  /** The declarations the receiver's type offers for the member, sorted. */
  candidates: readonly GraphSymbol[];
}

/** The one owner of what a call the index left without a target binds to, for every family (ADR-0041 decisions 1 and 4). */
export interface CallBindings {
  /** One binding per call, in the order given; the reads each link needs are made once for all of them, save the receiver methods a `declared` binding waits on. */
  bindCalls(calls: readonly BindingCall[], signal?: AbortSignal): Promise<readonly CallBinding[]>;
  /** What the method a `declared` binding's receiver reading names settles it to. */
  settleDeclared(binding: DeclaredBinding, method: ReceiverMethod | undefined): SettledBinding;
  /** `bindCalls` with every `declared` binding settled through one read of the receiver methods. */
  boundCalls(calls: readonly BindingCall[], signal?: AbortSignal): Promise<readonly SettledBinding[]>;
  /** The declarations of `name` a call written in `from` may run, in scope; `values` leaves out the kinds only types have. */
  namedDeclarations(name: string, from: string, values?: boolean): readonly GraphSymbol[];
  /** What a member call of `member` binds to by what its receiver's proof decides, attributed among `candidates`. */
  ofReceiver(proof: ReceiverProof, member: string, candidates: readonly GraphSymbol[], place: CallPlace): Promise<Extract<CallBinding, { kind: "receiver" }>>;
  /** What a member call of `member` on a value of `type` binds to: one call, one answer, through the language's chain. */
  memberOfReceiver(type: GraphSymbol, member: string, place: CallPlace): Promise<ReceiverMemberAnswer>;
}

export interface CallBindingsDeps {
  declarations: DeclarationModel;
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

const isOutside = (origin: ImportOrigin | undefined): origin is Outside => origin?.kind === "external" || origin?.kind === "ambient";

export function createCallBindings({ store, navigation, origins, binder, declarations, importedDeclarations, inScope = () => true }: CallBindingsDeps): CallBindings {
  const named = new Map<string, readonly GraphSymbol[]>();
  function namedDeclarations(name: string, from: string, values = false): readonly GraphSymbol[] {
    let found = named.get(name);
    if (found === undefined) {
      found = store.declarationsNamed([name]).filter((symbol) => inScope(symbol.file) && !NOT_DECLARED_KINDS.includes(symbol.kind));
      named.set(name, found);
    }
    return found.filter((symbol) => mayRunDeclarationOf(from, symbol.file) && (!values || !TYPE_ONLY_KINDS.includes(symbol.kind)));
  }

  const placed = (file: string, start: number, nameLine: number): GraphSymbol | undefined => placedBetween(store, file, start, nameLine, CALLABLE_KINDS);

  /**
   * The constructors of the class a chaining call in `body` runs one of: its own class's for `this`, its superclass's
   * for `super`. The index holds a record's constructors as functions of no container, so `this` in one of them runs
   * another function of its file with its name.
   */
  const classesOf = (body: GraphSymbol | ModelDeclaration): readonly GraphSymbol[] => {
    const symbol = indexedDeclaration(body);
    return symbol === undefined ? [] : navigation.ownersOf(symbol).filter((owner) => isClassKind(owner.kind));
  };
  const superclassesOf = (types: readonly GraphSymbol[]): readonly GraphSymbol[] => store.symbolsByIds(store.outgoingEdges(types.map((type) => type.id), ["extends"]).map((edge) => edge.target)).filter((type) => isClassKind(type.kind));
  const chainedConstructors = (body: GraphSymbol | ModelDeclaration, keyword: string): readonly GraphSymbol[] => {
    const own = classesOf(body);
    if (own.length === 0) return keyword === "this" && body.kind === "function" ? navigation.symbolsInFile(body.file).filter((symbol) => symbol.kind === "function" && symbol.name === body.name && symbol.id !== body.id && navigation.ownersOf(symbol).length === 0) : [];
    const types = keyword === "this" ? own : superclassesOf(own);
    return types.flatMap((type) => navigation.membersOf(type).filter((member) => member.kind === "method" && member.name === type.name && member.id !== body.id));
  };

  /**
   * The declaration a bare name binds in its own file: an import's where the occurrence reads that import, or the file's
   * own declaration of it. A local binding, an own member or an unread occurrence never takes the import of its name.
   */
  async function bareDeclaration({ body, reference }: BindingCall, name: string, bound: Awaited<ReturnType<ImportOrigins["rootBindings"]>>[number] | undefined): Promise<CallBinding | undefined> {
    const imported = bound?.kind === "import" || bound?.kind === "located" ? (await importedDeclarations(reference.file)).get(name) : undefined;
    if (imported !== undefined) return { kind: "declaration", target: imported, link: "import" };
    if (bound?.kind !== "declared" || bound.captured) return undefined;
    const declared = navigation.symbolsInFile(reference.file).filter((symbol) => symbol.name === name && symbol.id !== body.id && !NOT_DECLARED_KINDS.includes(symbol.kind) && bound.lines.some((line) => symbol.startLine <= line && line <= symbol.endLine));
    return declared.length === 1 ? { kind: "declaration", target: declared[0]!, link: "file" } : undefined;
  }

  /** What a member call's receiver proof binds it to: the method the proof places, or the member the proven type has. */
  async function proven(proof: ReceiverProof, name: string, candidates: readonly GraphSymbol[], place: CallPlace): Promise<Extract<CallBinding, { kind: "receiver" }>> {
    const typed = async (type: GraphSymbol | undefined, holder?: SymbolRef) => {
      if (type !== undefined) {
        const answer = await memberOfReceiver(type, name, place);
        return { candidates: answer.candidates, ...(answer.target === undefined ? { attributed: answer.candidates } : { target: answer.target, attributed: [] }) };
      }
      if (holder === undefined) return { attributed: [] };
      const found = (await declarations.select(holder.path, holder.symbol)).filter(({ startLine, endLine }) => holder.line === undefined || startLine <= holder.line && holder.line <= endLine);
      if (found.length !== 1 || found[0]!.symbol !== undefined) return { attributed: [] };
      const declaration = await binder.memberOfDeclaration(found[0]!, name, place);
      return { attributed: [], ...(declaration === undefined ? {} : { declaration }) };
    };
    if (proof.link === "member") return { kind: "receiver", proof, candidates, attributed: [], ...(proof.method === undefined ? {} : { target: proof.method }) };
    if (proof.link === "external") return { kind: "receiver", proof, candidates, attributed: [], outside: true };
    if (proof.link === "field" || proof.link === "local") return "external" in proof.holds ? { kind: "receiver", proof, candidates, attributed: [], outside: true } : { kind: "receiver", proof, candidates, ...(await typed(proof.type, proof.holds.class)) };
    if (proof.link === "syntax" && proof.holds.kind === "literal") return { kind: "receiver", proof, candidates, attributed: [], outside: true };
    if (proof.link === "syntax" && proof.unspelled !== true && proof.declaration !== undefined) {
      const declaration = await binder.memberOfDeclaration(proof.declaration, name, place);
      return { kind: "receiver", proof, candidates, attributed: [], ...(declaration === undefined ? {} : { declaration, ...(declaration.symbol === undefined ? {} : { target: declaration.symbol }) }) };
    }
    if (proof.link === "syntax" && proof.unspelled !== true && ["declared", "annotated", "constructed"].includes(proof.holds.kind)) return { kind: "receiver", proof, candidates, ...(await typed(proof.type)) };
    return { kind: "receiver", proof, candidates, attributed: [] };
  }

  /**
   * What a member call of `member` on a value of `type` binds to: the declaration its language's rule places and the
   * declarations the type offers for the member. A nominal language's owner answers both; a structural language's member
   * rule answers the declaration, over the members the type and its hierarchy declare.
   */
  async function memberOfReceiver(type: GraphSymbol, member: string, place: CallPlace): Promise<ReceiverMemberAnswer> {
    if (!hasTyping(place.file, "nominal")) {
      const target = await binder.memberOf(type, member, place);
      return { ...(target === undefined ? {} : { target }), candidates: binder.membersAbove(type, member) };
    }
    const [answered] = await origins.receiverMethods([{ file: place.file, line: place.line, column: place.column, member }]);
    if (answered?.kind === "method") {
      const target = placed(answered.file, answered.start, answered.nameLine);
      return { ...(target === undefined ? {} : { target }), candidates: binder.membersAbove(type, member) };
    }
    const offered = answered?.kind === "unproven" && answered.candidates !== undefined ? answered.candidates.flatMap(({ file, start, nameLine }) => placed(file, start, nameLine) ?? []) : undefined;
    return { candidates: offered ?? binder.membersAbove(type, member) };
  }

  async function bindCalls(calls: readonly BindingCall[], signal?: AbortSignal): Promise<readonly CallBinding[]> {
    const bindings: (CallBinding | undefined)[] = calls.map(() => undefined);
    const bare: { index: number; name: string }[] = [];
    const typed: { index: number; member: string; site: BindingCall }[] = [];
    const rooted: { index: number; member: string }[] = [];
    for (const [index, call] of calls.entries()) {
      const { body, reference } = call;
      if (reference.kind === "references" && hasTyping(reference.file, "nominal")) {
        typed.push({ index, member: reference.name, site: call });
        continue;
      }
      const own = ownMemberOf(compactSpelling(reference.name));
      const indexed = indexedDeclaration(body);
      if (own !== undefined && indexed === undefined) {
        const declaration = await binder.memberOfDeclaration(body as ModelDeclaration, own, { file: reference.file, line: reference.line, column: reference.column + 1 });
        if (declaration !== undefined) {
          bindings[index] = { kind: "receiver", proof: { link: "none" }, candidates: [], attributed: [], ...(declaration.symbol === undefined ? { declaration } : { target: declaration.symbol }) };
          continue;
        }
      }
      const members = own === undefined || indexed === undefined || hasTyping(reference.file, "nominal") ? [] : ownMembersOf(navigation, indexed, own, ["method"]);
      if (members.length === 1) bindings[index] = { kind: "declaration", target: members[0]!, link: "own-member" };
      else if (members.length > 1) {
        const [owner] = classesOf(body);
        const overload = owner === undefined ? undefined : await binder.memberOf(owner, own!, { file: reference.file, line: reference.line, column: reference.column + 1 });
        bindings[index] = overload === undefined ? { kind: "unbound", form: "own", candidates: members, attributed: members } : { kind: "declaration", target: overload, link: "overload" };
      }
      else if (isChaining(reference.file, reference.name)) typed.push({ index, member: reference.name, site: call });
      else {
        const callee = calleeOf(reference.name);
        if (callee.form === "computed") bindings[index] = { kind: "unbound", form: "computed", candidates: [], attributed: [] };
        else if (callee.form === "bare") bare.push({ index, name: callee.name });
        else {
          const candidates = namedDeclarations(callee.name, reference.file, true);
          const proof = await binder.receiverOf({ body, line: reference.line, column: reference.column + 1, member: callee.name, receiver: receiverOf(compactSpelling(reference.name)) ?? "", spelling: reference.name });
          if (proof.link !== "none") bindings[index] = await proven(proof, callee.name, candidates, { file: reference.file, line: reference.line, column: reference.column + 1 });
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
        else if (hasTyping(reference.file, "nominal")) typed.push({ index, member: name, site: calls[index]! });
        else {
          const candidates = namedDeclarations(name, reference.file);
          bindings[index] = { kind: "unbound", form: "bare", candidates, attributed: candidates.filter((candidate) => candidate.file === reference.file) };
        }
      }
    }
    for (const { index, member, site } of typed) {
      const chaining = isChaining(site.reference.file, site.reference.name);
      bindings[index] = { kind: "declared", member, form: chaining ? "chain" : calleeOf(site.reference.name).form === "bare" ? "bare" : "member", call: site };
    }
    return bindings.map((binding) => binding!);
  }

  /** What the method a `declared` binding's receiver reading names settles it to. */
  function settleDeclared({ member, form, call }: DeclaredBinding, answered: ReceiverMethod | undefined): SettledBinding {
    const method: ReceiverMethod | undefined = answered?.kind === "generated" ? { kind: "unproven", candidates: [] } : answered;
    const target = method?.kind === "method" ? placed(method.file, method.start, method.nameLine) : undefined;
    if (target !== undefined) return { kind: "declaration", target, link: form === "chain" ? "chain" : method?.kind === "method" && method.bound === true ? "bound-receiver" : "declared-receiver" };
    if (form === "chain") {
      const constructors = chainedConstructors(call.body, member);
      return method?.kind === "unproven" ? { kind: "unbound", form, candidates: constructors, attributed: constructors } : implicitConstructor(call.body, member) ?? { kind: "unbound", form, candidates: [], attributed: [] };
    }
    const offered = call.reference.kind === "references" && method?.kind === "unproven" && method.candidates !== undefined ? method.candidates.flatMap(({ file, start, nameLine }) => placed(file, start, nameLine) ?? []) : undefined;
    const candidates = offered ?? namedDeclarations(member, call.reference.file, form === "member");
    return { kind: "unbound", form, candidates, attributed: offered ?? (form === "bare" ? candidates.filter((candidate) => candidate.file === call.reference.file) : []) };
  }

  /** A chaining call to a repository class that declares no constructor runs its implicit one: the class itself. */
  function implicitConstructor(body: GraphSymbol | ModelDeclaration, keyword: string): SettledBinding | undefined {
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
    memberOfReceiver,
    async boundCalls(calls, signal) {
      const bound = await bindCalls(calls, signal);
      const pending = bound.flatMap((binding) => (binding.kind === "declared" ? [binding] : []));
      const found = pending.length === 0 ? [] : await origins.receiverMethods(pending.map(receiverSiteOf), signal);
      let next = 0;
      return bound.map((binding) => (binding.kind === "declared" ? settleDeclared(binding, found[next++]) : binding));
    },
  };
}
