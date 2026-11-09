import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { calleeOf } from "../../domain/shared/call-place.ts";
import { EDGE_POLICY, FOLLOWED_EDGE_KINDS, LOCAL_OWNER_KINDS, type ReceiverSettlement } from "../../domain/impact/edge-policy.ts";
import { hasTyping } from "../../domain/languages/profiles.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { CodeGraphReader, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import { createInboundEdges, type EdgeCorrections, type InboundEdges, type InboundOccurrences } from "./inbound-edges.ts";
import type { ReferenceProofs } from "../navigation/reference-origins.ts";
import { edgeKey, type EdgeTargets, type FollowedEdge } from "../navigation/edge-targets.ts";
import type { CallBindings, UnboundCall } from "../navigation/call-binding.ts";
import { createGraphNavigation } from "../navigation/graph-navigation.ts";

/** What the Angular relation extractor read from the sources of one snapshot. */
export interface RelationOrigins {
  relations: readonly Finding<Relation>[];
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
  memberUses?: readonly MemberUseOrigin[] | undefined;
}

/**
 * What depends on a symbol of the snapshot: the code graph's edges with the injection and template relations and the
 * calls made through fields and locals the extractor placed, with the graph's edges as `EdgeTargets` corrected them. Test
 * files never depend on anything.
 */
export function inboundEdgesOf(store: CodeGraphReader, origins: RelationOrigins, proofs?: Pick<ReferenceProofs, "validOccurrences" | "thisMemberCalls">, corrections?: EdgeCorrections): InboundEdges & InboundOccurrences {
  const isTest = (path: string): boolean => kindOfChangedFile(path) === "test";
  return createInboundEdges(store, isTest, origins.relations.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])), proofs?.validOccurrences ?? new Set(), origins.memberUses, proofs?.thisMemberCalls, corrections);
}

/**
 * How each graph edge out of the TypeScript sources among `files` whose receiver is a value is known, settled at once for
 * a reading whose callers are asked without waiting (ADR-0036): kept with its settlement, or moved to the declaration the
 * base binds it to (ADR-0041 decision 4), with the member calls through the origins the base binds (`originCallsOf`).
 */
export async function receiverCorrectionsOf(store: CodeGraphReader, targets: EdgeTargets, origins: Pick<RelationOrigins, "fields" | "locals">, files: readonly string[], signal?: AbortSignal): Promise<EdgeCorrections> {
  const sources = new Map(store.symbolsInFiles(files.filter((file) => hasTyping(file, "structural") && kindOfChangedFile(file) !== "test")).map((symbol) => [symbol.id, symbol]));
  const edges = store.outgoingEdges([...sources.keys()], FOLLOWED_EDGE_KINDS);
  const reached = new Map(store.symbolsByIds([...new Set(edges.map((edge) => edge.target))]).map((symbol) => [symbol.id, symbol]));
  const followed = edges.flatMap((edge): FollowedEdge[] => {
    const source = sources.get(edge.source);
    const target = reached.get(edge.target);
    return source === undefined || target === undefined ? [] : [{ edge, source, target }];
  });
  const verdicts = await targets.verdictsOf(followed, signal);
  const settled = new Map<string, ReceiverSettlement>();
  const moved = followed.flatMap((edge, index) => {
    const verdict = verdicts[index]!;
    if (verdict.kind === "keep" && verdict.derivation !== undefined) settled.set(edgeKey(edge.edge), verdict.derivation);
    return verdict.kind === "redirect" && verdict.receiver !== undefined ? [{ ...edge, target: verdict.to }] : [];
  });
  const throughOrigins = targets.bindings === undefined ? [] : await originCallsOf(store, targets.bindings, origins, signal);
  return { dropped: new Set(moved.map(({ edge }) => edgeKey(edge))), into: Map.groupBy([...moved, ...throughOrigins], ({ target }) => target.id), settled };
}

/**
 * The member calls made through a field's or an `inject()` local's origin, `this.f.m()` in the class that declares the
 * field and `l.m()` in the declaration that takes the local, each moved to what the base binds it to (ADR-0041 decision
 * 4): the declaration it binds, or each one its receiver's type is attributed among several. A local's call counts only
 * at a site the extractor certifies.
 */
export async function originCallsOf(store: CodeGraphReader, bindings: CallBindings, origins: Pick<RelationOrigins, "fields" | "locals">, signal?: AbortSignal): Promise<readonly FollowedEdge[]> {
  return boundThroughOrigins(bindings, callsThroughOrigins(store, origins), signal);
}

/** The calls through origins that `originCallsOf` binds, each bound the first time a declaration of the name it calls is reached. */
export interface OriginCalls {
  into(nodes: readonly GraphSymbol[], signal?: AbortSignal): Promise<readonly FollowedEdge[]>;
}

export function createOriginCalls(store: CodeGraphReader, bindings: CallBindings, origins: Pick<RelationOrigins, "fields" | "locals">): OriginCalls {
  let pending: readonly UnboundCall[] | undefined;
  return {
    async into(nodes, signal) {
      const names = new Set(nodes.map(({ name }) => name));
      const calls = (pending ??= callsThroughOrigins(store, origins));
      const named = (call: UnboundCall): boolean => {
        const callee = calleeOf(call.reference.name);
        return callee.form === "computed" || names.has(callee.name);
      };
      const asked = calls.filter(named);
      if (asked.length === 0) return [];
      pending = calls.filter((call) => !named(call));
      return boundThroughOrigins(bindings, asked, signal);
    },
  };
}

function callsThroughOrigins(store: CodeGraphReader, origins: Pick<RelationOrigins, "fields" | "locals">): readonly UnboundCall[] {
  const isTest = (path: string): boolean => kindOfChangedFile(path) === "test";
  const navigation = createGraphNavigation(store, isTest);
  const calls = new Map<string, UnboundCall>();
  const memberUses = new Map<string, readonly GraphUnresolvedReference[]>();
  const memberUsesIn = (file: string): readonly GraphUnresolvedReference[] => {
    let found = memberUses.get(file);
    if (found === undefined) {
      found = store.unresolvedReferences([file]).filter((use) => (EDGE_POLICY.fieldMemberUses as readonly string[]).includes(use.kind));
      memberUses.set(file, found);
    }
    return found;
  };
  const collect = (holder: GraphSymbol | undefined, prefix: string, certified: (use: GraphUnresolvedReference) => boolean = () => true): void => {
    if (holder === undefined || isTest(holder.file)) return;
    const uses = memberUsesIn(holder.file).filter((use) => use.name.startsWith(prefix) && certified(use));
    for (const use of uses) {
      const [body] = store.symbolsByIds([use.from]);
      if (body !== undefined && body.file === use.file && body.startLine <= use.line && use.line <= body.endLine) calls.set(JSON.stringify([use.from, use.line, use.column, use.name]), { body, reference: use });
    }
  };
  for (const origin of origins.fields) collect(navigation.declarationAt(origin.owner), `this.${origin.field}.`);
  for (const origin of origins.locals) collect(navigation.declarationAt(origin.owner, LOCAL_OWNER_KINDS), `${origin.local}.`, (use) => origin.calls?.some((site) => site.file === use.file && site.line === use.line && site.column === use.column + 1 && site.name === use.name && site.kind === use.kind) === true);
  return [...calls.values()];
}

async function boundThroughOrigins(bindings: CallBindings, asked: readonly UnboundCall[], signal?: AbortSignal): Promise<readonly FollowedEdge[]> {
  const bound = await bindings.boundCalls(asked, signal);
  return asked.flatMap(({ body, reference }, index) => {
    const binding = bound[index]!;
    if (binding.kind !== "receiver") return [];
    return (binding.target === undefined ? binding.attributed : [binding.target]).map((target) => ({ edge: { source: body.id, target: target.id, kind: reference.kind, line: reference.line, column: reference.column, confidence: null, provenance: null, synthesizedBy: null, resolvedFrom: null }, source: body, target }));
  });
}
