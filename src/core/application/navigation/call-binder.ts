import { EDGE_POLICY, isClassKind } from "../../domain/impact/edge-policy.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { ExternalMemberUseOrigin, MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { SymbolRef } from "../../domain/relations/relation.ts";
import { joinsFact } from "../../domain/shared/code-node.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { ReceiverBinding } from "../../ports/declared-member-names.port.ts";
import type { GraphNavigation } from "./graph-navigation.ts";
import { provenCallsOf, provenKey, spelledKey, type ProvenCalls } from "./proven-calls.ts";

/** What the relations prove a receiver holds: a field's or an `inject()` local's origin, and the member calls they prove. */
export interface ReceiverProofs {
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
  memberUses?: readonly MemberUseOrigin[] | undefined;
  externalUses?: readonly ExternalMemberUseOrigin[] | undefined;
}

/** No relation proof: for a family that reads no Angular relations, only a receiver's syntax binds it. */
export const SYNTAX_ONLY: ReceiverProofs = { fields: [], locals: [] };

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
function holdsAt(bindings: ReadonlyMap<string, ReceiverBinding | "ambiguous">, line: number, column: number, member: string, receiver: string): ReceiverBinding["holds"] | undefined {
  const binding = bindings.get(bindingKey(line, column, member));
  return binding !== undefined && binding !== "ambiguous" && binding.receiver === receiver ? binding.holds : undefined;
}

/** What a source's syntax states for binding receivers, indexed once per file. */
export interface ReceiverSyntax {
  receiverBindings: ReadonlyMap<string, ReceiverBinding | "ambiguous">;
  /** The callee each call starting at a place spells, without white space, by `line:column`. */
  callees: ReadonlyMap<string, readonly string[]>;
}

/** A member call on a named receiver, by the place it starts (1-based column) and the body that writes it. */
export interface MemberCallSite {
  body: GraphSymbol;
  line: number;
  column: number;
  member: string;
  receiver: string;
  /** The call's whole spelling, for a call the index left unresolved; its member proof is then read by it, whitespace aside. */
  spelling?: string;
}

/**
 * What proves the receiver of a member call holds, by the first link of the chain that decides (ADR-0041 decision 4): a
 * member proof of the call itself (with the one method it places), a proof that a type from outside the repository
 * holds it, a field's or an `inject()` local's origin, or the receiver's binding in its own source (with the repository
 * type a `declared`, `annotated` or `constructed` binding names). `replaceable` when a provider may replace the class a
 * member proof would name; `unspelled` when the call written at the place does not spell the receiver immediately before
 * the member (`this.r.m`, `r.m`), so no origin was read for it.
 */
export type ReceiverProof =
  | { link: "member"; proof: { receiver: SymbolRef; member: SymbolRef }; method?: GraphSymbol }
  | { link: "external"; holds: string }
  | { link: "field" | "local"; holds: FieldOrigin["holds"]; type?: GraphSymbol; replaceable?: true }
  | { link: "syntax"; holds: ReceiverBinding["holds"]; type?: GraphSymbol; replaceable?: true; unspelled?: true }
  | { link: "none"; replaceable?: true };

/**
 * The one owner of the static binding of a member call's receiver for every family (ADR-0041 decisions 1, 4 and 6): a
 * family reads the proof and its binding and may refuse it, never bind the call elsewhere.
 */
export interface CallBinder {
  receiverOf(site: MemberCallSite): Promise<ReceiverProof>;
  /** The method named `member` an instance of the class `type` has at compile time: its own, or the nearest class above it declares. */
  memberOf(type: GraphSymbol, member: string): GraphSymbol | undefined;
  /** Whether `type`, or a type above it, declares `member`. */
  declares(type: GraphSymbol | undefined, member: GraphSymbol): boolean;
}

export interface CallBinderDeps {
  store: CodeGraphReader;
  navigation: GraphNavigation;
  syntaxIn: (file: string) => Promise<ReceiverSyntax>;
  proofs: () => Promise<ReceiverProofs>;
  /** Per local name a file's imports bind, the declaration the join proves it reaches. */
  importedDeclarations: (file: string) => Promise<ReadonlyMap<string, GraphSymbol>>;
}

export function createCallBinder({ store, navigation, syntaxIn, proofs, importedDeclarations }: CallBinderDeps): CallBinder {
  let read: Promise<{ held: ReceiverProofs; calls: ProvenCalls }> | undefined;
  const proven = () => (read ??= proofs().then((held) => ({ held, calls: provenCallsOf(held.memberUses, held.externalUses) })));

  /** The one member a member proof names, declared by the one class it names; none when the index does not place it so. */
  const placedMember = (member: SymbolRef, receiver: SymbolRef): GraphSymbol | undefined => {
    const members = store.symbolsInFiles([member.path]).filter((symbol) => (EDGE_POLICY.memberKinds as readonly string[]).includes(symbol.kind) && joinsFact(symbol, member));
    const owners = members.length === 1 ? navigation.ownersOf(members[0]!) : [];
    return owners.length === 1 && isClassKind(owners[0]!.kind) && joinsFact(owners[0]!, receiver) ? members[0] : undefined;
  };

  /** The one type `name` names in `file`: the declaration an import of it binds, or the one the file declares. */
  async function typeNamed(file: string, name: string): Promise<GraphSymbol | undefined> {
    const imported = (await importedDeclarations(file)).get(name);
    if (imported !== undefined) return TYPE_KINDS.includes(imported.kind) ? imported : undefined;
    const declared = navigation.symbolsInFile(file).filter((symbol) => symbol.name === name && TYPE_KINDS.includes(symbol.kind));
    return declared.length === 1 ? declared[0] : undefined;
  }

  async function typeOf(file: string, holds: ReceiverBinding["holds"]): Promise<GraphSymbol | undefined> {
    if (holds.kind === "declared") return navigation.declarationAt({ path: file, line: holds.line, symbol: holds.name }, TYPE_KINDS);
    if (holds.kind === "annotated") return typeNamed(file, holds.type);
    if (holds.kind === "constructed") return typeNamed(file, holds.name);
    return undefined;
  }

  /**
   * A receiver further down a chain (`this.f.g.m`) is bound by nothing here: a field or local origin and a syntax binding
   * prove only an immediate receiver (`this.f.m`, `v.m`), as the call written at the place spells it.
   */
  async function receiverOf({ body, line, column, member, receiver, spelling }: MemberCallSite): Promise<ReceiverProof> {
    const { held, calls } = await proven();
    const proof = spelling === undefined ? calls.byMember.get(provenKey(body.file, line, column, member)) : calls.bySpelling.get(spelledKey(body.file, line, column, spelling));
    if (proof?.kind === "member") {
      const method = placedMember(proof.member, proof.receiver);
      return { link: "member", proof: { receiver: proof.receiver, member: proof.member }, ...(method === undefined ? {} : { method }) };
    }
    if (proof?.kind === "external") return { link: "external", holds: proof.holds };
    const replaceable = proof?.kind === "replaceable" ? ({ replaceable: true } as const) : {};
    const syntax = await syntaxIn(body.file);
    const callees = syntax.callees.get(`${line}:${column}`) ?? [];
    const link = receiver === "" ? undefined : callees.includes(`this.${receiver}.${member}`) ? "field" : callees.includes(`${receiver}.${member}`) ? "local" : undefined;
    const found = link === undefined ? undefined : link === "field" ? navigation.fieldOriginAt(body, receiver, held.fields) : navigation.localOriginAt(body, receiver, held.locals);
    if (link !== undefined && typeof found === "object") {
      const type = "class" in found.origin.holds ? navigation.declarationAt(found.origin.holds.class, TYPE_KINDS) : undefined;
      return { link, holds: found.origin.holds, ...(type === undefined ? {} : { type }), ...replaceable };
    }
    const holds = holdsAt(syntax.receiverBindings, line, column, member, receiver);
    if (holds === undefined) return { link: "none", ...replaceable };
    const type = await typeOf(body.file, holds);
    return { link: "syntax", holds, ...(type === undefined ? {} : { type }), ...replaceable, ...(link === undefined ? { unspelled: true } : {}) };
  }

  const above = (type: GraphSymbol): GraphSymbol[] => [type, ...navigation.typesAround(type, "up").map((around) => around.type)];

  return {
    receiverOf,
    memberOf(type, member) {
      for (const declaring of above(type).filter((candidate) => isClassKind(candidate.kind))) {
        const own = navigation.methodsOf(declaring).filter((method) => method.name === member);
        if (own.length > 0) return own.length === 1 ? own[0] : undefined;
      }
      return undefined;
    },
    declares(type, member) {
      if (type === undefined) return false;
      const owners = navigation.ownersOf(member);
      return above(type).some((candidate) => owners.some((owner) => owner.id === candidate.id));
    },
  };
}
