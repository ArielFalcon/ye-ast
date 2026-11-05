/**
 * The stateless coordinator of `ye_ast_compose`: validates the whole request before any dispatch, orders
 * and deduplicates its semantic queries, executes them one at a time through the shared runner under one linked signal,
 * normalizes and unites each source as it arrives, then materializes and verifies once before anything is delivered.
 * Nothing survives the call: no handle, cache or result store. It never calls another MCP server and never parses text.
 */
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import { isFullObjectId } from "../core/domain/shared/revision.ts";
import type { Result } from "../core/domain/shared/result.ts";
import { executeQuery, type ExecutedSource, type QueryExecutionContext, type QueryFault } from "./query-runner.ts";
import { familyOf, type ComposeQuery, type SemanticQuery } from "./query-schema.ts";
import { assertSourceIdentity } from "./evidence-cursor.ts";
import { normalizeSource } from "./composition-normalize.ts";
import { materializeEvidence, mergeEvidence, validateCompositionReferences, validateCompositionIssues } from "./compose-evidence.ts";
import { compositionIdentity } from "./composition-identity.ts";
import { COMPOSE_INPUT, COMPOSE_LIMITS, COMPOSE_QUERY } from "./composition-input.ts";
import type { CutOwner } from "./select-evidence.ts";
import type {
  ComposeFault, ComposeInput, CompositionCounts, CompositionIdentity, CompositionResult, CoverageSummary, EvidenceSet,
  MaterializedComposition, Part, QueryKey, ReadOwner, RepeatRequest, SourceDelivery, SourceDescriptor, SourceId,
  UnavailableReason, Verification,
} from "./composition-contract.ts";

export { COMPOSE_LIMITS };

type SourceFault = Extract<ComposeFault, { kind: "composition-source-fault" }>;
type Run = Result<CompositionResult, ComposeFault>;
type Failure = { ok: false; fault: ComposeFault };

/** One unique semantic query of the request, at its position in the sorted unique sequence. */
type Planned = { key: QueryKey; ordinal: number; query: SemanticQuery; expect?: string; requestIndices: number[] };
/** What one execution contributes beside its evidence; the executed body itself is dropped after normalization. */
type Contribution = { request: RepeatRequest; delivery?: SourceDelivery; blockers: readonly UnavailableReason[] };

/** Executes a composition request. Invalid input throws the SDK's invalid-params error, exactly as tool validation does. */
export async function runComposition(input: ComposeInput, ctx: QueryExecutionContext): Promise<Run> {
  const parsed = COMPOSE_INPUT.safeParse(input);
  if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ye_ast_compose: ${issuesOf(parsed.error)}`);
  const bytes = Buffer.byteLength(canonicalJson(input), "utf8");
  if (bytes > COMPOSE_LIMITS.maxRequestBytes) {
    return failure({ kind: "composition-request-too-large", detail: `Composition request is ${bytes} bytes; the limit is ${COMPOSE_LIMITS.maxRequestBytes}`, bytes, limit: COMPOSE_LIMITS.maxRequestBytes });
  }
  const planned = plan(parsed.data.queries);
  if (!planned.ok) return planned;
  for (const query of planned.value) {
    const target = ctx.catalog.resolve(query.query.arguments.repo);
    if (!target.ok) return failure(sourceFault(query, target.fault));
  }
  const run = linkedRun(ctx.signal, parsed.data.deadlineMs);
  try {
    return await execute(planned.value, parsed.data.expect, ctx, run);
  } catch (error) {
    return run.stopped() ?? failure({ kind: "internal-fault", detail: ctx.deps.redaction.redactError(error) });
  } finally {
    run.dispose();
  }
}

/** Issue paths and codes only: never the submitted values. */
function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.code}`).join("; ");
}

function failure(fault: ComposeFault): Failure {
  return { ok: false, fault };
}

/**
 * Deduplicates exactly equal semantic queries, presentation and assertions excluded from the key, and orders the unique
 * ones by `canonicalJson([name, arguments])`. A query asserted once keeps its assertion; two different assertions of one
 * query are a conflict before any dispatch.
 */
function plan(queries: readonly ComposeQuery[]): Result<Planned[], ComposeFault> {
  const byKey = new Map<string, { query: SemanticQuery; expects: Set<string>; requestIndices: number[] }>();
  queries.forEach((query, index) => {
    const semantic = semanticOf(query);
    const key = canonicalJson([semantic.name, semantic.arguments]);
    const entry = byKey.get(key) ?? { query: semantic, expects: new Set<string>(), requestIndices: [] };
    if (query.expect !== undefined) entry.expects.add(query.expect);
    entry.requestIndices.push(index);
    byKey.set(key, entry);
  });
  const ordered = [...byKey.entries()].sort(([a], [b]) => compareText(a, b));
  const result: Planned[] = [];
  for (const [ordinal, [, entry]] of ordered.entries()) {
    const key: QueryKey = `q1:${ordinal}`;
    if (entry.expects.size > 1) {
      return failure({ kind: "composition-conflicting-expectations", detail: `Query ${key} asserts different source identities`, queryKey: key, requestIndices: entry.requestIndices });
    }
    const [expect] = entry.expects;
    result.push({ key, ordinal, query: entry.query, ...(expect === undefined ? {} : { expect }), requestIndices: entry.requestIndices });
  }
  return { ok: true, value: result };
}

function semanticOf(query: ComposeQuery): SemanticQuery {
  const { expect: _expect, ...semantic } = query;
  return semantic;
}

function sourceFault(query: Planned, cause: QueryFault): SourceFault {
  const family = familyOf(query.query.name);
  return { kind: "composition-source-fault", detail: `Query ${query.key} (${family}) failed: ${cause.kind}`, queryKey: query.key, family, requestIndices: query.requestIndices, cause };
}

type LinkedRun = {
  signal: AbortSignal;
  /** The batch fault when the request was cancelled or its deadline passed, also by elapsed time a timer missed. */
  stopped(): Failure | undefined;
  /** Settles with the promise, or with `undefined` as soon as the batch stops; the abandoned port keeps its own cleanup. */
  race<T>(promise: Promise<T>): Promise<T | undefined>;
  dispose(): void;
};

function linkedRun(parent: AbortSignal | undefined, deadlineMs: number | undefined): LinkedRun {
  const controller = new AbortController();
  const started = performance.now();
  let cause: "aborted" | "deadline" | undefined;
  const stop = (reason: "aborted" | "deadline") => {
    cause ??= reason;
    controller.abort();
  };
  const onAbort = () => stop("aborted");
  if (parent?.aborted) stop("aborted");
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = deadlineMs === undefined || controller.signal.aborted ? undefined : setTimeout(() => stop("deadline"), deadlineMs);
  return {
    signal: controller.signal,
    stopped() {
      if (!controller.signal.aborted && deadlineMs !== undefined && performance.now() - started >= deadlineMs) stop("deadline");
      if (cause === undefined) return undefined;
      return failure(cause === "deadline" ? { kind: "deadline", detail: `Composition exceeded its ${deadlineMs} ms deadline` } : { kind: "aborted", detail: "Composition was cancelled" });
    },
    race<T>(promise: Promise<T>): Promise<T | undefined> {
      if (controller.signal.aborted) return Promise.resolve(undefined);
      return new Promise<T | undefined>((resolve, reject) => {
        const onStop = () => resolve(undefined);
        controller.signal.addEventListener("abort", onStop, { once: true });
        promise.then(
          (value) => { controller.signal.removeEventListener("abort", onStop); resolve(value); },
          (error: unknown) => { controller.signal.removeEventListener("abort", onStop); reject(error); },
        );
      });
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** Lets timers, cancellation and other requests run between sources. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function execute(queries: readonly Planned[], expect: CompositionIdentity | undefined, ctx: QueryExecutionContext, run: LinkedRun): Promise<Run> {
  const { digest, redaction } = ctx.deps;
  const internal = (error: unknown): Failure => failure({ kind: "internal-fault", detail: redaction.redactError(error) });
  let evidence: EvidenceSet | undefined;
  const contributions = new Map<SourceId, Contribution[]>();
  for (const query of queries) {
    const before = run.stopped();
    if (before) return before;
    const executed = await run.race(executeQuery(query.query, { deps: ctx.deps, catalog: ctx.catalog, signal: run.signal }));
    const stopped = run.stopped();
    if (stopped) return stopped;
    if (executed === undefined) return internal("Composition query settled without a result");
    if (!executed.ok) return failure(sourceFault(query, executed.fault));
    const source = executed.value;
    if (query.expect !== undefined) {
      const verified = verifySource(query, source);
      if (verified) return verified;
    }
    let set: EvidenceSet;
    try {
      set = normalizeSource(source, digest, source.identityGuard.changedArguments ? { discriminator: query.ordinal } : undefined);
      evidence = evidence === undefined ? set : mergeEvidence(evidence, set);
    } catch (error) {
      return internal(error);
    }
    const [record, ...extra] = set.sources;
    if (record === undefined || extra.length > 0) return internal("A normalized source must contain exactly one source record");
    const list = contributions.get(record.id) ?? [];
    list.push(contributionOf(source, set));
    contributions.set(record.id, list);
    await yieldToEventLoop();
  }
  if (evidence === undefined) return internal("A composition needs at least one source");
  const stopped = run.stopped();
  if (stopped) return stopped;

  let materialized: MaterializedComposition;
  try {
    materialized = materializeEvidence(evidence, digest);
  } catch (error) {
    return internal(error);
  }
  const integrity = validateCompositionReferences(materialized.graph);
  if (!integrity.ok) return failure({ kind: "internal-fault", detail: `Invalid composition reference ${integrity.fault.table}.${integrity.fault.field}: ${integrity.fault.id}` });
  const issueIntegrity = validateCompositionIssues(materialized.graph, materialized.issues);
  if (!issueIntegrity.ok) return failure({ kind: "internal-fault", detail: `Invalid composition issue ${issueIntegrity.fault.field}` });

  const result = assemble(materialized, contributions, digest);
  if (expect !== undefined) {
    if (result.verification.status === "unavailable") {
      return failure({ kind: "replay-unavailable", detail: "The composition cannot be verified", stage: "composition", reason: result.verification.reason });
    }
    if (result.verification.identity !== expect) {
      return failure({ kind: "result-changed", detail: "The composition result changed", stage: "composition", expected: expect, actual: result.verification.identity });
    }
  }
  await yieldToEventLoop();
  return run.stopped() ?? { ok: true, value: result };
}

/** A source expectation checks the existing `mcp-r1` recovery, exactly as the original tool's `expect` does. */
function verifySource(query: Planned, source: ExecutedSource): Failure | undefined {
  const expected = query.expect;
  if (expected === undefined) return undefined;
  if (source.recovery === undefined) return failure({ kind: "internal-fault", detail: `Query ${query.key} asserts an identity its family does not carry` });
  const verified = assertSourceIdentity(source.recovery, expected);
  if (verified.ok) return undefined;
  const base = { kind: "composition-source-fault" as const, queryKey: query.key, family: source.family, requestIndices: query.requestIndices };
  switch (verified.fault.code) {
    case "result-changed":
      return failure({ ...base, detail: `Query ${query.key} (${source.family}) result changed`, cause: { kind: "result-changed", detail: "Source result changed", stage: "source-identity", expected: verified.fault.expected, actual: verified.fault.actual } });
    case "replay-unavailable":
      return failure({ ...base, detail: `Query ${query.key} (${source.family}) cannot be verified`, cause: { kind: "replay-unavailable", detail: "Source identity unavailable", stage: "source-identity", reason: verified.fault.reason } });
    case "invalid-cursor":
      return failure({ kind: "internal-fault", detail: `Query ${query.key} carries a malformed recovery identity` });
  }
}

// Per-source contribution: repeat request, delivery sidecars and what blocks verification.

function contributionOf(source: ExecutedSource, set: EvidenceSet): Contribution {
  const delivery = deliveryOf(source, set.sources[0]!.id);
  return { request: repeatRequestOf(source), ...(delivery === undefined ? {} : { delivery }), blockers: blockersOf(source, set) };
}

const unavailable = (reason: UnavailableReason): RepeatRequest => ({ status: "unavailable", reason });

/**
 * The recoverable three repeat their pinned `mcp-r1` recipe; the other four repeat the validated original request, never
 * a recipe with redacted or replaced arguments. Every query is validated by the compose schema before it is offered.
 */
function repeatRequestOf(source: ExecutedSource): RepeatRequest {
  switch (source.family) {
    case "entrypoints":
    case "impact":
    case "callers": {
      const recovery = source.recovery;
      if (recovery === undefined) return unavailable("unresolved-context");
      if (recovery.status === "unavailable") return unavailable(recovery.reason);
      if (recovery.query.name !== source.query.name) return unavailable("unresolved-context");
      const query = COMPOSE_QUERY.safeParse({ name: recovery.query.name, arguments: recovery.query.arguments, expect: recovery.resultIdentity });
      return query.success ? { status: "available", query: query.data, strategy: "pinned-replay" } : unavailable("unresolved-context");
    }
    case "importers":
    case "outline":
    case "workspace":
    case "decisions": {
      if (source.identityGuard.changedArguments) return unavailable("redacted-context");
      const query = COMPOSE_QUERY.safeParse({ name: source.query.name, arguments: source.query.arguments });
      return query.success ? { status: "available", query: query.data, strategy: "fresh-read" } : unavailable("unresolved-context");
    }
    default:
      return unreachable(source);
  }
}

function unreachable(source: never): never {
  throw new Error(`Unsupported source ${(source as { family: string }).family}`);
}

/** The public, already redacted sidecars of one source; never part of any identity. */
function deliveryOf(source: ExecutedSource, id: SourceId): SourceDelivery | undefined {
  const { repositoryRoots, refresh, workspaceLive } = source.read;
  const delivery: SourceDelivery = {
    source: id,
    ...(repositoryRoots === undefined ? {} : { repositoryRoots }),
    ...(refresh === undefined ? {} : { freshness: refresh.freshness, resolution: refresh.resolution }),
    ...(source.live === undefined ? {} : { live: source.live }),
    ...(workspaceLive === undefined ? {} : { workspaceLive }),
  };
  return Object.keys(delivery).length > 1 ? delivery : undefined;
}

/** What prevents a deterministic assertion over this source: a deadline, redacted identity, or unresolved context. */
function blockersOf(source: ExecutedSource, set: EvidenceSet): UnavailableReason[] {
  const blockers: UnavailableReason[] = [];
  const recovery = source.recovery?.status === "unavailable" ? source.recovery.reason : undefined;
  if (recovery === "deadline" || recordsDeadline(set)) blockers.push("deadline");
  const guard = source.identityGuard;
  if (recovery === "redacted-context" || guard.changedArguments || guard.changedSnapshot || guard.changedIdentityPointers.length > 0 || set.redactions.length > 0) blockers.push("redacted-context");
  const snapshot = source.read.fact.snapshot;
  const resolved = snapshot.kind === "sha" ? isFullObjectId(snapshot.sha) : isFullObjectId(snapshot.head) && snapshot.stateId.length > 0;
  if (recovery === "unresolved-context" || !resolved) blockers.push("unresolved-context");
  return blockers;
}

/** A deadline recorded anywhere in the source: a read's cut or unknown reason, or an unknown finding of a part. */
function recordsDeadline(set: EvidenceSet): boolean {
  const reads = set.reads.some(({ analysis }) => analysis.status === "unknown" ? analysis.reason === "deadline" : analysis.status === "partial" && analysis.cuts.some((cut) => cut.kind === "deadline"));
  return reads || set.parts.some((part) => unknownFindingReason(part) === "deadline");
}

/** The reason of a `Finding`-shaped unknown a part carries: an unknown entrypoint finding, basePath or call-site target. */
function unknownFindingReason(part: Part): string | undefined {
  switch (part.kind) {
    case "unknown-finding":
      return part.reason;
    case "entrypoint":
      return part.entry.kind === "http-route" && part.entry.basePath.status === "unknown" ? part.entry.basePath.reason : undefined;
    case "call-site":
      return part.site.target.status === "unknown" ? part.site.target.reason : undefined;
    default:
      return undefined;
  }
}

const VERIFICATION_ORDER: readonly UnavailableReason[] = ["deadline", "redacted-context", "unresolved-context"];

function assemble(materialized: MaterializedComposition, contributions: ReadonlyMap<SourceId, readonly Contribution[]>, digest: QueryExecutionContext["deps"]["digest"]): CompositionResult {
  const { graph, issues } = materialized;
  const records = [...graph.sources].sort((a, b) => compareText(a.id, b.id));
  const chosen = records.map((record) => {
    const candidates = contributions.get(record.id);
    if (candidates === undefined || candidates.length === 0) throw new Error(`Source ${record.id} has no execution`);
    // Distinct invocations of one source: the smallest public recipe wins, never the first in input order.
    const [best] = [...candidates].sort((a, b) => compareText(canonicalJson([a.request, a.delivery ?? null]), canonicalJson([b.request, b.delivery ?? null])));
    return { record, best: best!, blockers: new Set(candidates.flatMap((candidate) => candidate.blockers)) };
  });
  const sources: SourceDescriptor[] = chosen.map(({ record }, requestIndex) => ({ ...record, requestIndex }));
  const blockers = new Set(chosen.flatMap(({ blockers }) => [...blockers]));
  const blocked = VERIFICATION_ORDER.find((reason) => blockers.has(reason));
  const verification: Verification = blocked === undefined
    ? { status: "available", identity: compositionIdentity(digest, records.map((record) => record.id)) }
    : { status: "unavailable", reason: blocked };
  const delivery = chosen.flatMap(({ best }) => best.delivery === undefined ? [] : [best.delivery]);
  const wire = { ...graph, sources };
  return {
    graph: wire,
    coverage: coverageOf(wire, issues),
    counts: countsOf(wire),
    verification,
    requests: chosen.map(({ best }) => best.request),
    ...(delivery.length === 0 ? {} : { delivery }),
  };
}

function publicOwner(owner: ReadOwner): CutOwner {
  if (owner.kind !== "read") return owner;
  const { readKind: _readKind, ...rest } = owner;
  return rest;
}

const byCanonical = <T>(a: T, b: T) => compareText(canonicalJson(a), canonicalJson(b));

/**
 * Counts of recorded reads, nested owners included, never presented as independent analyses; one limit entry per owner,
 * cut kind and limit, with the same cut/place counting as the original selection summary.
 */
function coverageOf(graph: CompositionResult["graph"], issues: MaterializedComposition["issues"]): CoverageSummary {
  const reads = { complete: 0, partial: 0, unknown: 0 };
  const unknowns: CoverageSummary["unknowns"][number][] = [];
  const limits = new Map<string, { source: SourceId; owner: CutOwner; kind: CoverageSummary["limits"][number]["kind"]; limit?: number; cuts: number; places: number }>();
  for (const read of graph.reads) {
    reads[read.analysis.status]++;
    const owner = publicOwner(read.owner);
    if (read.analysis.status === "unknown") unknowns.push({ source: read.source, owner, reason: read.analysis.reason });
    if (read.analysis.status !== "partial") continue;
    for (const cut of read.analysis.cuts) {
      const key = canonicalJson([read.source, owner, cut.kind, cut.limit ?? null]);
      const entry = limits.get(key) ?? { source: read.source, owner, kind: cut.kind, ...(cut.limit === undefined ? {} : { limit: cut.limit }), cuts: 0, places: 0 };
      entry.cuts++;
      entry.places += Math.max(0, cut.at.length - 1);
      limits.set(key, entry);
    }
  }
  return { reads, unknowns: unknowns.sort(byCanonical), limits: [...limits.values()].sort(byCanonical), issues };
}

function countsOf(graph: CompositionResult["graph"]): CompositionCounts {
  return {
    sources: graph.sources.length, reads: graph.reads.length, files: graph.files.length, anchors: graph.anchors.length,
    entities: graph.entities.length, evidence: graph.evidence.length, parts: graph.parts.length, relations: graph.relations.length,
    connections: graph.connections.length,
    unknownFindings: graph.parts.filter((part) => unknownFindingReason(part) !== undefined).length,
    unknownComponents: graph.parts.filter((part) => part.kind === "entrypoint" && part.entry.kind === "ui-route" && part.entry.component === "unknown").length,
  };
}
