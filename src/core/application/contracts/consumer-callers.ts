import { EDGE_POLICY } from "../../domain/impact/edge-policy.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { ConsumerCaller, ConsumerCallers, ConsumerMemberOccurrence, ConsumerMemberOccurrences, MemberReceiver } from "../../ports/consumer-sources.port.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { InboundOccurrence, InboundOccurrences } from "../impact/inbound-edges.ts";
import { createGraphNavigation, isInside } from "../navigation/graph-navigation.ts";

/**
 * The places the function declared at `line` of `file` is depended on, as the impact families see them: the graph's
 * edges with the calls made through injected fields and locals, one occurrence each. A dependence that is not a call the
 * graph resolved (a reference, a dispatch, a receiver a provider may replace, a name match) stays in the answer, unproven.
 */
export function callersOfFunction(store: CodeGraphReader | undefined, inbound: InboundOccurrences | undefined, declaration: { file: string; symbol: string; line: number }): ConsumerCallers {
  if (store === undefined || inbound === undefined) return { kind: "unavailable" };
  const symbol = store
    .symbolsInFiles([declaration.file])
    .filter((candidate) => candidate.name === declaration.symbol && candidate.startLine <= declaration.line && declaration.line <= candidate.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (symbol === undefined) return { kind: "unresolved" };
  return { kind: "found", callers: inbound.occurrencesOf(symbol).map(callerOf) };
}

/**
 * The places the member `member` of the class `owner` declared in `file` is depended on. The graph places an occurrence
 * on a line, never on a column, so `column` is 1 and the reader looks at every read of the member on that line. The
 * receiver is what the graph resolved: an occurrence it only matched by name, or whose receiver a provider may replace, is
 * `other`; one inside the owner or a subtype is `this`; a template's is `template`; any other resolved one is `injected`
 * for the reader to confirm from the code. The graph lists no read through a field that holds a subtype of the owner, as
 * a subtype may override the member, so the references that name the member through a field, in the classes that
 * depend on the owner or a subtype, are candidates of the same kind.
 */
export function occurrencesOfMember(store: CodeGraphReader | undefined, inbound: InboundOccurrences | undefined, member: { file: string; owner: string; member: string }): ConsumerMemberOccurrences {
  if (store === undefined || inbound === undefined) return { kind: "unavailable" };
  const navigation = createGraphNavigation(store, () => false);
  const symbols = navigation.symbolsInFile(member.file);
  const owners = symbols.filter((symbol) => (EDGE_POLICY.ownerKinds as readonly string[]).includes(symbol.kind) && symbol.name === member.owner);
  const declared = symbols.filter((symbol) => symbol.name === member.member && (EDGE_POLICY.memberKinds as readonly string[]).includes(symbol.kind) && owners.some((owner) => isInside(symbol, owner)));
  if (declared.length === 0) return { kind: "unresolved" };
  const family = [...owners, ...owners.flatMap((owner) => navigation.typesAround(owner, "down").map(({ type }) => type))];
  const found = new Map<string, ConsumerMemberOccurrence>();
  for (const symbol of declared) {
    for (const occurrence of inbound.occurrencesOf(symbol)) {
      const receiver: MemberReceiver =
        occurrence.resource !== undefined ? "template" : occurrence.derivation === "name-match" || occurrence.bridge !== undefined || occurrence.substitutes !== undefined ? "other" : family.some((type) => isInside(occurrence.from, type)) ? "this" : "injected";
      const place: ConsumerMemberOccurrence = { file: occurrence.from.file, line: occurrence.line ?? occurrence.from.startLine, column: 1, ...(occurrence.resource === undefined ? {} : { resource: occurrence.resource }), receiver };
      found.set(JSON.stringify([place.file, place.resource ?? null, place.line, receiver]), place);
    }
  }
  for (const candidate of candidatesThroughFields(store, inbound, family, member.member)) found.set(JSON.stringify([candidate.file, null, candidate.line, candidate.receiver]), candidate);
  return { kind: "found", occurrences: [...found.values()].sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.receiver, b.receiver)) };
}

function candidatesThroughFields(store: CodeGraphReader, inbound: InboundOccurrences, family: readonly GraphSymbol[], member: string): ConsumerMemberOccurrence[] {
  const files = new Set(family.flatMap((type) => inbound.occurrencesOf(type)).filter((occurrence) => occurrence.resource === undefined).map((occurrence) => occurrence.from.file));
  if (files.size === 0) return [];
  const named = `.${member}`;
  return store
    .unresolvedReferences([...files])
    .filter((reference) => (EDGE_POLICY.fieldMemberUses as readonly string[]).includes(reference.kind) && reference.name.endsWith(named) && reference.name.length > named.length)
    .map((reference) => ({ file: reference.file, line: reference.line, column: 1, receiver: reference.name === `this${named}` ? "this" : "injected" }));
}

function callerOf(occurrence: InboundOccurrence): ConsumerCaller {
  const kind = occurrence.basis === "call" ? "call" : occurrence.basis === "reference" ? "reference" : "other";
  const provenance = occurrence.derivation === "name-match" ? "heuristic" : "resolved";
  return {
    file: occurrence.from.file,
    line: occurrence.from.startLine,
    ...(occurrence.line === undefined ? {} : { at: occurrence.line }),
    ...(occurrence.resource === undefined ? {} : { resource: occurrence.resource }),
    kind,
    provenance,
    confidence: occurrence.confidence,
    proven: kind === "call" && provenance === "resolved" && occurrence.bridge === undefined && occurrence.substitutes === undefined,
  };
}
