import { boundedProjection, boundedText, type BoundedText } from "./render-budget.ts";
import { dependencyDiagnostic } from "./dependency-schema.ts";
import { callSiteDiagnostic, inheritedGapSchema, unresolvedCallSiteSchema } from "./composition-schema-parts.ts";
import { compactInput } from "./compact-schema.ts";
import { selectedOutputFor } from "./evidence-schema.ts";
import { selectEvidence, type EvidenceSelection, type EvidenceSource, type EvidenceSelectionResult } from "./select-evidence.ts";
import { decodeCursor, validateCursorRequest, validateCursorPosition, assertSourceIdentity, encodeCursor, selectionDigest, type CursorV1 } from "./evidence-cursor.ts";
import { renderEvidenceSelection, type EvidencePage } from "./render-evidence.ts";
import { answerPointer, delivered, envelopeText, unnamedRootLines, RESULT_META } from "./presentation/envelope.ts";
import { renderFactStatus, snapshotLine, SESSION_SCOPE } from "./presentation-context.ts";
import { projectFull } from "./full-projection.ts";
import { ANSWER_FILES_META, WITHHELD, answerInputs, keepAnswer, unwrittenReason, withheld, type Delivery } from "./answer-files.ts";
import { keyTraceLinks, keyWorkspaceImpactLinks, keyWorkspaceLinks, withKeyedValue } from "./link-keys.ts";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { repositoryCatalog, type RepositoryBinding } from "./repository-targeting.ts";
import type { ResponseMode, ResponseRenderer } from "./presentation.ts";
import type { QueryFamily } from "../core/ports/evidence-composition.port.ts";
import type { AnswerFiles } from "../core/ports/answer-files.port.ts";
import { TRUST_MODES, UNKNOWN_REASONS } from "../core/domain/shared/fact.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import { TOOL_INPUTS, callersRecipe, impactRecipe, recipeArguments, type ComposeQuery, type SemanticQuery, type ToolArguments } from "./query-schema.ts";
import { executeQuery, type ExecutedSource, type QueryExecutionDeps } from "./query-runner.ts";
import type { PublicRead } from "../core/ports/evidence-composition.port.ts";
import { COMPOSE_INPUT, composeOutput } from "./composition-schema.ts";
import { runComposition } from "./compose-request.ts";
import type { CompositionResult } from "./composition-contract.ts";
import { composeFull, composeReceipt, renderComposition } from "./render-composition.ts";
import { controlFault, faultContext, renderFault, type CodedFault, type FaultQueryContext, type PublicFault } from "./fault-presentation.ts";
import { renderContractConsequences, renderDecisions, renderEntrypointMap, renderImpact, renderImporters, renderOutline, renderRefresh, renderTrace, renderStale, renderWorkspace, renderWorkspaceImpact } from "./render.ts";

/** The key of the result's `_meta` that carries a stale notice. */
const LIVE_META = "ye-ast/live";
export const WORKSPACE_LIVE_META = "ye-ast/workspace-live";
/** The key of the result's `_meta` that carries the fault of an `isError` answer, beside the text that names its kind first. */
export const FAULT_META = "ye-ast/fault";
export { RESULT_META };
/** Opens the line of a fault's text that carries its fields beyond kind, detail and entries. */
const FAULT_FIELDS_LABEL = "fault fields: ";

function boundRefusal({ bound, mode, status, narrow }: Extract<BoundedText, { kind: "refused" }>, meta: Record<string, unknown> = {}): CallToolResult {
  const explanation = `answer-over-bound: ${bound} bytes; requested ${mode}; status ${status}; narrow: ${narrow.join(", ")}`;
  return { isError: true, content: Buffer.byteLength(explanation) <= bound ? [{ type: "text", text: explanation }] : [], _meta: { ...meta, kind: "answer-over-bound", bound, mode, status, narrow } };
}

/** The read query families plus presentation. The one writer is `answerFiles`, which writes ye-ast's own answer files only and reaches no query family (ADR-0110). */
export interface McpDeps extends QueryExecutionDeps {
  version: string;
  answerBytes?: number;
  answerFiles?: AnswerFiles;
  /** The cache directory the answer folders live under; the instructions name it so a reply's relative pointer resolves. */
  answerCacheRoot?: string;
  /** Default repository binding, plus additional host-declared targets. */
  repository: RepositoryBinding;
  repositories?: readonly RepositoryBinding[];
}

/** Common interpretation rules and a short routing guide, also useful before individual tools are loaded. */
export function instructionsFor(repository: McpDeps["repository"], declared: readonly RepositoryBinding[] = [repository], answerCacheRoot?: string): string {
  const roots = [...declared].sort((a, b) => compareText(a.repoId, b.repoId)).map(({ repoId, path }) => `${repoId} -> ${path}`).join(", ");
  const { languages, frameworks } = SESSION_SCOPE;
  return `ye-ast: deterministic read-only code, Git and declared contract facts for ${repository.path} (id ${repository.repoId}). Use for dependencies/reach, not quality or approval. Reuse snapshot queries.

When to call:
- ye_ast_entrypoints: orient or find route, listener, job or callback handlers.
- ye_ast_callers: declaration dependents and reaching entrypoints.
- ye_ast_impact: diff dependents; added/removed/altered entrypoints.
- ye_ast_importers: who imports or names a file.
- ye_ast_outline: declaration spans/imports; focus by dotted path or line.
- ye_ast_trace: forward calls, effects and reading plan; workspace adds scoped links/library sources.
- ye_ast_workspace: named repositories (HTTP, messaging, dependencies); choose clones.
- ye_ast_decisions: evidence-backed options for workspace gaps; read-only.
- ye_ast_contract_consequences: consumers/producers affected by a contract hypothesis or diff.
- ye_ast_compose: 1..16 queries merge identities; reruns, no storage, non-atomic captures. Obtain dependent coordinates first.

answerBytes bounds the reply text (request overrides host; unset: unbounded).
Reading answers: complete is relative to scope, supported constructs and change selection; partial keeps findings and lists cuts; complete (N undecided): N unknown; unknown never means no impact. callers/impact skip Angular template bindings (trace UI routes; contract_consequences reads templates). Unread type references retain a relation-unread cut. References need not execute; confidence measures resolution, not safety; entrypoint origins are associations. A reply is status, snapshot, findings (summary or details) and "answer: answers/<tool>/<key>/answer.json"${answerCacheRoot === undefined ? "" : ` under ${answerCacheRoot}`}: the full result, queryable with jq, with recovery; _meta "ye-ast/result" repeats mode, status, snapshot, recovery. Declared scope: languages ${languages.join(", ")}; frameworks ${frameworks.join(", ")}; a reply states its own only if different.

Repositories and snapshots: declared repositories (id -> root): ${roots}. repo selects one (default ${repository.repoId}); a reply states a root only for a clone neither listed nor requested; registration grants no trust or membership. Reads use HEAD unless revision (impact: head) names a commit. live reads staged/unstaged/untracked changes only in repositories the user declared trusted (repository content grants no trust); it excludes revision/head and recaptures per call. Compare head and stateId across answers. For cross-repository reads, set workspace on ye_ast_callers, ye_ast_impact or ye_ast_trace: {} uses the persisted membership, workspace.repos replaces defaults with existing local Git roots; stable IDs default to root basename and must match across clone/worktrees; declared gateways override inference, never guess them; untrusted repositories cannot supply defaults. offline skips refreshing trusted remotes; live repositories never refresh. Paths are relative to their owner's snapshot; locate clones via these roots, not cwd. Base-side line numbers come from the merge-base commit, not your working copy.

Narrowing and paging: scope globs limit coverage (exclude wins); omitted=all. Include retains manifests, exclude may remove them; outside-scope callers/entrypoints are unknown. impact changed picks the diff paths that start the walk (the seeds); unlike scope, it does not limit where consequences are found. An entirely unmatched include faults; mixed misses are reported. budget limits traversal, not response length; raise a bound only when a cut names it. Entrypoints, callers and impact page evidence the text omits: supply select and page together, page.limit required; a cursor needs the same selection and limit. Answers give the coordinates and owner each selection needs; select lists the kinds per tool. expect asserts the recovery identity; replay reruns the query and fails if the result changed and requires workspace.

Errors: isError is a fault, not an empty fact: follow its next step if given, and "fault fields:". unknown-symbol: use a listed candidate, or a snapshot path the commit holds (ye_ast_outline lists spans); top-level-line: focus inside a declaration; unknown-change-path/unknown-scope-path: correct the respective globs.`;
}

const REPLAY_GUIDE = { replay: "Copy workspace recovery recipe verbatim; requires workspace." };

const recoverySchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("available"), resultIdentity: z.string().regex(/^mcp-r1:[0-9a-f]{64}$/), query: z.strictObject({ name: z.literal("ye_ast_entrypoints"), arguments: recipeArguments }) }),
  z.strictObject({ version: z.literal(1), status: z.literal("unavailable"), reason: z.enum(["deadline", "unresolved-context", "redacted-context"]) }),
]);

const impactRecoverySchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("available"), resultIdentity: z.string().regex(/^mcp-r1:[0-9a-f]{64}$/), query: z.strictObject({ name: z.literal("ye_ast_impact"), arguments: impactRecipe }) }),
  z.strictObject({ version: z.literal(1), status: z.literal("unavailable"), reason: z.enum(["deadline", "unresolved-context", "redacted-context"]) }),
]);
const callersRecoverySchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("available"), resultIdentity: z.string().regex(/^mcp-r1:[0-9a-f]{64}$/), query: z.strictObject({ name: z.literal("ye_ast_callers"), arguments: callersRecipe }) }),
  z.strictObject({ version: z.literal(1), status: z.literal("unavailable"), reason: z.enum(["deadline", "unresolved-context", "redacted-context"]) }),
]);

const evidence = z.looseObject({ path: z.string(), line: z.int() });

const snapshot = z.discriminatedUnion("kind", [
  z.looseObject({ repo: z.string(), kind: z.literal("sha"), sha: z.string() }),
  z.looseObject({ repo: z.string(), kind: z.literal("live"), head: z.string(), stateId: z.string() }),
]);
const cut = z.looseObject({ kind: z.string(), at: z.array(z.string()), dependency: dependencyDiagnostic.optional() });
const baseFact = {
  schema: z.string(),
  snapshot,
  producer: z.looseObject({ name: z.string(), version: z.string() }),
  inputs: z.looseObject({
    trust: z.enum(TRUST_MODES),
    declaredScope: z.looseObject({ languages: z.array(z.string()), frameworks: z.array(z.string()) }),
  }),
  evidence: z.array(evidence),
  scopeSelection: z.strictObject({ unmatchedIncludes: z.array(z.string()), selectedFiles: z.int().min(0) }).optional(),
};
const workspaceLiveSnapshot = z.strictObject({ repo: z.string(), kind: z.literal("live"), head: z.string(), stateId: z.string() });
const workspaceLiveNotice = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stale"), repo: z.string(), snapshot: workspaceLiveSnapshot, notice: z.strictObject({ stateId: z.string(), changed: z.array(z.string()) }) }),
  z.strictObject({ kind: z.literal("staleness-unavailable"), repo: z.string(), snapshot: workspaceLiveSnapshot, cause: z.strictObject({ kind: z.enum(["live-requires-trusted", "unsupported-object-format", "live-mirror-failed", "unknown-revision", "git-failed", "not-repository-root", "unreadable", "object-missing", "no-merge-base", "export-write-failed", "aborted"]), detail: z.string() }) }),
]);
const sidecars = {
  workspaceLive: z.array(workspaceLiveNotice).optional(),
  repositoryRoots: z.array(z.looseObject({ repo: z.string(), path: z.string() })).optional(),
  freshness: z.array(z.looseObject({
    repo: z.string(),
    url: z.string(),
    freshness: z.looseObject({ status: z.enum(["verified", "unverified"]) }),
  })).optional(),
  resolution: z.array(z.looseObject({
    repo: z.string(),
    step: z.string(),
    consulted: z.array(z.looseObject({ branch: z.string() })),
  })).optional(),
  live: z.looseObject({ stateId: z.string(), changed: z.array(z.string()) }).optional(),
};
/** Presentation text: findings in summary/details; content repeats it before the result JSON. */
const text = z.string();
const receipt = z.discriminatedUnion("status", [
  z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("complete"), snapshot }),
  z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("partial"), snapshot }),
  z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("unknown"), snapshot, reason: z.string() }),
]);
/** A nested fact states only what differs from its answer (ADR-0109 decision 2); a missing part is the answer's. */
const nestedBase = { ...baseFact, schema: baseFact.schema.optional(), snapshot: snapshot.optional(), producer: baseFact.producer.optional(), inputs: z.looseObject({}).optional() };
const nestedFactOf = (value: z.ZodType) => z.discriminatedUnion("status", [
  z.looseObject({ ...nestedBase, status: z.literal("complete"), value }),
  z.looseObject({ ...nestedBase, status: z.literal("partial"), value, cuts: z.array(cut).min(1) }),
  z.looseObject({ ...nestedBase, status: z.literal("unknown"), reason: z.string() })
    .refine((fact) => !("value" in fact))
    .meta({ not: { required: ["value"] } }),
]);
const nestedProvenance = z.discriminatedUnion("status", [
  z.looseObject({ ...nestedBase, status: z.enum(["complete", "partial"]) }),
  z.looseObject({ ...nestedBase, status: z.literal("unknown"), reason: z.string() }),
]);
const sameAsHandler = z.strictObject({ sameAs: z.literal("handler") });
const strings = z.array(z.string());
const position = z.looseObject({ file: z.string(), symbol: z.string(), line: z.number() });
const handler = z.looseObject({ path: z.string(), symbol: z.string(), line: z.number() });
const unknownObservation = z.looseObject({ status: z.literal("unknown"), reason: z.enum(UNKNOWN_REASONS), evidence: z.array(evidence) });
const impact = z.looseObject({
  seeds: z.array(position),
  symbols: z.array(position),
  entrypoints: z.array(z.discriminatedUnion("kind", [
    z.looseObject({ kind: z.enum(["http-route", "ui-route", "listener", "job", "callback"]), handler, seeds: z.array(z.number()) }),
    z.looseObject({ kind: z.literal("unknown"), handler, seeds: z.array(z.number()), observations: z.tuple([unknownObservation]).rest(unknownObservation) }),
  ])),
  cost: z.looseObject({ expansionsUsed: z.number() }),
  modules: z.looseObject({
    origins: z.array(z.looseObject({ file: z.string(), change: z.string() })),
    modules: z.array(z.looseObject({
      file: z.string(),
      snapshot: z.string(),
      depth: z.number(),
      origins: z.array(z.number()),
    })),
    cost: z.looseObject({ expansionsUsed: z.number() }),
  }).optional(),
});
const snapshots = z.array(z.looseObject({ repo: z.string(), snapshot }));
const workspaceIdentity = z.looseObject({ repos: strings, source: z.string() });
const callTarget = z.discriminatedUnion("status", [
  z.looseObject({
    status: z.literal("complete"),
    value: z.union([
      z.looseObject({ method: z.string(), path: z.string() }),
      z.looseObject({ protocol: z.enum(["kafka", "rabbit", "jms", "event", "nats"]), destination: z.string(), role: z.literal("publish") }),
    ]),
    evidence: z.array(evidence),
  }),
  z.looseObject({ status: z.literal("unknown"), reason: z.string(), evidence: z.array(evidence) })
    .refine((target) => !("value" in target))
    .meta({ not: { required: ["value"] } }),
]);
const callSite = z.looseObject({
  repo: z.string(),
  file: z.string(),
  line: z.number(),
  symbol: z.string(),
  transport: z.enum(["http", "event"]),
  target: callTarget,
  diagnostic: callSiteDiagnostic.optional(),
});
const unresolvedCallSite = unresolvedCallSiteSchema;
const workspaceLink = z.looseObject({
  id: z.string(), from: z.looseObject({ repo: z.string(), file: z.string(), line: z.number(), column: z.number().optional(), symbol: z.string() }),
  to: z.looseObject({ repo: z.string(), kind: z.string(), name: z.string(), handler }),
  transport: z.enum(["http", "event"]), basis: z.string(), confidence: z.number(), profiles: strings.optional(),
});
const unlinkedCallSite = z.looseObject({
  from: workspaceLink.shape.from, transport: z.enum(["http", "event"]), method: z.string().optional(), outcome: z.enum(["unmatched", "ambiguous", "could-match"]), name: z.string(), repos: strings.optional(), routes: strings.optional(),
});
const workspaceImpact = z.looseObject({
  workspace: workspaceIdentity,
  repositorySnapshots: snapshots,
  trigger: z.looseObject({ repo: z.string() }),
  sections: z.record(z.string(), nestedFactOf(z.looseObject({
    reads: z.array(z.looseObject({ kind: z.string(), fact: nestedProvenance })),
    impact: impact.optional(),
    callSites: z.array(callSite),
    unmatched: z.array(callSite),
    external: z.array(callSite),
    unresolved: z.array(unresolvedCallSite),
    inherited: z.array(inheritedGapSchema).optional(),
    unrelated: z.looseObject({ unmatched: z.number(), external: z.number(), unresolved: z.number() }).optional(),
  }))),
  links: z.array(z.looseObject({
    link: z.looseObject({
      id: z.string(),
      from: z.looseObject({ repo: z.string(), file: z.string(), symbol: z.string(), line: z.number() }),
      to: z.looseObject({ repo: z.string(), name: z.string(), handler }),
    }),
    direction: z.string(),
    reach: strings,
    operations: z.array(z.looseObject({ change: z.string(), method: z.string(), path: z.string(), document: z.string(), line: z.number() })).optional(),
  })),
});
const repositoryEvidence = z.looseObject({ repo: z.string(), path: z.string(), line: z.number() });
const outwardName = z.looseObject({ name: z.string(), kind: z.string(), evidence: z.array(evidence) });
const repoOutwardName = z.looseObject({ name: z.string(), kind: z.string(), evidence: z.array(repositoryEvidence) });
const candidate = z.looseObject({ name: z.string(), repo: z.string(), basis: z.string(), evidence: z.array(repositoryEvidence) });
const decision = z.looseObject({
  id: z.string().optional(),
  kind: z.string(),
  subject: z.string(),
  evidence: z.array(repositoryEvidence),
  options: z.array(z.looseObject({ value: z.string(), evidence: z.array(repositoryEvidence), recommended: z.boolean() })),
  allowsFreeText: z.boolean(),
  required: z.boolean(),
});
const entrypoint = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.enum(["http-route", "listener", "job", "callback"]), name: z.string(), handler }),
  z.looseObject({ kind: z.literal("ui-route"), name: z.string(), component: z.union([handler, z.literal("unknown")]) }),
]);
const findingEvidence = z.union([z.array(evidence), sameAsHandler]);
const finding = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("complete"), value: entrypoint, evidence: findingEvidence }),
  z.looseObject({ status: z.literal("unknown"), reason: z.string(), evidence: z.array(evidence) })
    .refine((item) => !("value" in item))
    .meta({ not: { required: ["value"] } }),
]);
const outlineDeclaration = z.looseObject({ kind: z.string(), name: z.string(), line: z.number(), endLine: z.number(), placement: z.strictObject({ kind: z.literal("unplaced"), reason: z.literal("unresolved-container"), at: z.strictObject({ line: z.number(), column: z.number() }) }).optional() });
const moduleTarget = z.union([
  z.looseObject({ kind: z.literal("repository"), file: z.string() }),
  z.looseObject({ kind: z.literal("external"), module: z.string() }),
  z.looseObject({ kind: z.literal("unresolved"), reason: z.string() }),
]);
const outlineImport = z.looseObject({
  line: z.number(),
  endLine: z.number(),
  specifier: z.string().optional(),
  kind: z.enum(["import", "reexport"]),
  typeOnly: z.boolean(),
  target: moduleTarget,
  bindings: z.array(z.looseObject({ imported: z.string(), declaration: outlineDeclaration.extend({ file: z.string() }).optional() })),
});
const consequenceFinding = z.looseObject({ status: z.enum(["complete", "unknown"]), evidence: z.array(repositoryEvidence) });
const shapes = {
  entrypoints: z.looseObject({ entrypoints: nestedFactOf(z.array(finding)) }),
  impact: z.union([impact, workspaceImpact]),
  importers: z.looseObject({
    files: z.array(z.looseObject({ file: z.string(), importers: strings, users: strings, unresolvedNamers: strings, places: z.array(z.looseObject({ file: z.string(), line: z.number() })).optional() })),
  }),
  outline: z.union([
    z.looseObject({
      files: z.array(z.looseObject({
        file: z.string(),
        declarations: z.array(outlineDeclaration),
        imports: z.array(outlineImport),
      })),
      unheld: strings,
    }),
    z.looseObject({
      focus: z.array(z.looseObject({ file: z.string(), selector: z.string(), path: z.string().optional(), ancestors: z.array(outlineDeclaration), declaration: outlineDeclaration, omitted: z.number(), uses: z.array(z.looseObject({ relations: strings, at: z.array(z.looseObject({ line: z.number() })) })).optional() })),
      unheld: strings,
    }),
  ]),
  trace: z.looseObject({
    repositorySnapshots: snapshots.optional(), links: z.array(workspaceLink).optional(), unlinked: z.array(unlinkedCallSite).optional(),
    roots: z.array(z.looseObject({ target: z.string(), steps: z.array(z.number()) })),
    steps: z.array(z.looseObject({ id: z.number(), depth: z.number(), file: z.string(), symbol: z.string(), kind: z.string(), line: z.number(), unresolvedEffects: z.array(unresolvedCallSite).optional() })),
    readingPlan: z.looseObject({ ranges: z.array(z.looseObject({ file: z.string(), start: z.number(), end: z.number(), steps: z.array(z.number()) })), lines: z.number() }),
  }),
  workspace: z.looseObject({
    links: z.array(workspaceLink), internalLinks: z.array(workspaceLink), unlinked: z.array(unlinkedCallSite),
    workspace: workspaceIdentity,
    repositorySnapshots: snapshots,
    sections: z.record(z.string(), nestedFactOf(z.looseObject({
      names: z.array(outwardName),
      unresolved: z.array(unresolvedCallSite),
    inherited: z.array(inheritedGapSchema).optional(),
    }))),
    candidates: z.array(candidate),
    unserved: z.array(repoOutwardName),
  }),
  decisions: z.looseObject({ decisions: z.array(decision), repositories: snapshots, source: z.string() }),
  contract_consequences: z.looseObject({
    repositorySnapshots: snapshots,
    answers: z.array(z.looseObject({
      hypothesis: z.looseObject({ method: z.string(), path: z.string(), target: z.string(), property: z.string() }),
      status: z.enum(["complete", "partial", "unknown"]),
      findings: z.array(z.union([consequenceFinding, z.strictObject({ sharedFinding: z.int().min(0) })])).optional(),
    })),
    sharedFindings: z.array(consequenceFinding).optional(),
    change: z.looseObject({
      base: z.string(),
      head: z.string(),
      snapshots: z.looseObject({ base: z.string(), head: z.string() }),
      derivation: nestedFactOf(z.looseObject({
        differences: z.array(z.looseObject({ rule: z.string(), level: z.enum(["breaking", "review", "compatible"]), target: z.string(), operation: z.string(), delta: z.string(), places: z.looseObject({ base: repositoryEvidence.optional(), head: repositoryEvidence.optional() }) })),
        frontiers: z.array(z.looseObject({ kind: z.string(), reason: z.string(), evidence: z.array(repositoryEvidence) })),
      })),
    }).optional(),
  }),
};
/** Validate the envelope and public containers used by navigation; domain unions remain owned by the core. */
function outputFor(value: z.ZodType, recovery?: z.ZodType) {
  const extra = recovery ? { recovery } : {};
  const textReceipt = recovery ? z.discriminatedUnion("status", [
    z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("complete"), snapshot, recovery }),
    z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("partial"), snapshot, recovery }),
    z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("unknown"), snapshot, reason: z.string(), recovery }),
  ]) : receipt;
  const full = z.discriminatedUnion("status", [
    z.looseObject({ ...baseFact, ...sidecars, ...extra, text, mode: z.literal("full"), status: z.literal("complete"), value }),
    z.looseObject({ ...baseFact, ...sidecars, ...extra, text, mode: z.literal("full"), status: z.literal("partial"), value, cuts: z.array(cut).min(1) }),
    z.looseObject({ ...baseFact, ...sidecars, ...extra, text, mode: z.literal("full"), status: z.literal("unknown"), reason: z.string() })
      .refine((fact) => !("value" in fact))
      .meta({ not: { required: ["value"] } }),
  ]);
  const branches = z.union([textReceipt, full]);
  const json = z.toJSONSchema(branches, { target: "draft-7" });
  return z.looseObject({}).refine((result) => branches.safeParse(result).success).meta({ anyOf: json.anyOf });
}
function withSelections(original: z.ZodType, tool: "entrypoints" | "impact" | "callers", recovery: z.ZodType) {
  const selected = selectedOutputFor(tool, { recovery, baseFact });
  const union = z.union([original, selected]);
  const ordinaryJson = z.toJSONSchema(original, { target: "draft-7" });
  const selectedJson = z.toJSONSchema(selected, { target: "draft-7" });
  return z.looseObject({}).refine((value) => union.safeParse(value).success).meta({ anyOf: [ordinaryJson, selectedJson] });
}
export const ENTRYPOINTS_OUTPUT = withSelections(outputFor(shapes.entrypoints, recoverySchema), "entrypoints", recoverySchema);
export const IMPACT_OUTPUT = withSelections(outputFor(shapes.impact, impactRecoverySchema), "impact", impactRecoverySchema);
export const CALLERS_OUTPUT = withSelections(outputFor(shapes.impact, callersRecoverySchema), "callers", callersRecoverySchema);
export const IMPORTERS_OUTPUT = outputFor(shapes.importers);
export const OUTLINE_OUTPUT = outputFor(shapes.outline);
export const TRACE_OUTPUT = outputFor(shapes.trace);
export const WORKSPACE_OUTPUT = outputFor(shapes.workspace);
export const DECISIONS_OUTPUT = outputFor(shapes.decisions);
export const CONTRACT_CONSEQUENCES_OUTPUT = outputFor(shapes.contract_consequences);
const OUTPUTS: Readonly<Record<QueryFamily, z.ZodType>> = { entrypoints: ENTRYPOINTS_OUTPUT, impact: IMPACT_OUTPUT, callers: CALLERS_OUTPUT, importers: IMPORTERS_OUTPUT, outline: OUTLINE_OUTPUT, trace: TRACE_OUTPUT, workspace: WORKSPACE_OUTPUT, decisions: DECISIONS_OUTPUT, contract_consequences: CONTRACT_CONSEQUENCES_OUTPUT };

type Refusal = (fault: CodedFault) => CallToolResult;
type Controls = { tool: "entrypoints" | "impact" | "callers"; select?: EvidenceSelection | undefined; page?: { limit: number; cursor?: string | undefined } | undefined; expect?: string | undefined; answerBytes?: number | undefined };

/** The semantic query an original tool's arguments ask for: its own fields without presentation or recovery controls. */
function semanticOf<A extends { mode: ResponseMode; select?: unknown; page?: unknown; expect?: unknown; answerBytes?: unknown }>(args: A): Omit<A, "mode" | "select" | "page" | "expect" | "answerBytes"> {
  const { mode: _mode, select: _select, page: _page, expect: _expect, answerBytes: _answerBytes, ...semantic } = args;
  return semantic;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const { redaction } = deps;
  const catalog = repositoryCatalog(deps.repository, deps.repositories);
  if (!catalog.valid) throw new Error("Invalid repository catalog");
  const declared = [deps.repository, ...(deps.repositories ?? [])].filter((binding, at, all) => all.findIndex((other) => other.repoId === binding.repoId) === at);
  const server = new McpServer({ name: "ye-ast", version: deps.version }, { instructions: redaction.redact(instructionsFor(deps.repository, declared, deps.answerCacheRoot)) });

  /**
   * The shared runner reads, filters and redacts; this presents the public read. Summary and details carry a minimal
   * receipt and convey response-level limits in their text; the full fact, with its response siblings, is `answer.json`
   * of the answer folder. Every success is validated before delivery in content.
   */
  async function answer(query: SemanticQuery, mode: ResponseMode, signal: AbortSignal, controls?: Controls, requestedBytes?: number): Promise<CallToolResult> {
    const context = faultContext(query, controls);
    const limit = requestedBytes ?? controls?.answerBytes ?? deps.answerBytes;
    const boundedFailure = (result: CallToolResult): CallToolResult => {
      if (limit === undefined) return result;
      const size = result.content.reduce((total, part) => total + (part.type === "text" ? Buffer.byteLength(part.text) : 0), 0);
      return size <= limit ? result : { ...result, content: [] };
    };
    const selectionFailure = (fault: CodedFault): CallToolResult => boundedFailure(failure(controlFault(fault), context));
    if ((requestedBytes ?? controls?.answerBytes) === 0) return failure(controlFault({ code: "invalid-answer-bytes" }), context);
    try {
      if (controls?.select !== undefined && canonicalJson(redaction.redactValue(controls.select)) !== canonicalJson(controls.select)) {
        return selectionFailure({ code: "replay-unavailable", reason: "redacted-context" });
      }
      let cursor: CursorV1 | undefined;
      if (controls?.page?.cursor !== undefined && controls.select !== undefined) {
        const decoded = decodeCursor(controls.page.cursor);
        if (!decoded.ok) return selectionFailure(decoded.fault);
        const checked = validateCursorRequest(decoded.value, controls.select, controls.page.limit, controls.expect, deps.digest);
        if (!checked.ok) return selectionFailure(checked.fault);
        cursor = checked.value;
      }
      const executed = await executeQuery(query, { deps, catalog, signal });
      if (!executed.ok) return boundedFailure(failure(executed.fault, context));
      return await present(executed.value, mode, controls, cursor, selectionFailure, limit);
    } catch (error) {
      return boundedFailure(failure({ kind: "internal-fault", detail: redaction.redactError(error) }, context));
    }
  }

  /** The renderer and selection source of each public payload; the dispatch itself lives in the runner. */
  function present(source: ExecutedSource, mode: ResponseMode, controls: Controls | undefined, cursor: CursorV1 | undefined, selectionFailure: Refusal, answerBytes: number | undefined): Promise<CallToolResult> {
    switch (source.family) {
      case "entrypoints":
        return respond(source, source.read, renderEntrypointMap, mode, controls, cursor, selectionFailure, answerBytes, (fact) => ({ kind: "entrypoints", fact }));
      case "impact":
      case "callers":
        return source.branch === "local"
          ? respond(source, source.read, renderImpact, mode, controls, cursor, selectionFailure, answerBytes, (fact) => ({ kind: "local", fact }))
          : respond(source, withKeyedValue(source.read, keyWorkspaceImpactLinks), renderWorkspaceImpact, mode, controls, cursor, selectionFailure, answerBytes, (fact) => ({ kind: "workspace", fact }));
      case "importers":
        return respond(source, source.read, renderImporters, mode, controls, cursor, selectionFailure, answerBytes);
      case "outline":
        return respond(source, source.read, renderOutline, mode, controls, cursor, selectionFailure, answerBytes);
      case "trace":
        return respond(source, withKeyedValue(source.read, keyTraceLinks), renderTrace, mode, controls, cursor, selectionFailure, answerBytes);
      case "workspace":
        return respond(source, withKeyedValue(source.read, keyWorkspaceLinks), renderWorkspace, mode, controls, cursor, selectionFailure, answerBytes);
      case "decisions":
        return respond(source, source.read, renderDecisions, mode, controls, cursor, selectionFailure, answerBytes);
      case "contract_consequences":
        return respond(source, source.read, renderContractConsequences, mode, controls, cursor, selectionFailure, answerBytes);
    }
  }

  async function respond<V>(
    source: ExecutedSource,
    read: PublicRead<V>,
    render: ResponseRenderer<V>,
    mode: ResponseMode,
    controls: Controls | undefined,
    cursor: CursorV1 | undefined,
    selectionFailure: Refusal,
    answerBytes: number | undefined,
    sourceFor?: (fact: Fact<V>) => EvidenceSource,
  ): Promise<CallToolResult> {
    const { fact, repositoryRoots, refresh, workspaceLive } = read;
    const { recovery, live: stale } = source;
    const tool: QueryFamily = source.family;
    const renderContext = { tool, ...(recovery === undefined ? {} : { recovery }) };
    const expected = cursor?.resultIdentity ?? controls?.expect;
    if (expected !== undefined && recovery !== undefined) {
      const verified = assertSourceIdentity(recovery, expected);
      if (!verified.ok) return selectionFailure(verified.fault);
    }
    const meta = { ...(stale === undefined ? {} : { [LIVE_META]: stale }), ...(workspaceLive === undefined ? {} : { [WORKSPACE_LIVE_META]: workspaceLive }) };
    const sidecar = [
      ...(stale === undefined ? [] : [renderStale(stale)]),
      ...(workspaceLive === undefined ? [] : workspaceLive.map((item) => `workspace live: ${JSON.stringify(item)}`)),
      ...(refresh === undefined ? [] : renderRefresh(refresh)),
    ];
    const roots = unnamedRootLines(repositoryRoots, declared, source.query);
    const emit = (text: string, fields: Record<string, unknown>, summary: () => string, siblings: Record<string, unknown> = meta): CallToolResult => {
      OUTPUTS[tool].parse({ text, ...fields });
      if (answerBytes === undefined) return delivered(text, fields, siblings);
      const bounded = boundedText((_fact, candidate) => candidate === mode ? text : summary(), fact, mode, renderContext, { bytes: answerBytes });
      if (bounded.kind === "refused") return boundRefusal(bounded, siblings);
      return delivered(bounded.text, fields, siblings);
    };
    if (controls?.select !== undefined && controls.page !== undefined && recovery !== undefined && sourceFor !== undefined) {
      if (recovery.status === "unavailable" && recovery.reason === "deadline") return selectionFailure({ code: "replay-unavailable", reason: recovery.reason });
      const selected = selectEvidence(sourceFor(fact), controls.select);
      if (!selected.ok) return recovery.status === "unavailable"
        ? selectionFailure({ code: "replay-unavailable", reason: recovery.reason })
        : selectionFailure(selected.fault);
      let records: EvidenceSelectionResult = selected.value;
      if (cursor !== undefined && records.availability === "unavailable") return selectionFailure({ code: "invalid-cursor" });
      let page: EvidencePage | undefined;
      if (records.availability === "available") {
        if (recovery.status === "unavailable") return selectionFailure({ code: "replay-unavailable", reason: recovery.reason });
        const total = records.items.length;
        let offset = 0;
        if (cursor !== undefined) {
          const position = validateCursorPosition(cursor, total);
          if (!position.ok) return selectionFailure(position.fault);
          offset = position.value;
        }
        const end = Math.min(total, offset + controls.page.limit);
        let nextCursor: string | undefined;
        if (end < total) {
          const encoded = encodeCursor({ version: 1, resultIdentity: recovery.resultIdentity, selection: selectionDigest(controls.select, deps.digest), limit: controls.page.limit, next: end });
          if (!encoded.ok) return selectionFailure(encoded.fault);
          nextCursor = encoded.value;
        }
        switch (records.kind) {
          case "handler-origins": records = { ...records, items: records.items.slice(offset, end) }; break;
          case "module-origins": records = { ...records, items: records.items.slice(offset, end) }; break;
          case "entrypoint-evidence": records = { ...records, items: records.items.slice(offset, end) }; break;
          case "cut-places": records = { ...records, items: records.items.slice(offset, end) }; break;
          case "workspace-link-evidence": records = { ...records, items: records.items.slice(offset, end) }; break;
        }
        page = { limit: controls.page.limit, offset, returned: end - offset, total, ...(nextCursor === undefined ? {} : { nextCursor }) };
      }
      const projected = records.source;
      const shared = { projectionSchema: 1, source: projected, select: controls.select, recovery };
      const fields = records.availability === "available"
        ? { ...shared, kind: "projection-receipt", availability: "available", page }
        : { ...shared, kind: "projection-receipt", availability: "unavailable", reason: records.reason };
      const selectedText = envelopeText({
        lead: [...renderFactStatus(fact), snapshotLine(fact.snapshot), ...sidecar],
        body: renderEvidenceSelection({ select: controls.select, records, ...(page === undefined ? {} : { page }) }),
        roots,
        closing: withheld(WITHHELD.selectedProjection).line,
      });
      return emit(selectedText, fields, () => selectedText);
    }
    const buildFull = () => {
      const location = "full result: the result JSON";
      const projection = projectFull(tool, {
        ...fact,
        mode: "full",
        ...(recovery === undefined ? {} : { recovery }),
        ...(repositoryRoots === undefined ? {} : { repositoryRoots }),
        ...(refresh === undefined ? {} : { freshness: refresh.freshness, resolution: refresh.resolution }),
        ...(stale === undefined ? {} : { live: stale }),
        ...(workspaceLive === undefined ? {} : { workspaceLive }),
      });
      const guidance = [
        ...projection.guidance,
        ...(repositoryRoots === undefined ? [] : ["Repository locations: repositoryRoots[].path is the clone of repositoryRoots[].repo; evidence paths are relative to its snapshot."]),
        ...(refresh === undefined ? [] : ["Remote context: inspect freshness and resolution for the repositories used; pinned revisions do not imply verified freshness."]),
        ...(stale === undefined ? [] : ["Live context: inspect live.stateId and live.changed before comparing this result with the current working tree."]),
        ...(workspaceLive === undefined ? [] : ["Workspace live context: inspect workspaceLive for captured snapshots and stale or unavailable checks. Captures are not an atomic workspace instant."]),
      ];
      return {
        fields: projection.fields,
        text: [`status: ${fact.status}\n${location}`, render(fact, "full", renderContext), ...guidance].filter((part) => part !== "").join("\n"),
      };
    };
    const plainText = (detail: "summary" | "details"): string => [...sidecar, render(fact, detail, renderContext), ...roots].join("\n");
    const keepFiles = async (): Promise<Delivery> => {
      if (deps.answerFiles === undefined) return withheld(WITHHELD.noCacheDirectory);
      const unwritten = unwrittenReason(fact);
      if (unwritten !== undefined) return withheld(unwritten);
      const { text, fields } = buildFull();
      if (!OUTPUTS[tool].safeParse({ text, ...fields }).success) return withheld(WITHHELD.notValid);
      const folder = await keepAnswer(deps.answerFiles, tool, answerInputs(source.query, fact), { guide: text, fields, summary: plainText("summary"), details: plainText("details") });
      return folder === null ? withheld(WITHHELD.notWritten) : { folder, line: redaction.redact(answerPointer(folder)) };
    };
    const kept = await keepFiles();
    const siblings = kept.folder === undefined ? meta : { ...meta, [ANSWER_FILES_META]: kept.folder };
    const closed = (detail: ResponseMode): string => `${plainText(detail)}\n${kept.line}`;
    return emit(
      closed(mode),
      {
        mode,
        status: fact.status,
        snapshot: fact.snapshot,
        ...(recovery === undefined ? {} : { recovery }),
        ...(fact.status === "unknown" ? { reason: fact.reason } : {}),
      },
      () => closed("summary"),
      siblings,
    );
  }

  /**
   * A fault is an `isError` result: the text names its kind on the first line, and `_meta` carries the same shape for a
   * client that branches on it. `context` names the faulted query's arguments, for a composition source the query it
   * failed in.
   */
  function failure(fault: PublicFault, context?: FaultQueryContext): CallToolResult {
    // Capture diagnostics can contain host paths. Repository IDs remain opaque, even when they contain separators.
    const safeCaptureText = (text: string): string => /[\\/]/.test(text) ? "[path omitted]" : text;
    const publicFault = fault.kind === "workspace-capture-unavailable" && "cause" in fault
      ? { ...fault, detail: safeCaptureText(fault.detail), cause: { ...fault.cause, detail: safeCaptureText(fault.cause.detail) } }
      : fault.kind === "composition-source-fault" && "cause" in fault && fault.cause.kind === "workspace-capture-unavailable"
        ? { ...fault, cause: { ...fault.cause, detail: safeCaptureText(fault.cause.detail), cause: { ...fault.cause.cause, detail: safeCaptureText(fault.cause.cause.detail) } } }
      : fault;
    const published = redaction.redactValue(publicFault) as Record<string, unknown>;
    const { kind: _kind, detail: _detail, entries: _entries, ...fields } = published;
    const fieldLine = Object.keys(fields).length === 0 ? "" : `\n${FAULT_FIELDS_LABEL}${JSON.stringify(fields)}`;
    return {
      isError: true,
      content: [{ type: "text", text: `${redaction.redact(renderFault(publicFault, context))}${fieldLine}` }],
      _meta: { [FAULT_META]: published },
    };
  }

  /** The context of the query a composition source fault names; every index of one query key holds the same query. */
  function sourceContext(queries: readonly ComposeQuery[], fault: PublicFault): FaultQueryContext | undefined {
    if (fault.kind !== "composition-source-fault") return undefined;
    const query = queries[fault.requestIndices[0] ?? -1];
    if (query === undefined) return undefined;
    const { expect, ...semantic } = query;
    return faultContext(semantic, { expect });
  }

  const annotations = { readOnlyHint: true, openWorldHint: false };
  const output = composeOutput(deps.evidenceComposition);

  /** The composition's own answer folder: keyed by its identity and delivery sidecars, never written without an identity (ADR-0113 decision 6). */
  async function keepComposition(result: CompositionResult): Promise<Delivery> {
    if (deps.answerFiles === undefined) return withheld(WITHHELD.noCacheDirectory);
    const { verification } = result;
    if (verification.status === "unavailable") return withheld(`the composition has no identity (${verification.reason})`);
    const full = composeFull(result);
    if (!output.safeParse(full).success) return withheld(WITHHELD.notValid);
    const folder = await keepAnswer(deps.answerFiles, "compose", { identity: verification.identity, ...(result.delivery === undefined ? {} : { delivery: result.delivery }) }, { guide: renderComposition(result, "full"), fields: full, summary: renderComposition(result, "summary"), details: renderComposition(result, "details") });
    return folder === null ? withheld(WITHHELD.notWritten) : { folder, line: redaction.redact(answerPointer(folder)) };
  }

  server.registerTool("ye_ast_compose", {
    title: "Compose evidence from related queries",
    description: "Run 1..16 queries sequentially, merging shared identities with coverage/trust/snapshot checks. arguments uses the named tool schema without mode/select/page. Queries rerun; nothing stored. Dependencies do not prove breakage. Limit: 1 MiB canonical JSON.",
    inputSchema: compactInput(COMPOSE_INPUT, { arguments: "Arguments of the tool named in name; no mode/select/page." }),
    annotations,
  }, async (input, ctx) => {
    try {
      const result = await runComposition(input, { deps, catalog, signal: ctx.mcpReq.signal });
      if (!result.ok) return failure(result.fault, sourceContext(input.queries, result.fault));
      const fields = composeReceipt(result.value, input.mode);
      output.parse(fields);
      const kept = await keepComposition(result.value);
      const siblings = kept.folder === undefined ? {} : { [ANSWER_FILES_META]: kept.folder };
      const closed = (mode: ResponseMode): string => `${renderComposition(result.value, mode)}\n${kept.line}`;
      if (deps.answerBytes === undefined) return delivered(closed(input.mode), fields, siblings);
      const bounded = boundedProjection(closed, input.mode, "per-source", ["queries", "scope", "focus", "mode: summary"], { bytes: deps.answerBytes });
      return bounded.kind === "refused" ? boundRefusal(bounded, siblings) : delivered(bounded.text, fields, siblings);
    } catch (error) {
      return failure({ kind: "internal-fault", detail: redaction.redactError(error) });
    }
  });

  server.registerTool(
    "ye_ast_entrypoints",
    {
      title: "Entrypoints of a revision",
      description: "Entrypoints with handler locations: HTTP/UI routes, listeners, jobs and callbacks. A route reference the sources do not resolve is listed as unknown and as a cut. For dependents use callers; for diffs use impact.",
      inputSchema: compactInput(TOOL_INPUTS.entrypoints),
      annotations,
    },
    (args: ToolArguments<"entrypoints">, ctx) =>
      answer({ name: "ye_ast_entrypoints", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "entrypoints", select: args.select, page: args.page, expect: args.expect, answerBytes: args.answerBytes }),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: "Diff from merge-base(base, head): changed declarations, incoming dependents (no JVM/TypeScript test files; importers lists them), reached and added/removed/altered entrypoints. base required; head=HEAD, or trusted live. workspace adds incoming/outgoing links. For unchanged symbols use callers.",
      inputSchema: compactInput(TOOL_INPUTS.impact, REPLAY_GUIDE),
      annotations,
    },
    (args: ToolArguments<"impact">, ctx) =>
      answer({ name: "ye_ast_impact", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "impact", select: args.select, page: args.page, expect: args.expect, answerBytes: args.answerBytes }),
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: "Incoming dependents (no JVM/TypeScript test files; importers lists them) and reaching entrypoints with locations. Targets are names (all matching declarations) or inclusive ranges; unknown name is an error. workspace adds incoming cross-repo calls. For diffs use impact.",
      inputSchema: compactInput(TOOL_INPUTS.callers, REPLAY_GUIDE),
      annotations,
    },
    (args: ToolArguments<"callers">, ctx) =>
      answer({ name: "ye_ast_callers", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "callers", select: args.select, page: args.page, expect: args.expect, answerBytes: args.answerBytes }),
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: "Static/reexport/dynamic/type importers, users and unresolved names. Details: paths once, categories/positions and recorded relationship lines; a path without a place has no recorded line. Uncategorized users are additional. Imports do not prove declaration use; unresolved names prove neither dependency nor impact. TS: aliases/barrels and exported test consumers; omitted live tests=partial. For declarations use callers.",
      inputSchema: compactInput(TOOL_INPUTS.importers),
      annotations,
    },
    ({ mode, answerBytes, ...semantic }: ToolArguments<"importers">, ctx) => answer({ name: "ye_ast_importers", arguments: semantic }, mode, ctx.mcpReq.signal, undefined, answerBytes),
  );

  server.registerTool(
    "ye_ast_outline",
    {
      title: "Shape of files",
      description: "Indexed declarations/imports without source. Imports: repository/package/unresolved target, bindings and proven declarations. Members nest by contains. files lists files; focus selects dotted suffix path (bare name at any depth) or innermost declaration at line, returning containers/subtree/omitted count and out-of-body uses (file:line/package/global, else cut), without imports. Reuse paths in callers; compose combines reads. Unavailable files=cut. Match revision/live.",
      inputSchema: compactInput(TOOL_INPUTS.outline),
      annotations,
    },
    ({ mode, answerBytes, ...semantic }: ToolArguments<"outline">, ctx) => answer({ name: "ye_ast_outline", arguments: semantic }, mode, ctx.mcpReq.signal, undefined, answerBytes),
  );

  server.registerTool(
    "ye_ast_trace",
    {
      title: "What declarations execute",
      description: "Forward calls in source order from declarations/ranges or entrypoints. Each declaration expands once; repeats=seen; branches unevaluated. Terminal callees fold into leaves; externals group by module. HTTP/message calls with proven targets and data operations=effects, undecided targets=cut; unsettled calls list candidates. Reading plan merges spans per file. workspace reads declared library sources; runtime URL policies stay cuts. For incoming dependents use callers.",
      inputSchema: compactInput(TOOL_INPUTS.trace),
      annotations,
    },
    ({ mode, answerBytes, ...semantic }: ToolArguments<"trace">, ctx) => answer({ name: "ye_ast_trace", arguments: semantic }, mode, ctx.mcpReq.signal, undefined, answerBytes),
  );

  server.registerTool(
    "ye_ast_workspace",
    {
      title: "Repositories a workspace names",
      description: "Outward names (HTTP hosts/prefixes, config URLs, message destinations, dependencies, remotes, registries), candidate repos with evidence, unserved names, links to routes/listeners and unmatched/ambiguous calls. Helps select workspace clones. Never downloads or guesses. Trusted persisted remotes refresh unless offline.",
      inputSchema: compactInput(TOOL_INPUTS.workspace),
      annotations,
    },
    ({ mode, answerBytes, ...semantic }: ToolArguments<"workspace">, ctx) => answer({ name: "ye_ast_workspace", arguments: semantic }, mode, ctx.mcpReq.signal, undefined, answerBytes),
  );

  server.registerTool(
    "ye_ast_decisions",
    {
      title: "Gaps a workspace leaves to the user",
      description: "Read-only workspace configuration gaps (membership/identity/gateways/trust/remotes), evidenced options and rule recommendations; may need free text. Not code quality or approval.",
      inputSchema: compactInput(TOOL_INPUTS.decisions),
      annotations,
    },
    ({ mode, answerBytes, ...semantic }: ToolArguments<"decisions">, ctx) => answer({ name: "ye_ast_decisions", arguments: semantic }, mode, ctx.mcpReq.signal, undefined, answerBytes),
  );

  server.registerTool(
    "ye_ast_contract_consequences",
    {
      title: "Consequences of a contract change",
      description: "Consumers and request producers an HTTP request/response contract change affects, each with a verdict and code evidence; lost flow=unknown. Subject: hypotheses (path as the served route spells it) or base/head diff. workspace reads other clones. For non-contract code changes use impact.",
      inputSchema: compactInput(TOOL_INPUTS.contract_consequences),
      annotations,
    },
    ({ mode, answerBytes, ...semantic }: ToolArguments<"contract_consequences">, ctx) => answer({ name: "ye_ast_contract_consequences", arguments: semantic }, mode, ctx.mcpReq.signal, undefined, answerBytes),
  );

  return server;
}
