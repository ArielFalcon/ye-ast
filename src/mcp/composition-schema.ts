/**
 * The runtime output contract of `ye_ast_compose`: closed schemas of every table, relation, connection,
 * issue, coverage, request and delivery shape, assembled into the receipt (summary/details) and the full composition.
 * Structural rules live in the schema; cross-id integrity of a full graph is checked by the materializer's own
 * `validateCompositionReferences`, never re-implemented here and never expressed as custom JSON Schema keywords.
 * The input schema belongs to composition-input.ts; the query schema of `requests[].query` is supplied by it.
 */
import { z } from "zod";
import { validateCompositionReferences, validateCompositionIssues } from "./compose-evidence.ts";
import { COMPOSE_QUERY } from "./composition-input.ts";
import type { ComposeFull, ComposeReceipt, CompositionGraph, CoverageSummary, RelationValue } from "./composition-contract.ts";
import {
  callLocation, candidateBasis, comparisonRef, cut, cutOwner, dependenceBasis, entrypointKind, evidenceOrigin, evidenceValue,
  factInputs, ids, linkBasis, linkEndpoints, moduleVia, partSchema, producer, readOwner, schemaVersion, snapshotRef,
  snapshotVectorEntry, supports, symbolNameRef, unknownReason, type Accepts,
} from "./composition-schema-parts.ts";

const int = z.int();
const count = z.int().min(0);
const strings = z.array(z.string());

const snapshotRecord = z.strictObject({ id: ids.snapshot, value: snapshotRef, identity: z.enum(["exact", "redacted"]) });
const analysis = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete") }),
  z.strictObject({ status: z.literal("partial") }),
  z.strictObject({ status: z.literal("unknown"), reason: unknownReason }),
]);
const sourceCommon = { id: ids.source, rootRead: ids.read, snapshotVector: z.array(snapshotVectorEntry), analysis, requestIndex: count };
const toolFamily = z.enum(["entrypoints", "importers", "outline", "trace", "workspace", "decisions"]);
/** A wire source: `branch` exists exactly for impact and callers. */
const sourceDescriptor = z.union([
  z.strictObject({ family: z.enum(["impact", "callers"]), branch: z.enum(["local", "workspace"]), ...sourceCommon }),
  z.strictObject({ family: toolFamily, ...sourceCommon }),
]);
const readAnalysis = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete") }),
  z.strictObject({ status: z.literal("partial"), cuts: z.tuple([cut], cut) }),
  z.strictObject({ status: z.literal("unknown"), reason: unknownReason }),
]);
const readRecord = z.strictObject({
  id: ids.read, source: ids.source, owner: readOwner, schema: schemaVersion, producer, inputs: factInputs,
  snapshot: ids.snapshot, evidence: z.array(ids.evidence), analysis: readAnalysis,
});
const fileRecord = z.strictObject({ id: ids.file, repo: z.string(), origin: evidenceOrigin, path: z.string(), supports });
const anchorRecord = z.strictObject({ id: ids.anchor, file: ids.file, symbol: z.string(), line: int, endLine: int.exactOptional(), supports });
const evidenceRecord = z.strictObject({ id: ids.evidence, origin: evidenceOrigin, repo: z.string(), value: evidenceValue, supports });

const httpMethod = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "ANY"]);
const entryIdentity = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("http-route"), method: httpMethod, path: z.string(), version: z.string().exactOptional(), handler: ids.entity }),
  z.strictObject({ kind: z.literal("ui-route"), path: z.string(), outlet: z.string().exactOptional(), component: z.union([ids.entity, z.literal("unknown")]) }),
  z.strictObject({ kind: z.literal("listener"), protocol: z.enum(["kafka", "rabbit", "jms", "event", "nats"]), destination: z.string(), handler: ids.entity }),
  z.strictObject({ kind: z.literal("job"), trigger: z.strictObject({ attribute: z.string(), value: z.string() }), handler: ids.entity }),
]);
const entityRecord = z.discriminatedUnion("kind", [
  z.strictObject({ id: ids.entity, kind: z.literal("declaration"), file: ids.file, anchors: z.array(ids.anchor).min(1), declarations: z.array(ids.part) }),
  z.strictObject({ id: ids.entity, kind: z.literal("entrypoint"), snapshot: ids.snapshot, identity: entryIdentity, parts: z.array(ids.part).min(1) }),
]);
const bindingRecord = z.strictObject({
  anchor: ids.anchor,
  binding: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("resolved"), entity: ids.entity }),
    z.strictObject({ status: z.literal("unresolved"), anchor: ids.anchor, reason: z.enum(["ambiguous", "redacted", "conflicting-coordinate", "missing-provenance"]) }),
  ]),
});
const attestation = z.strictObject({
  contextKey: z.string().min(1), parts: z.array(ids.part).min(1), reads: z.array(ids.read).min(1),
  locations: z.array(callLocation).exactOptional(), confidence: z.number().exactOptional(),
});
const relationValue = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("serves-entrypoint"), entrypoint: ids.entity, handler: ids.entity }),
  z.strictObject({ kind: z.literal("symbol-dependence"), from: ids.entity, to: ids.entity, basis: dependenceBasis }),
  z.strictObject({ kind: z.enum(["file-import", "file-use", "unresolved-file-name"]), from: ids.file, to: ids.file }),
  z.strictObject({ kind: z.literal("module-dependence"), from: ids.file, to: ids.file, qualifier: moduleVia.pick({ kind: true, typeOnly: true, form: true, specifier: true }) }),
  z.strictObject({ kind: z.literal("entrypoint-origin"), entrypoint: ids.part, seed: ids.part }),
  z.strictObject({ kind: z.literal("module-origin"), module: ids.part, origin: ids.part }),
  z.strictObject({
    kind: z.literal("workspace-match"), from: linkEndpoints.from, to: linkEndpoints.to(ids.entity),
    transport: z.enum(["http", "event"]), basis: linkBasis, profiles: strings.exactOptional(),
  }),
  z.strictObject({ kind: z.literal("candidate-for-name"), name: ids.part, repo: z.string(), basis: candidateBasis }),
  z.strictObject({ kind: z.literal("shares-evidence"), parts: z.array(ids.part).min(2), evidence: ids.evidence }),
]);
const relationRecord = z.strictObject({ id: ids.relation, value: relationValue, attestations: z.array(attestation).min(1) });
const connection = z.strictObject({
  id: ids.connection,
  rule: z.enum(["handler-declaration", "change-dependent", "reached-handler", "linked-entrypoint", "shared-file-import", "used-import", "shared-support"]),
  parts: z.array(ids.part), relations: z.array(ids.relation), supports, entities: z.array(ids.entity).exactOptional(),
}).refine((value) => value.parts.length + value.relations.length > 0, { message: "a connection references parts or relations" });

const graph = z.strictObject({
  snapshots: z.array(snapshotRecord), sources: z.array(sourceDescriptor).min(1), reads: z.array(readRecord).min(1),
  files: z.array(fileRecord), anchors: z.array(anchorRecord), evidence: z.array(evidenceRecord), parts: z.array(partSchema),
  entities: z.array(entityRecord), bindings: z.array(bindingRecord), relations: z.array(relationRecord), connections: z.array(connection),
});

const issueScope = { sources: z.array(ids.source).min(1), reads: z.array(ids.read) };
const issue = z.discriminatedUnion("kind", [
  z.strictObject({ ...issueScope, kind: z.literal("snapshot-difference"), repo: z.string(), snapshots: z.array(ids.snapshot).min(2) }),
  z.strictObject({ ...issueScope, kind: z.literal("context-mismatch"), field: z.enum(["trust", "producer", "schema", "engine", "workspace"]), reason: z.enum(["different", "unavailable"]) }),
  z.strictObject({ ...issueScope, kind: z.literal("ambiguous-declaration"), anchor: ids.anchor, candidates: z.array(ids.part).min(1) }),
  z.strictObject({ ...issueScope, kind: z.literal("conflicting-coordinate"), anchors: z.array(ids.anchor).min(1) }),
  z.strictObject({ ...issueScope, kind: z.literal("unresolved-endpoint"), part: ids.part, target: symbolNameRef }),
  z.strictObject({ ...issueScope, kind: z.literal("missing-provenance"), repo: z.string(), part: ids.part.exactOptional(), side: z.enum(["base", "head"]).exactOptional() }),
  z.strictObject({ ...issueScope, kind: z.literal("missing-origin-reference"), part: ids.part, table: z.enum(["seeds", "module-origins"]), index: int }),
  z.strictObject({ ...issueScope, kind: z.literal("missing-link-reference"), part: ids.part, linkId: z.string(), position: count }),
  z.strictObject({ ...issueScope, kind: z.literal("redacted-identity"), owner: cutOwner, pointer: z.string().exactOptional() }),
]);
const coverage = z.strictObject({
  reads: z.strictObject({ complete: count, partial: count, unknown: count }),
  unknowns: z.array(z.strictObject({ source: ids.source, owner: cutOwner, reason: unknownReason })),
  limits: z.array(z.strictObject({ source: ids.source, owner: cutOwner, kind: cut.shape.kind, limit: z.number().exactOptional(), cuts: z.int().min(1), places: count })),
  issues: z.array(issue),
});
const counts = z.strictObject({
  sources: count, reads: count, files: count, anchors: count, entities: count, evidence: count, parts: count,
  relations: count, connections: count, unknownFindings: count, unknownComponents: count,
});
const unavailableReason = z.enum(["deadline", "unresolved-context", "redacted-context"]);
const verification = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), identity: ids.composition }),
  z.strictObject({ status: z.literal("unavailable"), reason: unavailableReason }),
]);
const liveSnapshot = z.strictObject({ repo: z.string(), kind: z.literal("live"), head: z.string(), stateId: z.string() });
const staleNotice = z.strictObject({ stateId: z.string(), changed: strings });
const sourceDelivery = z.strictObject({
  source: ids.source,
  repositoryRoots: z.array(z.strictObject({ repo: z.string(), path: z.string() })).exactOptional(),
  freshness: z.array(z.strictObject({
    repo: z.string(), url: z.string(),
    freshness: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("verified") }),
      z.strictObject({
        status: z.literal("unverified"), reason: z.enum(["failed", "deadline", "offline", "refresh-in-progress"]),
        lastVerifiedAt: z.string().exactOptional(), detail: z.string().exactOptional(),
      }),
    ]),
  })).exactOptional(),
  resolution: z.array(z.strictObject({
    repo: z.string(), asked: z.string().exactOptional(), step: z.enum(["explicit", "trigger-line", "default-branch", "revision-unavailable"]),
    consulted: z.array(z.strictObject({ branch: z.string(), sha: z.string().exactOptional() })), tie: strings.exactOptional(), sha: z.string().exactOptional(),
  })).exactOptional(),
  live: staleNotice.exactOptional(),
  workspaceLive: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("stale"), repo: z.string(), snapshot: liveSnapshot, notice: staleNotice }),
    z.strictObject({
      kind: z.literal("staleness-unavailable"), repo: z.string(), snapshot: liveSnapshot,
      cause: z.strictObject({
        kind: z.enum(["live-requires-trusted", "unsupported-object-format", "live-mirror-failed", "unknown-revision", "git-failed", "not-repository-root", "unreadable", "object-missing", "no-merge-base", "export-write-failed", "aborted"]),
        detail: z.string(),
      }),
    }),
  ])).exactOptional(),
});

function repeatRequest<Q extends z.ZodType>(query: Q) {
  return z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("available"), query, strategy: z.enum(["pinned-replay", "fresh-read"]) }),
    z.strictObject({ status: z.literal("unavailable"), reason: unavailableReason }),
  ]);
}

type Context = z.core.$RefinementCtx;
/** Every source names a distinct position of `requests`. */
function checkRequestIndices(sources: readonly { requestIndex: number }[], requests: number, ctx: Context): void {
  const seen = new Set<number>();
  for (const [position, source] of sources.entries()) {
    if (source.requestIndex >= requests || seen.has(source.requestIndex)) {
      ctx.addIssue({ code: "custom", path: ["sources", position, "requestIndex"], message: "requestIndex must name one distinct request" });
    }
    seen.add(source.requestIndex);
  }
}

/**
 * The output schema for a given request query schema (composition-input.ts owns it). The receipt carries verification,
 * every request, never duplicated findings/source states/coverage or graph tables; full carries
 * `graph.sources` once and its references must resolve.
 */
export function composeOutputFor<Q extends z.ZodType>(query: Q) {
  const requests = z.array(repeatRequest(query));
  const receipt = z.strictObject({
    kind: z.literal("composition-receipt"), compositionSchema: z.literal(1), mode: z.enum(["summary", "details"]),
    verification, requests,
  });
  const full = z.strictObject({
    kind: z.literal("composition"), compositionSchema: z.literal(1), mode: z.literal("full"),
    verification, requests, graph, coverage, counts, delivery: z.array(sourceDelivery).exactOptional(),
  }).superRefine((value, ctx) => {
    checkRequestIndices(value.graph.sources, value.requests.length, ctx);
    const checked = validateCompositionReferences(value.graph);
    if (!checked.ok) ctx.addIssue({ code: "custom", path: ["graph", checked.fault.table], message: `${checked.fault.kind}: ${checked.fault.id} ${checked.fault.field}` });
    const issuesChecked = validateCompositionIssues(value.graph, value.coverage.issues);
    if (!issuesChecked.ok) ctx.addIssue({ code: "custom", path: ["coverage", "issues"], message: `${issuesChecked.fault.kind}: ${issuesChecked.fault.field}` });
  });
  return z.union([receipt, full]);
}

export { COMPOSE_INPUT } from "./composition-input.ts";
/** The complete runtime output schema; the server validates every composition with it before delivery. */
export const COMPOSE_OUTPUT = composeOutputFor(COMPOSE_QUERY);

export type GraphSchemaMatchesContract = Accepts<CompositionGraph, z.output<typeof graph>>;
export type CoverageSchemaMatchesContract = Accepts<CoverageSummary, z.output<typeof coverage>>;
export type RelationSchemaMatchesContract = Accepts<RelationValue, z.output<typeof relationValue>>;
type WithoutRequests<T> = T extends unknown ? Omit<T, "requests"> : never;
export type OutputSchemaMatchesContract = Accepts<WithoutRequests<ComposeReceipt | ComposeFull>, WithoutRequests<z.output<typeof COMPOSE_OUTPUT>>>;
