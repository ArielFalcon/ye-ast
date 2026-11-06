/**
 * The closed types of transversal evidence composition: identifiers, normalized tables, the `Part` union,
 * the evidence set, the materialized graph, issues, and the request/receipt/full shapes. No I/O and no behaviour: the
 * normalizer (composition-normalize.ts), the materializer (compose-evidence.ts), the coordinator and the renderer consume
 * these types; query-level types stay in query-schema.ts and execution types in query-runner.ts.
 */
import type { Entrypoint, Job, Listener } from "../core/domain/entrypoints/entrypoint.ts";
import type { BasePath, HttpMethod, HttpRoute } from "../core/domain/entrypoints/http-route.ts";
import type { UiRoute } from "../core/domain/entrypoints/ui-route.ts";
import type { SeedBasis } from "../core/domain/change/seeds.ts";
import type { DependenceBasis, ImpactedSymbol, ReachedEntrypoint } from "../core/domain/impact/impact-fact.ts";
import type { ChangedEntrypoint } from "../core/domain/impact/changed-entrypoints.ts";
import type { ChangedContract } from "../core/domain/impact/changed-contracts.ts";
import type { ModuleOrigin, ReachedModule } from "../core/domain/impact/module-dependency.ts";
import type { ImportedFile } from "../core/domain/impact/importers-fact.ts";
import type { OutlineDeclaration } from "../core/domain/outline/outline-fact.ts";
import type { CallSite, EventTarget, HttpTarget, UnresolvedCallSite } from "../core/domain/topology/call-site.ts";
import type { ImpactedLink, Link, LinkBasis, UnlinkedCallSite } from "../core/domain/topology/link.ts";
import type { NameCandidate, OutwardKind } from "../core/domain/topology/outward-name.ts";
import type { Decision, DecisionKind, DecisionOption } from "../core/domain/decisions/decision.ts";
import type { Cut, Evidence, FactInputs, Producer, SchemaVersion, SnapshotRef, UnknownReason } from "../core/domain/shared/fact.ts";
import type { LiveStaleNotice, WorkspaceLiveNotice } from "../core/ports/live-queries.port.ts";
import type { FactRead, WorkspaceRefresh, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { ResponseMode, ToolFamily } from "./presentation.ts";
import type { Analysis, CutOwner } from "./select-evidence.ts";
import type { ComposeQuery } from "./query-schema.ts";
import type { QueryFault } from "./query-runner.ts";

// Identifiers. Every digest is 64 lowercase hex; the prefixes are part of the wire (composition-identity.ts builds them).

export type SourceId = `s1:${string}`;
export type ReadId = `r1:${string}`;
export type SnapshotId = `v1:${string}`;
export type FileId = `f1:${string}`;
export type AnchorId = `a1:${string}`;
export type EvidenceId = `e1:${string}`;
export type PartId = `p1:${string}`;
export type EntityId = `n1:${string}`;
export type RelationId = `l1:${string}`;
export type ConnectionId = `c1:${string}`;
export type CompositionIdentity = `mcp-c1:${string}`;

/** One public appearance: the source, the read that owns it, and an RFC 6901 pointer into that source's public fact. */
export type Support = { source: SourceId; read: ReadId; pointer: string };

export type EvidenceFinding<T> =
  | { status: "complete"; value: T; evidence: readonly EvidenceId[] }
  | { status: "unknown"; reason: UnknownReason; evidence: readonly EvidenceId[] };

/** A snapshot coordinate proven by the read's vector, or a coordinate known only within one read's context. */
export type EvidenceOrigin =
  | { kind: "snapshot"; snapshot: SnapshotId }
  | { kind: "query-context"; read: ReadId };

export type SnapshotRecord = { id: SnapshotId; value: SnapshotRef; identity: "exact" | "redacted" };

/** One entry of a snapshot vector, by repository. */
export type SnapshotVectorEntry = { repo: string; snapshot: SnapshotId };

export type SourceBranch = "local" | "workspace";
/** The family of a source, with `branch` only for impact and callers. */
export type SourceFamilyRef =
  | { family: "impact" | "callers"; branch: SourceBranch }
  | { family: Exclude<ToolFamily, "impact" | "callers"> };

/**
 * A source as the evidence set holds it. `snapshotVector` is the complete current vector sorted by repo; `analysis` is
 * the root read's status. The request index is assigned only when the coordinator orders its requests.
 */
export type SourceRecord = SourceFamilyRef & {
  id: SourceId;
  rootRead: ReadId;
  snapshotVector: readonly SnapshotVectorEntry[];
  analysis: Analysis;
};
/** A source as the wire carries it, in receipts and in `graph.sources`: the record plus its `requests[]` position. */
export type SourceDescriptor = SourceRecord & { requestIndex: number };

/** The kind of a workspace impact read as `RepoImpact.reads[].kind` records it. */
export type RecordedReadKind = RepoImpact["reads"][number]["kind"];
/** A read's owner; a `read` owner also carries the kind the section recorded for it. */
export type ReadOwner = Exclude<CutOwner, { kind: "read" }> | (Extract<CutOwner, { kind: "read" }> & { readKind: RecordedReadKind });

/** Distinct from `Analysis` of select-evidence.ts: partial keeps its cuts, unknown its reason and never a value. */
export type ReadAnalysis =
  | { status: "complete" }
  | { status: "partial"; cuts: readonly [Cut, ...Cut[]] }
  | { status: "unknown"; reason: UnknownReason };

export type ReadRecord = {
  id: ReadId;
  source: SourceId;
  owner: ReadOwner;
  schema: SchemaVersion;
  producer: Producer;
  inputs: FactInputs;
  snapshot: SnapshotId;
  /** The read's own `evidence`, in its original order and multiplicity. */
  evidence: readonly EvidenceId[];
  analysis: ReadAnalysis;
};

/** A named path. A `snapshot` origin is a physical coordinate; a `query-context` origin is local to one read. Naming a file asserts neither existence nor indexing. */
export type FileRecord = { id: FileId; repo: string; origin: EvidenceOrigin; path: string; supports: readonly Support[] };

/** A declarative coordinate as a producer reported it; never a call-site line. An absent `endLine` stays absent. */
export type AnchorRecord = {
  id: AnchorId; file: FileId; symbol: string; line: number; endLine?: number;
  supports: readonly Support[];
};

/** `value` is the producer's `Evidence` without a repository; `repo` is its owner even when the origin is query-context. */
export type EvidenceRecord = {
  id: EvidenceId; origin: EvidenceOrigin; repo: string;
  value: Evidence; supports: readonly Support[];
};

/** A public position whose identity redaction altered: its joins are blocked and an issue is materialized for it. */
export type RedactionRecord = { source: SourceId; read: ReadId; pointer: string };

// Part payloads. Original coordinates become typed references; every other field keeps its original type.

/** A name without a line: the line is never invented. */
export type SymbolNameRef = { file: FileId; symbol: string };

export type ComparisonData = { repo: string; mergeBase: string; head: SnapshotId };
/** A comparison the impact recorded, or its absence, which never yields a fabricated merge base. */
export type ComparisonRef =
  | { status: "available"; value: ComparisonData }
  | { status: "unavailable"; reason: "missing-provenance"; read: ReadId };

/** An index the fact recorded into its owner's seeds or module origins; `missing` keeps an index outside that table. */
export type OriginReference = { status: "present"; index: number; part: PartId } | { status: "missing"; index: number };
/** A link id of a reach, in order; `missing` keeps an id no link of the same source carries. */
export type LinkReference = { status: "present"; part: PartId } | { status: "missing"; linkId: string };
/** Presence describes serialization; count describes recorded observations. Neither is inferred from the other. */
export type RecordedCollectionState = { state: "absent" } | { state: "present"; count: number };

/** `HttpRoute.basePath` becomes an evidence finding; known handlers/components become anchors; guards, outlets, triggers stay. */
export type EntryData =
  | (Omit<HttpRoute, "handler" | "basePath"> & { handler: AnchorId; basePath: EvidenceFinding<BasePath> })
  | (Omit<UiRoute, "component"> & { component: AnchorId | "unknown" })
  | (Omit<Listener, "handler"> & { handler: AnchorId })
  | (Omit<Job, "handler"> & { handler: AnchorId });

export type ViaData = { target: SymbolNameRef; lines?: readonly number[]; basis: DependenceBasis };

/** The six optional or required categories of `ImportedFile`, by their original names. */
export type FileCategory = keyof Omit<ImportedFile, "file">;
export type FileDependencyCategory = "importer" | "reexporter" | "dynamic-importer" | "type-importer" | "user" | "unresolved-namer" | "outline-import";

/** A call-site location: never a declaration start. */
export type CallLocation = { file: FileId; line: number; endLine?: number };
export type CallSiteData = Omit<CallSite, "file" | "line" | "endLine" | "target"> & {
  location: CallLocation;
  target: EvidenceFinding<HttpTarget | EventTarget>;
};
export type LinkData = Omit<Link, "from" | "to"> & {
  from: CallLocation & { repo: string; symbol: string };
  to: { repo: string; kind: Entrypoint["kind"]; name: string; handler: AnchorId };
};

/** A call site the join reached without a link; its file is the caller's. */
export type UnlinkedCallSiteData = Omit<UnlinkedCallSite, "from"> & { from: CallLocation & { repo: string; symbol: string } };

/** A changed contract operation; its known handlers become anchors on the side that declares the operation. */
export type ContractChangeData = Omit<ChangedContract, "handlers"> & { handlers?: readonly AnchorId[] };

export type DecisionOptionData = Omit<DecisionOption, "evidence"> & { evidence: readonly EvidenceId[] };

/** The context a workspace-capable read declares; no member holds the private repositories. */
export type WorkspaceContextData =
  | { family: "workspace"; workspace: WorkspaceValue["workspace"]; repositorySnapshots: readonly SnapshotVectorEntry[] }
  | { family: "impact" | "callers"; workspace: WorkspaceImpactValue["workspace"]; trigger: WorkspaceImpactValue["trigger"]; repositorySnapshots: readonly SnapshotVectorEntry[] }
  | { family: "decisions"; source: DecisionValue["source"]; repositories: readonly SnapshotVectorEntry[] };

export type PartPayload =
  | { kind: "entrypoint"; entry: EntryData; evidence: readonly EvidenceId[] }
  | { kind: "unknown-finding"; reason: UnknownReason; evidence: readonly EvidenceId[] }
  | { kind: "seed"; anchor: AnchorId; basis: SeedBasis; comparison?: ComparisonRef }
  | { kind: "symbol-reach"; anchor: AnchorId; kindName: ImpactedSymbol["kind"]; depth: number; confidence: number; fanIn: number; via?: ViaData }
  | { kind: "entrypoint-reach"; kindName: ReachedEntrypoint["kind"]; name?: string; handler: AnchorId; depth: number; confidence: number; seeds: readonly OriginReference[] }
  | { kind: "entrypoint-change"; change: ChangedEntrypoint["change"]; kindName: ChangedEntrypoint["kind"]; name: string; handler: AnchorId; comparison: ComparisonRef }
  | { kind: "contract-change"; contract: ContractChangeData; comparison: ComparisonRef }
  | { kind: "module-origin"; comparison: ComparisonRef; file: string; change: ModuleOrigin["change"] }
  | { kind: "module-reach"; file: FileId; side: ReachedModule["snapshot"]; depth: number; origins: readonly OriginReference[]; via?: NonNullable<ReachedModule["via"]> }
  | { kind: "file-dependency"; from: FileId; to: FileId; category: FileDependencyCategory }
  | { kind: "file-query"; file: FileId; categories: readonly { name: FileCategory; collection: RecordedCollectionState }[] }
  | { kind: "outline-declaration"; anchor: AnchorId; kindName: OutlineDeclaration["kind"]; children?: readonly PartId[] }
  | { kind: "outline-file"; file: FileId; declarations: readonly PartId[]; imports: readonly PartId[] }
  | { kind: "unheld-file"; file: FileId }
  | { kind: "outward-name"; origin: EvidenceOrigin; name: string; kindName: OutwardKind; evidence: readonly EvidenceId[]; disposition: "stated" | "unserved" }
  | { kind: "name-candidate"; context: ReadId; name: string; repo: string; basis: NameCandidate["basis"]; evidence: readonly EvidenceId[] }
  | { kind: "call-site"; site: CallSiteData; disposition: "matched" | "unmatched" | "external" }
  | { kind: "unresolved-call-site"; site: UnresolvedCallSite }
  | { kind: "workspace-link"; link: LinkData; direction?: ImpactedLink["direction"]; reach?: readonly LinkReference[]; operations?: ImpactedLink["operations"] }
  | { kind: "unlinked-call-site"; site: UnlinkedCallSiteData }
  | { kind: "workspace-context"; context: WorkspaceContextData }
  | { kind: "decision"; context: ReadId; decisionId: Decision["id"]; kindName: DecisionKind; subject: string; outwardKinds?: readonly OutwardKind[]; allowsFreeText: boolean; required: boolean; evidence: readonly EvidenceId[]; options: readonly DecisionOptionData[] }
  | { kind: "impact-context"; owner: ReadId; mergeBase?: string; changedEntrypoints: RecordedCollectionState; changedContracts: RecordedCollectionState }
  | { kind: "walk-cost"; owner: ReadId; walk: "symbols" | "modules"; expansionsUsed: number };

// Keep domain payload fields separate from record metadata: future variants cannot silently overwrite either.
type UnionKeys<T> = T extends T ? keyof T : never;
type NoReservedKeys<T extends never> = T;
export type PartPayloadMetadataBoundary = NoReservedKeys<Extract<UnionKeys<PartPayload>, "id" | "supports">>;
export type PartKind = PartPayload["kind"];
export type Part = PartPayload & { id: PartId; supports: readonly Support[] };
export type PartOf<K extends PartKind> = Extract<Part, { kind: K }>;

/**
 * The normalized observations of one or more sources (the output of `normalizeSource` and `mergeEvidence`): every table
 * before bindings/entities/relations/connections, ordered by id, supports ordered by source/read/pointer.
 */
export type EvidenceSet = {
  snapshots: readonly SnapshotRecord[];
  sources: readonly SourceRecord[];
  reads: readonly ReadRecord[];
  files: readonly FileRecord[];
  anchors: readonly AnchorRecord[];
  evidence: readonly EvidenceRecord[];
  parts: readonly Part[];
  redactions: readonly RedactionRecord[];
};

export type BoundAnchor =
  | { status: "resolved"; entity: EntityId }
  | { status: "unresolved"; anchor: AnchorId; reason: "ambiguous" | "redacted" | "conflicting-coordinate" | "missing-provenance" };
export type BindingRecord = { anchor: AnchorId; binding: BoundAnchor };

/** The identity of an entrypoint with known handlers as entities; `basePath` and guards stay observations in parts. */
export type EntryIdentity =
  | { kind: "http-route"; method: HttpMethod; path: string; version?: string; handler: EntityId }
  | { kind: "ui-route"; path: string; outlet?: string; component: EntityId | "unknown" }
  | { kind: "listener"; protocol: Listener["protocol"]; destination: string; handler: EntityId }
  | { kind: "job"; trigger: Job["trigger"]; handler: EntityId };

export type EntityRecord =
  | { id: EntityId; kind: "declaration"; file: FileId; anchors: readonly AnchorId[]; declarations: readonly PartId[] }
  | { id: EntityId; kind: "entrypoint"; snapshot: SnapshotId; identity: EntryIdentity; parts: readonly PartId[] };

/** One observation of a relation in its own required context; confidences and locations are never maximized. */
export type Attestation = {
  contextKey: string;
  parts: readonly PartId[];
  reads: readonly ReadId[];
  locations?: readonly CallLocation[];
  confidence?: number;
};

export type RelationValue =
  | { kind: "serves-entrypoint"; entrypoint: EntityId; handler: EntityId }
  | { kind: "symbol-dependence"; from: EntityId; to: EntityId; basis: DependenceBasis }
  | { kind: "file-import" | "file-use" | "unresolved-file-name"; from: FileId; to: FileId }
  | { kind: "module-dependence"; from: FileId; to: FileId; qualifier: Pick<NonNullable<ReachedModule["via"]>, "kind" | "typeOnly" | "form" | "specifier"> }
  | { kind: "entrypoint-origin"; entrypoint: PartId; seed: PartId }
  | { kind: "module-origin"; module: PartId; origin: PartId }
  | { kind: "workspace-match"; from: CallLocation & { repo: string; symbol: string }; to: { repo: string; kind: Entrypoint["kind"]; name: string; handler: EntityId }; transport: Link["transport"]; basis: LinkBasis; profiles?: readonly string[] }
  | { kind: "candidate-for-name"; name: PartId; repo: string; basis: NameCandidate["basis"] }
  | { kind: "shares-evidence"; /** Every part citing the evidence, two or more, sorted. */ parts: readonly PartId[]; evidence: EvidenceId };
export type RelationKind = RelationValue["kind"];
export type RelationRecord = { id: RelationId; value: RelationValue; attestations: readonly Attestation[] };

export type ConnectionRule = "handler-declaration" | "change-dependent" | "reached-handler" | "linked-entrypoint" | "shared-file-import" | "used-import" | "shared-support";
export type Connection = {
  id: ConnectionId;
  rule: ConnectionRule;
  parts: readonly PartId[];
  relations: readonly RelationId[];
  supports: readonly Support[];
  entities?: readonly EntityId[];
};

export type IssueDetail =
  | { kind: "snapshot-difference"; repo: string; snapshots: readonly SnapshotId[] }
  | { kind: "context-mismatch"; field: "trust" | "producer" | "schema" | "engine" | "workspace"; reason: "different" | "unavailable" }
  | { kind: "ambiguous-declaration"; anchor: AnchorId; candidates: readonly PartId[] }
  | { kind: "conflicting-coordinate"; anchors: readonly AnchorId[] }
  | { kind: "unresolved-endpoint"; part: PartId; target: SymbolNameRef }
  | { kind: "missing-provenance"; repo: string; part?: PartId; side?: "base" | "head" }
  | { kind: "missing-origin-reference"; part: PartId; table: "seeds" | "module-origins"; index: number }
  | { kind: "missing-link-reference"; part: PartId; linkId: string; position: number }
  | { kind: "redacted-identity"; owner: CutOwner; pointer?: string };
export type CompositionIssue = { sources: readonly SourceId[]; reads: readonly ReadId[] } & IssueDetail;

/** The tables shared by the materialized and the wire graph; `issues` travel once, in `coverage.issues`. */
type GraphTables = {
  snapshots: readonly SnapshotRecord[];
  reads: readonly ReadRecord[];
  files: readonly FileRecord[];
  anchors: readonly AnchorRecord[];
  evidence: readonly EvidenceRecord[];
  parts: readonly Part[];
  entities: readonly EntityRecord[];
  bindings: readonly BindingRecord[];
  relations: readonly RelationRecord[];
  connections: readonly Connection[];
};
/** What `materializeEvidence` computes; sources have no request index yet. */
export type MaterializedGraph = GraphTables & { sources: readonly SourceRecord[] };
/** The wire graph of `full`: sources carry their request index. */
export type CompositionGraph = GraphTables & { sources: readonly SourceDescriptor[] };
export type MaterializedComposition = { graph: MaterializedGraph; issues: readonly CompositionIssue[] };
/** A broken internal reference: a defect of normalization or materialization, never a semantic issue. Values are public ids. */
export type CompositionInvariantFault = { kind: "invalid-composition-reference"; table: string; id: string; field: string };

export type ComposeInput = {
  queries: readonly ComposeQuery[];
  /** Default summary. */
  mode?: ResponseMode;
  expect?: CompositionIdentity;
  /** Integer 1..2147483647, no default. */
  deadlineMs?: number;
};

export type UnavailableReason = "deadline" | "unresolved-context" | "redacted-context";
export type Verification = { status: "available"; identity: CompositionIdentity } | { status: "unavailable"; reason: UnavailableReason };
export type RepeatRequest =
  | { status: "available"; query: ComposeQuery; strategy: "pinned-replay" | "fresh-read" }
  | { status: "unavailable"; reason: UnavailableReason };

export type CoverageSummary = {
  reads: { complete: number; partial: number; unknown: number };
  unknowns: readonly { source: SourceId; owner: CutOwner; reason: UnknownReason }[];
  limits: readonly { source: SourceId; owner: CutOwner; kind: Cut["kind"]; limit?: number; cuts: number; places: number }[];
  issues: readonly CompositionIssue[];
};

export type CompositionCounts = {
  sources: number; reads: number; files: number; anchors: number; entities: number; evidence: number;
  parts: number; relations: number; connections: number; unknownFindings: number; unknownComponents: number;
};

/** The public, redacted sidecars of one source; never part of an identity. */
export type SourceDelivery = {
  source: SourceId;
  repositoryRoots?: NonNullable<FactRead<unknown>["repositoryRoots"]>;
  freshness?: WorkspaceRefresh["freshness"];
  resolution?: WorkspaceRefresh["resolution"];
  live?: LiveStaleNotice;
  workspaceLive?: readonly WorkspaceLiveNotice[];
};
export type CompositionDelivery = readonly SourceDelivery[];

/** What the coordinator hands the renderer, independent of mode; not a `CallToolResult`. */
export type CompositionResult = {
  graph: CompositionGraph;
  coverage: CoverageSummary;
  counts: CompositionCounts;
  verification: Verification;
  requests: readonly RepeatRequest[];
  delivery?: CompositionDelivery;
};

/** Text modes keep findings, source states and limits in text; the receipt carries verification and safe repeat queries. */
export type ComposeReceipt = {
  kind: "composition-receipt"; compositionSchema: 1;
  mode: "summary" | "details";
  verification: Verification;
  requests: readonly RepeatRequest[];
};
export type ComposeFull = {
  kind: "composition"; compositionSchema: 1; mode: "full";
  verification: Verification;
  requests: readonly RepeatRequest[];
  graph: CompositionGraph;
  coverage: CoverageSummary;
  counts: CompositionCounts;
  delivery?: CompositionDelivery;
};

/** `q1:<ordinal>` in the sorted unique query sequence; never a digest of possibly secret arguments. */
export type QueryKey = `q1:${number}`;
/** A failed assertion about one source, distinct from a workspace replay mismatch. */
export type SourceIdentityCause =
  | { kind: "result-changed"; detail: string; stage: "source-identity"; expected: string; actual: string }
  | { kind: "replay-unavailable"; detail: string; stage: "source-identity"; reason: UnavailableReason };
export type ComposeFault =
  | { kind: "composition-request-too-large"; detail: string; bytes: number; limit: number }
  | { kind: "composition-conflicting-expectations"; detail: string; queryKey: QueryKey; requestIndices: readonly number[] }
  | { kind: "composition-source-fault"; detail: string; queryKey: QueryKey; family: ToolFamily; requestIndices: readonly number[]; cause: QueryFault | SourceIdentityCause }
  | { kind: "result-changed"; detail: string; stage: "composition"; expected: CompositionIdentity; actual?: CompositionIdentity }
  | { kind: "replay-unavailable"; detail: string; stage: "composition"; reason: UnavailableReason }
  | { kind: "deadline"; detail: string }
  | { kind: "aborted"; detail: string }
  | { kind: "internal-fault"; detail: string };
