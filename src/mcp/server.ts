import { dependencyDiagnostic } from "./dependency-schema.ts";
import { callSiteDiagnostic, unresolvedCallSiteSchema } from "./composition-schema-parts.ts";
import { compactInput } from "./compact-schema.ts";
import { selectedOutputFor } from "./evidence-schema.ts";
import { selectEvidence, type EvidenceSelection, type EvidenceSource, type EvidenceSelectionResult } from "./select-evidence.ts";
import { decodeCursor, validateCursorRequest, validateCursorPosition, assertSourceIdentity, encodeCursor, selectionDigest, type CursorV1 } from "./evidence-cursor.ts";
import { renderEvidenceSelection, type EvidencePage } from "./render-evidence.ts";
import { recoveryReference } from "./presentation-guidance.ts";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { repositoryCatalog, type RepositoryBinding } from "./repository-targeting.ts";
import type { ResponseMode, ResponseRenderer, ToolFamily } from "./presentation.ts";
import { TRUST_MODES } from "../core/domain/shared/fact.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import { TOOL_INPUTS, callersRecipe, impactRecipe, recipeArguments, type ComposeQuery, type ToolArguments, type ToolQuery } from "./query-schema.ts";
import { executeQuery, type ConsequencesExecutionDeps, type PresentedSource, type PublicRead } from "./query-runner.ts";
import { COMPOSE_INPUT, COMPOSE_OUTPUT } from "./composition-schema.ts";
import { runComposition } from "./compose-request.ts";
import { composeFull, composeReceipt, renderComposition } from "./render-composition.ts";
import { controlFault, faultContext, renderFault, type CodedFault, type FaultQueryContext, type PublicFault } from "./fault-presentation.ts";
import { renderContractConsequences, renderDecisions, renderEntrypointMap, renderImpact, renderImporters, renderOutline, renderRefresh, renderTrace, renderStale, renderWorkspace, renderWorkspaceImpact } from "./render.ts";

/** The key of the result's `_meta` that carries a stale notice. */
const LIVE_META = "ye-ast/live";
export const WORKSPACE_LIVE_META = "ye-ast/workspace-live";
/** The key of the result's `_meta` that carries the fault of an `isError` answer, beside the text that names its kind first. */
export const FAULT_META = "ye-ast/fault";
/** Opens the last line of a successful text block: the JSON of every structured field except `text`. */
export const RESULT_JSON_LABEL = "result JSON: ";
/** Opens the line of a fault's text that carries its fields beyond kind, detail and entries. */
const FAULT_FIELDS_LABEL = "fault fields: ";

/** Presentation and result fields are delivered once in the text content. */
function delivered(text: string, fields: Record<string, unknown>, meta: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: `${text}\n${RESULT_JSON_LABEL}${JSON.stringify(fields)}` }],
    ...(Object.keys(meta).length ? { _meta: meta } : {}),
  };
}

export interface McpDeps extends ConsequencesExecutionDeps {
  version: string;
  /** Default repository binding, plus additional host-declared targets. */
  repository: RepositoryBinding;
  repositories?: readonly RepositoryBinding[];
}

/** Common interpretation rules and a short routing guide, also useful before individual tools are loaded. */
export function instructionsFor(repository: McpDeps["repository"], available: readonly string[] = [repository.repoId]): string {
  return `ye-ast: deterministic, read-only facts about code, Git and declared contracts of ${repository.path} (id ${repository.repoId}). Prefer it to text search for dependency and reach questions. No quality judgment or change approval. Same question and snapshot, same answer: reuse results.

When to call:
- ye_ast_entrypoints: orient, or find the handler of a route, listener or job.
- ye_ast_callers: before changing, renaming or deleting a declaration (name or line range): its dependents and reaching entrypoints.
- ye_ast_impact: review a diff (base..head, or trusted live edits): what changed declarations reach; entrypoints added, removed or altered.
- ye_ast_importers: before moving, renaming or deleting a file or changing its exports: who imports or names it.
- ye_ast_outline: declaration spans and imports, to choose line ranges to read or target; focus on one declaration by dotted path or line after the first listing.
- ye_ast_trace: what a declaration executes, in source order, with a reading plan of the spans to open; call it before reading a flow file by file.
- ye_ast_workspace: which other repositories this one names (HTTP, messaging, dependencies), to choose clones.
- ye_ast_decisions: workspace configuration gaps with evidence-backed options; it writes nothing.
- ye_ast_contract_consequences: before changing a response or request contract, or to see what a diff of contracts breaks.
- ye_ast_compose: 1..16 of these queries in one call, merging shared entities. Queries rerun; nothing is stored and captures are not atomic, so obtain dependent coordinates first.

Reading answers: complete is relative to the declared scope, supported constructs and change selection; partial keeps known findings and lists cuts (where coverage stopped; per-repository sections and file reads can have their own limits); unknown never means no impact. TypeScript tests are not indexed; template bindings are not resolved. References need not be calls or edits; confidence measures resolution, not safety; entrypoint origins are associations, not complete call chains. Content carries presentation text (summary and details findings, full navigation), then a "result JSON:" line with the result fields. Recovery is the recovery field.

Repositories and snapshots: declared repository IDs: ${available.join(", ")}. repo selects one (default ${repository.repoId}); registration grants no trust or membership. Reads use HEAD unless revision (impact: head) names a commit. live reads staged, unstaged and untracked changes of a repository the user declared trusted (repository content cannot grant trust), excludes revision/head and recaptures per call; head and stateId identify the captured working-tree state, so compare them between answers. For cross-repository links, set workspace on ye_ast_callers or ye_ast_impact: {} uses the persisted membership, workspace.repos supplies local clones (never downloaded); untrusted repositories cannot supply defaults. offline skips refreshing trusted remotes; live repositories never refresh. Paths are relative to their owner's snapshot; locate clones via repositoryRoots, not cwd. Base-side line numbers come from the merge-base commit, so they may not match your working copy.

Narrowing and paging: scope globs limit coverage (exclude wins). impact changed picks the diff paths that start the walk (the seeds); unlike scope, it does not limit where consequences are found. Unmatched globs are errors. budget limits traversal, not response length; raise a bound only when a cut names it. Entrypoints, callers and impact page evidence the text omits: supply select and page together, page.limit required; a cursor needs the same selection and limit. Answers give the coordinates and owner each selection needs; select lists the kinds per tool. expect asserts the recovery identity; replay reruns the query and fails if the result changed (no old capture is kept) and requires workspace.

Errors: isError is a fault, not an empty fact: follow its next step if given, and "fault fields:". unknown-symbol: use a listed candidate path or a line range (ye_ast_outline lists them); top-level-line: focus on a line inside a declaration; unknown-change-path: correct the changed globs.`;
}

const REPLAY_GUIDE = { replay: "Copy verbatim from the recovery recipe of a previous workspace answer; requires workspace." };

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
/** Presentation text: findings in summary/details, navigation in full; content repeats it before the result JSON. */
const text = z.string();
const receipt = z.discriminatedUnion("status", [
  z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("complete"), snapshot }),
  z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("partial"), snapshot }),
  z.strictObject({ text, mode: z.enum(["summary", "details"]), status: z.literal("unknown"), snapshot, reason: z.string() }),
]);
const factOf = (value: z.ZodType) => z.discriminatedUnion("status", [
  z.looseObject({ ...baseFact, status: z.literal("complete"), value }),
  z.looseObject({ ...baseFact, status: z.literal("partial"), value, cuts: z.array(cut).min(1) }),
  z.looseObject({ ...baseFact, status: z.literal("unknown"), reason: z.string() })
    .refine((fact) => !("value" in fact))
    .meta({ not: { required: ["value"] } }),
]);
const provenance = z.discriminatedUnion("status", [
  z.looseObject({ ...baseFact, status: z.literal("complete") }),
  z.looseObject({ ...baseFact, status: z.literal("partial"), cuts: z.array(cut).min(1) }),
  z.looseObject({ ...baseFact, status: z.literal("unknown"), reason: z.string() }),
]);
const strings = z.array(z.string());
const position = z.looseObject({ file: z.string(), symbol: z.string(), line: z.number() });
const handler = z.looseObject({ path: z.string(), symbol: z.string(), line: z.number() });
const impact = z.looseObject({
  seeds: z.array(position),
  symbols: z.array(position),
  entrypoints: z.array(z.looseObject({ handler, seeds: z.array(z.number()) })),
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
const workspaceImpact = z.looseObject({
  workspace: workspaceIdentity,
  repositorySnapshots: snapshots,
  trigger: z.looseObject({ repo: z.string() }),
  sections: z.record(z.string(), factOf(z.looseObject({
    reads: z.array(z.looseObject({ kind: z.string(), fact: provenance })),
    impact: impact.optional(),
    callSites: z.array(callSite),
    unmatched: z.array(callSite),
    external: z.array(callSite),
    unresolved: z.array(unresolvedCallSite),
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
  id: z.string(),
  kind: z.string(),
  subject: z.string(),
  evidence: z.array(repositoryEvidence),
  options: z.array(z.looseObject({ value: z.string(), evidence: z.array(repositoryEvidence), recommended: z.boolean() })),
  allowsFreeText: z.boolean(),
  required: z.boolean(),
});
const entrypoint = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.enum(["http-route", "listener", "job"]), name: z.string(), handler }),
  z.looseObject({ kind: z.literal("ui-route"), name: z.string(), component: z.union([handler, z.literal("unknown")]) }),
]);
const finding = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("complete"), value: entrypoint, evidence: z.array(evidence) }),
  z.looseObject({ status: z.literal("unknown"), reason: z.string(), evidence: z.array(evidence) })
    .refine((item) => !("value" in item))
    .meta({ not: { required: ["value"] } }),
]);
const outlineDeclaration = z.looseObject({ kind: z.string(), name: z.string(), line: z.number(), endLine: z.number() });
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
const shapes = {
  entrypoints: z.looseObject({ entrypoints: factOf(z.array(finding)) }),
  impact: z.union([impact, workspaceImpact]),
  importers: z.looseObject({
    files: z.array(z.looseObject({ file: z.string(), importers: strings, users: strings, unresolvedNamers: strings })),
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
      focus: z.array(z.looseObject({ file: z.string(), selector: z.string(), path: z.string(), ancestors: z.array(outlineDeclaration), declaration: outlineDeclaration, omitted: z.number(), uses: z.array(z.looseObject({ relations: strings, at: z.array(z.looseObject({ line: z.number() })) })).optional() })),
      unheld: strings,
    }),
  ]),
  trace: z.looseObject({
    roots: z.array(z.looseObject({ target: z.string(), steps: z.array(z.number()) })),
    steps: z.array(z.looseObject({ id: z.number(), depth: z.number(), file: z.string(), symbol: z.string(), kind: z.string(), line: z.number() })),
    readingPlan: z.looseObject({ ranges: z.array(z.looseObject({ file: z.string(), start: z.number(), end: z.number(), steps: z.array(z.number()) })), lines: z.number() }),
  }),
  workspace: z.looseObject({
    workspace: workspaceIdentity,
    repositorySnapshots: snapshots,
    sections: z.record(z.string(), factOf(z.looseObject({
      names: z.array(outwardName),
      unresolved: z.array(unresolvedCallSite),
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
      findings: z.array(z.looseObject({ status: z.enum(["complete", "unknown"]), evidence: z.array(repositoryEvidence) })).optional(),
    })),
    change: z.looseObject({
      base: z.string(),
      head: z.string(),
      snapshots: z.looseObject({ base: z.string(), head: z.string() }),
      derivation: factOf(z.looseObject({
        gained: z.array(z.looseObject({ operation: z.string(), property: z.string() })),
        operations: z.looseObject({ added: strings, removed: strings }),
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
const OUTPUTS: Readonly<Record<ToolFamily, z.ZodType>> = { entrypoints: ENTRYPOINTS_OUTPUT, impact: IMPACT_OUTPUT, callers: CALLERS_OUTPUT, importers: IMPORTERS_OUTPUT, outline: OUTLINE_OUTPUT, trace: TRACE_OUTPUT, workspace: WORKSPACE_OUTPUT, decisions: DECISIONS_OUTPUT, contract_consequences: CONTRACT_CONSEQUENCES_OUTPUT };

type Refusal = (fault: CodedFault) => CallToolResult;
type Controls = { tool: "entrypoints" | "impact" | "callers"; select?: EvidenceSelection | undefined; page?: { limit: number; cursor?: string | undefined } | undefined; expect?: string | undefined };

/** The semantic query an original tool's arguments ask for: its own fields without presentation or recovery controls. */
function semanticOf<A extends { mode: ResponseMode; select?: unknown; page?: unknown; expect?: unknown }>(args: A): Omit<A, "mode" | "select" | "page" | "expect"> {
  const { mode: _mode, select: _select, page: _page, expect: _expect, ...semantic } = args;
  return semantic;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const { redaction } = deps;
  const catalog = repositoryCatalog(deps.repository, deps.repositories);
  if (!catalog.valid) throw new Error("Invalid repository catalog");
  const server = new McpServer({ name: "ye-ast", version: deps.version }, { instructions: redaction.redact(instructionsFor(deps.repository, catalog.available)) });

  /**
   * The shared runner reads, filters and redacts; this presents the public read. Full facts carry response siblings;
   * summary/details carry a minimal receipt and convey response-level limits in their text. Every success is validated
   * before delivery in content.
   */
  async function answer(query: ToolQuery, mode: ResponseMode, signal: AbortSignal, controls?: Controls): Promise<CallToolResult> {
    const context = faultContext(query, controls);
    const selectionFailure = (fault: CodedFault): CallToolResult => failure(controlFault(fault), context);
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
      if (!executed.ok) return failure(executed.fault, context);
      return present(executed.value, mode, controls, cursor, selectionFailure);
    } catch (error) {
      return failure({ kind: "internal-fault", detail: redaction.redactError(error) }, context);
    }
  }

  /** The renderer and selection source of each public payload; the dispatch itself lives in the runner. */
  function present(source: PresentedSource, mode: ResponseMode, controls: Controls | undefined, cursor: CursorV1 | undefined, selectionFailure: Refusal): CallToolResult {
    switch (source.family) {
      case "entrypoints":
        return respond(source, source.read, true, renderEntrypointMap, mode, controls, cursor, selectionFailure, (fact) => ({ kind: "entrypoints", fact }));
      case "impact":
      case "callers":
        return source.branch === "local"
          ? respond(source, source.read, true, renderImpact, mode, controls, cursor, selectionFailure, (fact) => ({ kind: "local", fact }))
          : respond(source, source.read, false, renderWorkspaceImpact, mode, controls, cursor, selectionFailure, (fact) => ({ kind: "workspace", fact }));
      case "importers":
        return respond(source, source.read, true, renderImporters, mode, controls, cursor, selectionFailure);
      case "outline":
        return respond(source, source.read, true, renderOutline, mode, controls, cursor, selectionFailure);
      case "trace":
        return respond(source, source.read, true, renderTrace, mode, controls, cursor, selectionFailure);
      case "workspace":
        return respond(source, source.read, false, renderWorkspace, mode, controls, cursor, selectionFailure);
      case "decisions":
        return respond(source, source.read, false, renderDecisions, mode, controls, cursor, selectionFailure);
      case "contract_consequences":
        return respond(source, source.read, false, renderContractConsequences, mode, controls, cursor, selectionFailure);
    }
  }

  function respond<V>(
    source: PresentedSource,
    read: PublicRead<V>,
    local: boolean,
    render: ResponseRenderer<V>,
    mode: ResponseMode,
    controls: Controls | undefined,
    cursor: CursorV1 | undefined,
    selectionFailure: Refusal,
    sourceFor?: (fact: Fact<V>) => EvidenceSource,
  ): CallToolResult {
    const { fact, repositoryRoots, refresh, workspaceLive } = read;
    const { recovery, live: stale } = source;
    const tool: ToolFamily = source.family;
    const renderContext = { tool, ...(recovery === undefined ? {} : { recovery }) };
    const expected = cursor?.resultIdentity ?? controls?.expect;
    if (expected !== undefined && recovery !== undefined) {
      const verified = assertSourceIdentity(recovery, expected);
      if (!verified.ok) return selectionFailure(verified.fault);
    }
    const recoveryText = recovery === undefined ? [] : [recoveryReference(recovery)];
    const meta = { ...(stale === undefined ? {} : { [LIVE_META]: stale }), ...(workspaceLive === undefined ? {} : { [WORKSPACE_LIVE_META]: workspaceLive }) };
    const emit = (text: string, fields: Record<string, unknown>): CallToolResult => {
      OUTPUTS[tool].parse({ text, ...fields });
      return delivered(text, fields, meta);
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
        ? mode === "full"
          ? { ...shared, kind: "projection", availability: "available", context: records.context, items: records.items, page }
          : { ...shared, kind: "projection-receipt", availability: "available", page }
        : mode === "full"
          ? { ...shared, kind: "projection", availability: "unavailable", reason: records.reason, evidence: records.evidence }
          : { ...shared, kind: "projection-receipt", availability: "unavailable", reason: records.reason };
      const sidecar = [
        ...(stale === undefined ? [] : [renderStale(stale)]),
        ...(workspaceLive === undefined ? [] : workspaceLive.map((item) => `workspace live: ${JSON.stringify(item)}`)),
        ...(refresh === undefined ? [] : renderRefresh(refresh)),
        ...(repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`),
      ];
      return emit([...sidecar, renderEvidenceSelection({ mode, select: controls.select, records, recovery, ...(page === undefined ? {} : { page }) })].join("\n"), fields);
    }
    if (mode === "full") {
      return emit(
        [
          `status: ${fact.status}\nfull result: the result JSON`,
          render(fact, mode, renderContext),
          ...recoveryText,
          ...(repositoryRoots === undefined ? [] : ["Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot."]),
          ...(refresh === undefined ? [] : ["Remote context: inspect freshness and resolution for the repositories used; pinned revisions do not imply verified freshness."]),
          ...(stale === undefined ? [] : ["Live context: inspect live.stateId and live.changed before comparing this result with the current working tree."]),
          ...(workspaceLive === undefined ? [] : ["Workspace live context: inspect workspaceLive for captured snapshots and stale or unavailable checks. Captures are not an atomic workspace instant."]),
        ].filter((part) => part !== "").join("\n"),
        {
          ...fact,
          mode,
          ...(recovery === undefined ? {} : { recovery }),
          ...(repositoryRoots === undefined ? {} : { repositoryRoots }),
          ...(refresh === undefined ? {} : { freshness: refresh.freshness, resolution: refresh.resolution }),
          ...(stale === undefined ? {} : { live: stale }),
          ...(workspaceLive === undefined ? {} : { workspaceLive }),
        },
      );
    }
    const sidecar = [
      ...(stale === undefined ? [] : [renderStale(stale)]),
      ...(workspaceLive === undefined ? [] : workspaceLive.map((item) => `workspace live: ${JSON.stringify(item)}`)),
      ...(refresh === undefined ? [] : renderRefresh(refresh)),
      ...(local ? [] : (repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`)),
    ];
    return emit(
      [...sidecar, render(fact, mode, renderContext), ...recoveryText, ...(local ? (repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`) : [])].join("\n"),
      {
        mode,
        status: fact.status,
        snapshot: fact.snapshot,
        ...(recovery === undefined ? {} : { recovery }),
        ...(fact.status === "unknown" ? { reason: fact.reason } : {}),
      },
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

  server.registerTool("ye_ast_compose", {
    title: "Compose evidence from related queries",
    description: "Run 1..16 queries of the other ye_ast tools in one call when they share entities, e.g. callers of a symbol plus the entrypoints of its repository. Combines findings, keeping each source's coverage, trust and snapshot checks. Each queries[].arguments takes the same analysis arguments as the named tool (no mode, select or page); queries rerun in a fixed order and nothing is stored. Generic dependencies do not prove breakage. Request limit: 1 MiB of canonical JSON.",
    inputSchema: compactInput(COMPOSE_INPUT, { arguments: "The arguments of the tool named in name, without mode, select or page." }),
    annotations,
  }, async (input, ctx) => {
    try {
      const result = await runComposition(input, { deps, catalog, signal: ctx.mcpReq.signal });
      if (!result.ok) return failure(result.fault, sourceContext(input.queries, result.fault));
      const fields = input.mode === "full" ? composeFull(result.value) : composeReceipt(result.value, input.mode);
      COMPOSE_OUTPUT.parse(fields);
      return delivered(renderComposition(result.value, input.mode), fields, {});
    } catch (error) {
      return failure({ kind: "internal-fault", detail: redaction.redactError(error) });
    }
  });

  server.registerTool(
    "ye_ast_entrypoints",
    {
      title: "Entrypoints of a revision",
      description: "Use to orient in a repository or to find where an HTTP/UI route, message listener or job is handled. Lists entrypoints with handler locations. For dependents use ye_ast_callers; for a diff use ye_ast_impact.",
      inputSchema: compactInput(TOOL_INPUTS.entrypoints),
      annotations,
    },
    (args: ToolArguments<"entrypoints">, ctx) =>
      answer({ name: "ye_ast_entrypoints", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "entrypoints", select: args.select, page: args.page, expect: args.expect }),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: "Use to review a change: traces changed declarations from merge-base(base, head) to head, their incoming dependents, reached entrypoints and entrypoints added, removed or altered. base is required; head defaults to HEAD; live reads trusted uncommitted edits. workspace adds incoming and outgoing cross-repository links. For an unchanged symbol use ye_ast_callers.",
      inputSchema: compactInput(TOOL_INPUTS.impact, REPLAY_GUIDE),
      annotations,
    },
    (args: ToolArguments<"impact">, ctx) =>
      answer({ name: "ye_ast_impact", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "impact", select: args.select, page: args.page, expect: args.expect }),
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: "Use before changing, renaming or deleting an existing declaration: traces its incoming dependents and the entrypoints reaching it, with dependency locations. Target a name (matches the final segment, possibly several declarations) or an inclusive line range; an unknown name is an error. workspace adds incoming cross-repository call sites. For a diff use ye_ast_impact.",
      inputSchema: compactInput(TOOL_INPUTS.callers, REPLAY_GUIDE),
      annotations,
    },
    (args: ToolArguments<"callers">, ctx) =>
      answer({ name: "ye_ast_callers", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "callers", select: args.select, page: args.page, expect: args.expect }),
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: "Use before moving, renaming or deleting a file or changing its exports: lists static, reexport, dynamic and type importers, users and unresolved names; details lists each path once with its categories and positions, and users without a module category are additional. Import edges do not prove declaration use; unresolved names prove neither dependencies nor affected files. TypeScript includes alias/barrel edges and exported test consumers; omitted live tests yield partial. For declarations use ye_ast_callers.",
      inputSchema: compactInput(TOOL_INPUTS.importers),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"importers">, ctx) => answer({ name: "ye_ast_importers", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_outline",
    {
      title: "Shape of files",
      description: "Use to choose line ranges before reading or targeting code: indexed declaration spans and imports of files, without source. Each import gives its target (repository file, package, or unresolved with a reason) and the names it binds, with their proven declaration and line. Members nest under their contains edge; others stay top level. Instead of files, focus on declarations: {file, symbol} takes a dotted path (Class.member, a bare name at any depth), {file, line} the innermost declaration holding the line; a match gives its containers, subtree, omitted count and uses outside its body (file:line, package, global, else a cut), no imports. Its path works verbatim in ye_ast_callers; for callers too, use ye_ast_compose. Unavailable files report cuts, not empty lists. Match revision/live to the source you inspect.",
      inputSchema: compactInput(TOOL_INPUTS.outline),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"outline">, ctx) => answer({ name: "ye_ast_outline", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_trace",
    {
      title: "What declarations execute",
      description: "Use to follow a flow forward before reading it file by file: from each declaration a target selects (a name, maybe several declarations, an inclusive line range, or an entrypoint), the calls its body makes in source order, then theirs, each declaration expanded once, repeats marked seen. Branches are not evaluated. Terminal callees fold into leaves with their spans; external calls group by module; declared-client requests and messages are effects with their target (undecided: a cut); a call no rule settles is a cut listing candidates. The reading plan lists the spans to open, merged per file. For who depends on a declaration use ye_ast_callers.",
      inputSchema: compactInput(TOOL_INPUTS.trace),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"trace">, ctx) => answer({ name: "ye_ast_trace", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_workspace",
    {
      title: "Repositories a workspace names",
      description: "Use to find which other repositories this one talks to: outward names (HTTP hosts and prefixes, config URLs, message destinations, dependency coordinates, remotes, registries), candidate repositories with match evidence, unserved names, and the links between the repositories read (HTTP calls and published messages joined to the routes and listeners they reach), with the calls that matched no or several entrypoints. Helps choose clones for workspace on ye_ast_callers/ye_ast_impact; never downloads or guesses unresolved targets. Trusted persisted remotes may refresh unless offline.",
      inputSchema: compactInput(TOOL_INPUTS.workspace),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"workspace">, ctx) => answer({ name: "ye_ast_workspace", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_decisions",
    {
      title: "Gaps a workspace leaves to the user",
      description: "Use before ye-ast init --workspace or to build a workspace config form: configuration gaps (membership, identity, gateways, trust, remotes) with evidence-backed options and rule-based recommendations; some need free text. About configuration only, not code quality or change approval. Writes nothing.",
      inputSchema: compactInput(TOOL_INPUTS.decisions),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"decisions">, ctx) => answer({ name: "ye_ast_decisions", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_contract_consequences",
    {
      title: "Consequences of a contract change",
      description: "Assess how hypothetical or committed HTTP request/response contract changes affect consumers and request producers, with code evidence and explicit unknowns.",
      inputSchema: compactInput(TOOL_INPUTS.contract_consequences),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"contract_consequences">, ctx) => answer({ name: "ye_ast_contract_consequences", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  return server;
}
