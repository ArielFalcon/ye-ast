/**
 * The contract of evidence composition (ADR-0038): the executed sources it reads, its identifiers, normalized tables,
 * the `Part` union, the evidence set, the materialized graph and its issues. No I/O and no behaviour.
 */
import type { Entrypoint, Job, Listener } from "../domain/entrypoints/entrypoint.ts";
import type { BasePath, HttpMethod, HttpRoute } from "../domain/entrypoints/http-route.ts";
import type { UiRoute } from "../domain/entrypoints/ui-route.ts";
import type { SeedBasis } from "../domain/change/seeds.ts";
import type { DependenceBasis, ImpactedSymbol, ReachedEntrypoint, ImpactValue } from "../domain/impact/impact-fact.ts";
import type { ChangedEntrypoint } from "../domain/impact/changed-entrypoints.ts";
import type { ChangedContract } from "../domain/impact/changed-contracts.ts";
import type { ModuleOrigin, ReachedModule } from "../domain/impact/module-dependency.ts";
import type { ImportedFile, ImportersValue } from "../domain/impact/importers-fact.ts";
import type { OutlineDeclaration, OutlineImport, OutlineValue } from "../domain/outline/outline-fact.ts";
import type { ExternalCalls, TraceEffect, TraceStep, TraceValue } from "../domain/trace/trace-fact.ts";
import type { CallSite, EventTarget, HttpTarget, UnresolvedCallSite } from "../domain/topology/call-site.ts";
import type { ImpactedLink, Link, LinkBasis, UnlinkedCallSite } from "../domain/topology/link.ts";
import type { NameCandidate, OutwardKind } from "../domain/topology/outward-name.ts";
import type { Decision, DecisionKind, DecisionOption } from "../domain/decisions/decision.ts";
import type { AnswerBody, ConsequencesValue } from "../domain/contracts/consequence-fact.ts";
import type { Hop } from "../domain/contracts/consumer-flow.ts";
import type { BranchCondition, ProducerVerdict } from "../domain/contracts/request-origin.ts";
import type { Guard, UseOperation, Verdict } from "../domain/contracts/verdict.ts";
import type { Cut, Evidence, FactInputs, Producer, SchemaVersion, SnapshotRef, UnknownReason } from "../domain/shared/fact.ts";
import type { FactRead, WorkspaceValue } from "./workspace-queries.port.ts";
import type { RepoImpact, WorkspaceImpactValue } from "./workspace-impact-queries.port.ts";
import type { DecisionValue } from "./decision-queries.port.ts";
import type { Analysis, CutOwner } from "../domain/composition/source-read.ts";
import type { EntrypointMap } from "../domain/map/entrypoint-map.ts";

export type QueryFamily = "entrypoints" | "callers" | "impact" | "importers" | "outline" | "trace" | "workspace" | "decisions" | "contract_consequences";

/** A workspace read without its internal repositories, which hold absolute paths and every entrypoint. */
export type PublicWorkspaceValue = Omit<WorkspaceValue, "repositories">;
/** A read after the public boundary: its fact and sidecars redacted, and its private repository sources removed. */
export type PublicRead<T> = Omit<FactRead<T>, "repositorySources">;

export type SourcePayload =
  | { family: "entrypoints"; read: PublicRead<EntrypointMap> }
  | { family: "impact" | "callers"; branch: "local"; read: PublicRead<ImpactValue> }
  | { family: "impact" | "callers"; branch: "workspace"; read: PublicRead<WorkspaceImpactValue> }
  | { family: "importers"; read: PublicRead<ImportersValue> }
  | { family: "outline"; read: PublicRead<OutlineValue> }
  | { family: "trace"; read: PublicRead<TraceValue> }
  | { family: "workspace"; read: PublicRead<PublicWorkspaceValue> }
  | { family: "decisions"; read: PublicRead<DecisionValue> }
  | { family: "contract_consequences"; read: PublicRead<ConsequencesValue> };

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
  | { family: Exclude<QueryFamily, "impact" | "callers"> };

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

/** What tells two hypotheses apart in a part: the operation and the property, not how the change is written. */
export type HypothesisIdentity = Pick<AnswerBody["hypothesis"], "method" | "path" | "target" | "property">;
/** A step of a chain: its place is evidence of the repository that holds it. */
export type ConsequenceHopData = Omit<Hop, "evidence"> & { evidence: EvidenceId };
type PlacedGuard<G> = G extends Guard ? Omit<G, "evidence"> & { evidence: EvidenceId } : never;
export type GuardData = PlacedGuard<Guard>;
export type UseVerdictData = Exclude<Verdict, { kind: "admits" }> | { kind: "admits"; guards: readonly GuardData[] };
/** The witness of an `incompatible` producer keeps its place and conditions; its hops are the tail of the part's chain. */
export type ProducerVerdictData =
  | Exclude<ProducerVerdict, { kind: "incompatible" }>
  | { kind: "incompatible"; witness: { value: string; at: EvidenceId; conditions: readonly (Omit<BranchCondition, "at"> & { at: EvidenceId })[] } };
/** The link a consequence came through: the call site in the consumer's repository, and the handler it reaches in the server's. */
export type ConsequenceLinkData = { id: string; basis: LinkBasis; call: CallLocation & { symbol: string }; handler: AnchorId };

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
  /** `unproved`: the declaration uses a name no binding proves, so an empty `uses` is not "nothing". */
  | { kind: "outline-declaration"; anchor: AnchorId; kindName: OutlineDeclaration["kind"]; children?: readonly PartId[]; uses?: readonly OutlineUseRecord[]; unproved?: true }
  | { kind: "outline-file"; file: FileId; declarations: readonly PartId[]; imports: readonly OutlineImportRecord[] }
  | { kind: "unheld-file"; file: FileId }
  | {
      kind: "trace-step"; anchor: AnchorId; kindName: string; step: number; depth: number; parent?: number; seen?: number;
      at?: NonNullable<TraceStep["at"]>; via?: NonNullable<TraceStep["via"]>; deferred?: true;
      /** Folded declarations, in the fact's order; one anchor may appear twice, once direct and once deferred. */
      leaves?: readonly { anchor: AnchorId; deferred?: true }[];
      external?: readonly ExternalCalls[];
      /** Every body a call to this body-less method may run, when the declared hierarchy names them all. */
      alternatives?: readonly AnchorId[];
      /** The requests and messages its body makes through a declared client (RFC-0013 R12). */
      effects?: readonly TraceEffect[];
    }
  | { kind: "trace-root"; target: string; steps: readonly number[] }
  | { kind: "reading-range"; file: FileId; start: number; end: number; steps: readonly number[] }
  | { kind: "outward-name"; origin: EvidenceOrigin; name: string; kindName: OutwardKind; evidence: readonly EvidenceId[]; disposition: "stated" | "unserved" }
  | { kind: "name-candidate"; context: ReadId; name: string; repo: string; basis: NameCandidate["basis"]; evidence: readonly EvidenceId[] }
  | { kind: "call-site"; site: CallSiteData; disposition: "matched" | "unmatched" | "external" }
  | { kind: "unresolved-call-site"; site: UnresolvedCallSite }
  | { kind: "workspace-link"; link: LinkData; direction?: ImpactedLink["direction"]; reach?: readonly LinkReference[]; operations?: ImpactedLink["operations"] }
  | { kind: "unlinked-call-site"; site: UnlinkedCallSiteData }
  | { kind: "workspace-context"; context: WorkspaceContextData }
  | { kind: "decision"; context: ReadId; decisionId: Decision["id"]; kindName: DecisionKind; subject: string; outwardKinds?: readonly OutwardKind[]; allowsFreeText: boolean; required: boolean; evidence: readonly EvidenceId[]; options: readonly DecisionOptionData[] }
  | { kind: "impact-context"; owner: ReadId; mergeBase?: string; changedEntrypoints: RecordedCollectionState; changedContracts: RecordedCollectionState }
  | { kind: "walk-cost"; owner: ReadId; walk: "symbols" | "modules"; expansionsUsed: number }
  | { kind: "trace-totals"; owner: ReadId; lines: number; expanded: number }
  | { kind: "consequence-use"; repo: string; hypothesis: HypothesisIdentity; place: EvidenceId; link: ConsequenceLinkData; verdict: UseVerdictData; operation: UseOperation; path: string; changed: string; chain: readonly ConsequenceHopData[] }
  | { kind: "consequence-producer"; repo: string; hypothesis: HypothesisIdentity; place: EvidenceId; link: ConsequenceLinkData; verdict: ProducerVerdictData; path: string; chain: readonly ConsequenceHopData[] }
  /** `places.base` is at the commit the change was read from, `places.head` in the head snapshot; `handlers` are the ones the answer's findings reach. */
  | { kind: "derived-contract-change"; hypothesis: HypothesisIdentity; operation: string; property: string; places: { base: EvidenceId; head: EvidenceId }; handlers: readonly AnchorId[] };

// Payload fields never reuse a record metadata key.
type UnionKeys<T> = T extends T ? keyof T : never;
type NoReservedKeys<T extends never> = T;
export type PartPayloadMetadataBoundary = NoReservedKeys<Extract<UnionKeys<PartPayload>, "id" | "supports">>;
export type PartKind = PartPayload["kind"];
/**
 * One outline import inside its file part: a repository target is the file dependency it creates, and a proven binding
 * holds the anchor of the declaration it reaches, so compose joins it with the other answers about that declaration.
 */
export interface OutlineImportRecord {
  line: number;
  endLine: number;
  specifier?: string;
  kind: OutlineImport["kind"];
  form?: NonNullable<OutlineImport["form"]>;
  typeOnly: boolean;
  target: { kind: "repository"; dependency: PartId } | { kind: "external"; module: string } | { kind: "unresolved"; reason: string };
  bindings: readonly { local?: string; imported: string; typeOnly?: true; declaration?: { anchor: AnchorId; kindName: string } }[];
}

/** One use of a focused declaration: a repository use holds the anchor of the declaration it reaches, so compose joins them. */
export type OutlineUseRecord = ({ declaration: { anchor: AnchorId; kindName: string } } | { module: string } | { global: string }) & {
  relations: readonly string[];
  at: readonly { line: number; column?: number }[];
};

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
