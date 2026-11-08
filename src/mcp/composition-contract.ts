/**
 * The request, receipt and full shapes of `ye_ast_compose` and its faults; the composition graph they carry is the core
 * contract of evidence-composition.port.ts.
 */
import type { ResponseMode } from "./presentation.ts";
import type { Cut, UnknownReason } from "../core/domain/shared/fact.ts";
import type { CutOwner } from "../core/domain/composition/source-read.ts";
import type { LiveStaleNotice, WorkspaceLiveNotice } from "../core/ports/live-queries.port.ts";
import type { FactRead, WorkspaceRefresh } from "../core/ports/workspace-queries.port.ts";
import type { CompositionGraph, CompositionIdentity, CompositionIssue, QueryFamily, SourceId } from "../core/ports/evidence-composition.port.ts";
import type { ComposeQuery } from "./query-schema.ts";
import type { QueryFault } from "./query-runner.ts";

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
  | { kind: "composition-source-fault"; detail: string; queryKey: QueryKey; family: QueryFamily; requestIndices: readonly number[]; cause: QueryFault | SourceIdentityCause }
  | { kind: "result-changed"; detail: string; stage: "composition"; expected: CompositionIdentity; actual?: CompositionIdentity }
  | { kind: "replay-unavailable"; detail: string; stage: "composition"; reason: UnavailableReason }
  | { kind: "deadline"; detail: string }
  | { kind: "aborted"; detail: string }
  | { kind: "internal-fault"; detail: string };
