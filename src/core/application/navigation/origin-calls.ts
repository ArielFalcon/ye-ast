import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { EDGE_POLICY, LOCAL_OWNER_KINDS } from "../../domain/impact/edge-policy.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import { calleeOf } from "../../domain/shared/call-place.ts";
import type { CodeGraphReader, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { CallBindings, UnboundCall } from "./call-binding.ts";
import type { FollowedEdge } from "./edge-targets.ts";
import { createGraphNavigation } from "./graph-navigation.ts";

/** The fields and `inject()` locals the relations place, whose member calls the base binds. */
export interface Origins {
  fields: readonly FieldOrigin[];
  locals: readonly LocalOrigin[];
}

/** The calls through origins, each bound the first time a declaration of the name it calls is reached. */
export interface OriginCalls {
  into(nodes: readonly GraphSymbol[], signal?: AbortSignal): Promise<readonly FollowedEdge[]>;
}

export function createOriginCalls(bindings: CallBindings, throughOrigins: () => Promise<readonly UnboundCall[]>): OriginCalls {
  let pending: readonly UnboundCall[] | undefined;
  return {
    async into(nodes, signal) {
      const names = new Set(nodes.map(({ name }) => name));
      const calls = (pending ??= await throughOrigins());
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

/**
 * The member calls made through a field's or an `inject()` local's origin, `this.f.m()` in the class that declares the
 * field and `l.m()` in the declaration that takes the local; a local's call counts only at a site the extractor certifies.
 */
export function callsThroughOrigins(store: CodeGraphReader, origins: Origins): readonly UnboundCall[] {
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

/** What each call through an origin binds to: the declaration, or each one its receiver's type is attributed among several. */
export async function boundThroughOrigins(bindings: CallBindings, asked: readonly UnboundCall[], signal?: AbortSignal): Promise<readonly FollowedEdge[]> {
  const bound = await bindings.boundCalls(asked, signal);
  return asked.flatMap(({ body, reference }, index) => {
    const binding = bound[index]!;
    if (binding.kind !== "receiver") return [];
    return (binding.target === undefined ? binding.attributed : [binding.target]).map((target) => ({ edge: { source: body.id, target: target.id, kind: reference.kind, line: reference.line, column: reference.column, confidence: null, provenance: null, synthesizedBy: null, resolvedFrom: null }, source: body, target }));
  });
}
