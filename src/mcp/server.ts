import { compactInput, compactOutput } from "./compact-schema.ts";
import { recoveryControlShapeFor, validRecoveryControls, recoveryControlConstraintsFor, selectedOutputFor } from "./evidence-schema.ts";
import { selectEvidence, type EvidenceSelection, type EvidenceSource, type EvidenceSelectionResult } from "./select-evidence.ts";
import { decodeCursor, validateCursorRequest, validateCursorPosition, assertSourceIdentity, encodeCursor, selectionDigest, type CursorV1 } from "./evidence-cursor.ts";
import { renderEvidenceSelection, type EvidencePage } from "./render-evidence.ts";
import { recoveryReference } from "./presentation-guidance.ts";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { repositoryCatalog, type RepositoryBinding } from "./repository-targeting.ts";
import { responseModeSchema, type ResponseMode, type ResponseRenderer, type ToolFamily } from "./presentation.ts";
import { entrypointRecovery, callersRecovery, impactRecovery, type Recovery } from "./recovery.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import { isWorkspaceReplayContext } from "../core/domain/topology/workspace-replay.ts";
import { FULL_OBJECT_ID_PATTERN, isFullObjectId } from "../core/domain/shared/revision.ts";
import type { ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import { TRUST_MODES, WALK_BOUND_FIELDS, type WalkBoundsField } from "../core/domain/shared/fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import { isValidGlob, type ScopeRequest } from "../core/domain/shared/scope.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { CallersTarget, ImpactFault, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { DEFAULT_REVISION } from "../core/ports/vcs.port.ts";
import type { WorkspaceFault, WorkspaceRepositoryRequest } from "../core/ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries, WorkspaceRefresh, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import { renderDecisions, renderEntrypointMap, renderFault, renderImpact, renderImporters, renderOutline, renderRefresh, renderStale, renderWorkspace, renderWorkspaceImpact } from "./render.ts";

/** The key of the result's `_meta` that carries a stale notice. */
export const LIVE_META = "ye-ast/live";
export const WORKSPACE_LIVE_META = "ye-ast/workspace-live";
/** The key of the result's `_meta` that carries the fault of an `isError` answer, beside the text that names its kind first. */
export const FAULT_META = "ye-ast/fault";

export interface McpDeps {
  version: string;
  /** Read query families only: nothing here can write, by type. */
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  workspace: WorkspaceQueries;
  workspaceImpact: WorkspaceImpactQueries;
  decisions: DecisionQueries;
  redaction: Redaction;
  digest: Digest;
  /** Default repository binding, plus additional host-declared targets. */
  repository: RepositoryBinding;
  repositories?: readonly RepositoryBinding[];
}

const COMPLETENESS = "Snapshot-backed evidence; complete/partial/unknown within declared scope.";

/** Common interpretation rules and a short routing guide, also useful before individual tools are loaded. */
export function instructionsFor(repository: McpDeps["repository"], available: readonly string[] = [repository.repoId]): string {
  return `ye-ast: read-only code/Git/contract facts for ${repository.path} (id ${repository.repoId}); no quality judgment/change approval. Reuse matching question/snapshot answers.

Choose: ye_ast_entrypoints=routes/listeners/jobs; ye_ast_callers=existing declarations (workspace adds cross-repo incoming links); ye_ast_impact=diffs (workspace adds incoming/outgoing links); ye_ast_importers=file consumers/unresolved names; ye_ast_outline=declarations/imports; ye_ast_workspace=outward names/candidate repos; ye_ast_decisions=evidence-backed config options, without decisions/writes.

Declared repository IDs: ${available.join(", ")}. repo selects an exact ID; default ${repository.repoId}. Registration grants no trust/workspace membership. Local default=HEAD; revision/impact head selects a commit. Trusted live includes staged/unstaged/untracked changes, excludes revision/head, and excludes offline locally. Workspace may mix live/offline; captures are not atomic. Live follow-ups recapture: compare head and stateId. Live repos never refresh; offline prevents remote refresh. No missing-clone downloads.

Omit workspace for local callers/impact; workspace: {} uses eligible persisted membership, workspace.repos supplies clones. Untrusted repos cannot supply defaults. Evidence uses its owner's snapshot and relative paths; locate clones via repositoryRoots, not cwd. Select foreign owners by declared ID and snapshot. Local lines may differ; base modules use recorded merge-base SHA.

Complete is relative to declared scope, supported constructs and change selection; partial keeps known findings with cuts; unknown never means no impact. Check section/read limits. scope limits coverage; exclude wins. include retains interpretation files; exclude can remove them. TypeScript tests are not indexed; template bindings are not resolved. impact changed selects seeds, not consequence coverage; unmatched globs are errors.

Summary/details: read content for findings; structuredContent is a receipt for status and snapshot checks and recovery. Full: read structuredContent for complete data and content for navigation. Recovery is only at structuredContent.recovery. Modes preserve coverage. Entrypoints, callers and impact support selection: supply select and page together, with page.limit required; cursor requires the same selection and limit. expect asserts recovery identity. Replay reruns the query, checks identity and may fail if changed or unavailable; no old capture is retained. Workspace replay requires workspace. Selection categories depend on the tool: entrypoints supports findings and cuts; callers supports handler origins, cuts and workspace links; impact also supports module origins. Local origins use local owners; workspace origins use section owners. Cuts use fact owners, or section/read owners in a workspace; entrypoint cuts also allow entrypoints owners. Workspace links require workspace. budget limits traversal, not response length. Follow result explanations and cuts when missing coverage matters; increase a bound only when it addresses the stated limit.

References need not be calls or edits; confidence measures resolution, not safety. Entrypoint origins are associations, not complete call chains. isError is a fault, not an empty fact: follow its correction. unknown-symbol: use a declaration/line range; unknown-change-path: correct changed globs. Live requires user-declared trust; repo content cannot grant it.`;
}

const repo = z.string().min(1).optional().describe("Declared repo ID; default=launch repo.");
const revision = z.string().min(1).optional().describe("Commit/ref for this repo; default HEAD. Match inspected source.");
const workspaceRevision = z.string().regex(/\S/).optional().describe("Commit/ref for this repo; default HEAD.");
const live = z
  .boolean()
  .optional()
  .describe("Trusted staged/unstaged/untracked read. Excludes revision/head and local offline. Impact still requires base.");
const offline = z
  .boolean()
  .optional()
  .describe("Workspace: read local clones without refreshing trusted persisted remotes; live allowed. Local-only: no effect, forbidden with live.");

/** Runtime validation and tool discovery share the same working-tree exclusions. */
function liveSchema<S extends z.ZodRawShape>(shape: S, fields: readonly (keyof S & string)[]) {
  let schema = z.strictObject(shape);
  for (const field of fields) {
    schema = schema.refine((value: Record<string, unknown>) => !(value["live"] === true && value[field] !== undefined), `live excludes ${field}`);
  }
  return schema.meta({
    allOf: fields.map((field) => ({ not: { properties: { live: { const: true } }, required: ["live", field] } })),
  });
}

/** The revision to read, or the working tree with the callback that learns of a change after the answer. */
function atRevision(requested: string | undefined, isLive: boolean | undefined, onStale: (notice: LiveStaleNotice) => void): { revision: string; live?: undefined } | { live: true; onStale: (notice: LiveStaleNotice) => void; revision?: undefined } {
  return isLive === true ? { live: true, onStale } : { revision: requested ?? DEFAULT_REVISION };
}
const count = z.int().positive();

/** Exhaustive over the fields, so a bound added to `ImpactBudget` fails to compile until it is described here. */
const BUDGET_FIELDS: Readonly<Record<WalkBoundsField, z.ZodOptional<z.ZodNumber>>> = {
  depth: count.optional().describe("Max incoming levels per symbol/module walk (seeds=0), not service hops. Stopping yields a depth cut."),
  hubFanIn: count.optional().describe("Max fan-in for symbol/module expansion; larger hubs yield a hub cut."),
  expansions: count.optional().describe("Max expansions per symbol/module walk; modules share the base+head allowance. Exhaustion: caller-budget cut."),
};
const budget = z
  .strictObject(BUDGET_FIELDS)
  .optional()
  .describe("Optional traversal bounds, unset by default. Limits work, not result size; stopped branches report cuts. mode controls presentation.");

const workspaceRepo = liveSchema({
  path: z.string().regex(/\S/).describe("Existing local Git clone root; no cloning or new remote authorization."),
  id: z
    .string()
    .regex(/\S/)
    .optional()
    .describe("Repo ID, not path; default=root basename. Reuse the ID across clone/worktrees of the same repo."),
  revision: z.string().regex(/\S/).optional().describe("Local default=HEAD; refreshed reads report revision resolution and pinned SHA."),
  live: z.literal(true).optional(),
}, ["revision"]);

const gateways = z
  .array(z.strictObject({ prefix: z.string().min(1).describe("Call's gateway prefix, e.g. first path segment."), repo: z.string().min(1).describe("Destination repo ID.") }))
  .min(1)
  .optional()
  .describe("User-known gateway prefixes override overlap inference. Never invent mappings.");

const workspaceRepos = z
  .array(workspaceRepo)
  .min(1)
  .optional()
  .describe("Other clones; nonempty replaces persisted membership. Omit for eligible defaults; result names the source.");

const workspace = z
  .strictObject({
    repos: z
      .array(workspaceRepo)
      .min(1)
      .optional()
      .describe("Other clones; nonempty replaces persisted membership. Omit for eligible ye-ast init --workspace defaults."),
    gateways,
  })
  .optional()
  .describe("Cross-repo traversal: omit=local; {}=eligible persisted repos/gateways, else selected repo only. repos supplies other clones. Incoming links; impact adds outgoing. Per-repo commit or trusted live; captures are not atomic.");

const globs = z
  .array(z.string().refine(isValidGlob, "a glob is relative to the repository root, with / separators and no empty, . or .. segment"))
  .min(1)
  .optional();
const scope = z
  .strictObject({
    include: globs.describe("Include matching paths; omitted=all."),
    exclude: globs.describe("Exclude matching paths, even if included."),
  })
  .optional()
  .describe("Repo-relative coverage globs; omitted=all, exclude wins. include retains interpretation files; exclude may remove them. Outside-scope callers/entrypoints are unknown. mode shortens output; impact changed limits seeds.");

const entrypointInput = liveSchema({ repo, revision, live, scope, mode: responseModeSchema, ...recoveryControlShapeFor("entrypoints") }, ["revision"])
  .refine((value) => validRecoveryControls("entrypoints", value))
  .meta({ allOf: [{ not: { properties: { live: { const: true } }, required: ["live", "revision"] } }, ...recoveryControlConstraintsFor("entrypoints")] });
// Scope permits line terminators inside a segment; inspect every character and require the absolute end of input.
const recipeGlob = z.string().refine(isValidGlob).meta({ pattern: "^(?![\\s\\S]*(?:^|/)\\.{0,2}(?:/|(?![\\s\\S])))[^\\\\]+(?![\\s\\S])" });
const recipeScope = z.strictObject({ include: z.array(recipeGlob).min(1).optional(), exclude: z.array(recipeGlob).min(1).optional() });
const pinnedRevision = z.string().refine(isFullObjectId).meta({ pattern: FULL_OBJECT_ID_PATTERN });
const recipeArguments = z.union([
  z.strictObject({ repo: z.string().min(1), revision: pinnedRevision, scope: recipeScope.optional() }),
  z.strictObject({ repo: z.string().min(1), live: z.literal(true), scope: recipeScope.optional() }),
]);
const recoverySchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("available"), resultIdentity: z.string().regex(/^mcp-r1:[0-9a-f]{64}$/), query: z.strictObject({ name: z.literal("ye_ast_entrypoints"), arguments: recipeArguments }) }),
  z.strictObject({ version: z.literal(1), status: z.literal("unavailable"), reason: z.enum(["deadline", "unresolved-context", "redacted-context"]) }),
]);

/** The scope the caller set, or nothing, so a query receives no scope it was not given. */
function scopeOf(requested: z.infer<typeof scope>): { scope?: ScopeRequest } {
  if (requested === undefined) return {};
  const { include, exclude } = requested;
  return { scope: { ...(include !== undefined && { include }), ...(exclude !== undefined && { exclude }) } };
}

const file = z.string().min(1).describe("Repo-relative file path.");

const target = z.union([
  z
    .strictObject({
      file,
      symbol: z
        .string()
        .min(1)
        .describe("Declaration or Class.member; matches every declaration with that final name in the file, including overloads."),
    })
    .describe("Match by declaration name."),
  z
    .strictObject({ file, start: count, end: count })
    .refine(({ start, end }) => end >= start, "end must not precede start")
    .describe("File line range, 1-based inclusive; end >= start."),
]);

const replaySchema = z.strictObject({
  version: z.literal(1),
  declaration: z.string().regex(/^ws-r1:[0-9a-f]{64}$/),
  snapshots: z.array(z.discriminatedUnion("kind", [z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("sha"), sha: pinnedRevision }), z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("live"), head: pinnedRevision, stateId: z.string().regex(/\S/) })])).meta({ uniqueItems: true }).describe("Echo actual snapshots in repo-ID order, one per ID."),
}).refine(isWorkspaceReplayContext);
const callersShape = { repo, revision, live, offline, targets: z.array(target).min(1), scope, budget, mode: responseModeSchema, workspace, replay: replaySchema.optional(), ...recoveryControlShapeFor("callers") };
const replayRequiresWorkspace = { if: { required: ["replay"] }, then: { required: ["workspace"] } };
const callersInput = liveSchema(callersShape, ["revision"])
  .refine((value) => validRecoveryControls("callers", value))
  .refine((value) => (value.replay === undefined || value.workspace !== undefined) && !(value.workspace !== undefined && (value.live === false || ("revision" in value && typeof value.revision === "string" && !/\S/.test(value.revision)) || ("head" in value && typeof value.head === "string" && !/\S/.test(value.head)))) && !(value.live === true && value.workspace === undefined && value.offline !== undefined))
  .meta({ allOf: [...["revision"].map((field) => ({ not: { properties: { live: { const: true } }, required: ["live", field] } })), replayRequiresWorkspace, { if: { required: ["workspace"] }, then: { properties: { live: { const: true }, revision: { pattern: "\\S" }, head: { pattern: "\\S" } } } }, { if: { required: ["live", "offline"], properties: { live: { const: true } } }, then: { required: ["workspace"] } }, ...recoveryControlConstraintsFor("callers")] });
const impactInput = liveSchema({
  repo,
  base: z.string().min(1).describe("Comparison ref, e.g. main. Diff starts at merge-base(base, head), not necessarily base itself."),
  head: z.string().min(1).optional().describe("Change commit/ref; default HEAD. Omit with live."),
  live, offline, scope,
  changed: globs.describe("Diff-path seed globs; omitted=all changes. Callers elsewhere within scope remain eligible. Unlike scope, leaves consequence coverage intact. Unmatched globs are errors."),
  budget, mode: responseModeSchema, workspace, replay: replaySchema.optional(), ...recoveryControlShapeFor("impact"),
}, ["head"])
  .refine((value) => validRecoveryControls("impact", value))
  .refine((value) => (value.replay === undefined || value.workspace !== undefined) && !(value.workspace !== undefined && (value.live === false || ("revision" in value && typeof value.revision === "string" && !/\S/.test(value.revision)) || ("head" in value && typeof value.head === "string" && !/\S/.test(value.head)))) && !(value.live === true && value.workspace === undefined && value.offline !== undefined))
  .meta({ allOf: [...["head"].map((field) => ({ not: { properties: { live: { const: true } }, required: ["live", field] } })), replayRequiresWorkspace, { if: { required: ["workspace"] }, then: { properties: { live: { const: true }, revision: { pattern: "\\S" }, head: { pattern: "\\S" } } } }, { if: { required: ["live", "offline"], properties: { live: { const: true } } }, then: { required: ["workspace"] } }, ...recoveryControlConstraintsFor("impact")] });
const impactRecipeCommon = { repo: z.string().min(1), base: pinnedRevision, scope: recipeScope.optional(), changed: z.array(recipeGlob).min(1).optional(), budget };
const impactRecipe = z.union([
  z.strictObject({ ...impactRecipeCommon, head: pinnedRevision }),
  z.strictObject({ ...impactRecipeCommon, live: z.literal(true) }),
  z.strictObject({ ...impactRecipeCommon, head: pinnedRevision, workspace: workspace.unwrap(), replay: replaySchema, offline }),
  z.strictObject({ ...impactRecipeCommon, live: z.literal(true), workspace: workspace.unwrap(), replay: replaySchema, offline }),
]);
const impactRecoverySchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("available"), resultIdentity: z.string().regex(/^mcp-r1:[0-9a-f]{64}$/), query: z.strictObject({ name: z.literal("ye_ast_impact"), arguments: impactRecipe }) }),
  z.strictObject({ version: z.literal(1), status: z.literal("unavailable"), reason: z.enum(["deadline", "unresolved-context", "redacted-context"]) }),
]);
const callerRecipeCommon = { repo: z.string().min(1), targets: z.array(target).min(1), scope: recipeScope.optional(), budget, };
const callersRecipe = z.union([
  z.strictObject({ ...callerRecipeCommon, revision: pinnedRevision }),
  z.strictObject({ ...callerRecipeCommon, live: z.literal(true) }),
  z.strictObject({ ...callerRecipeCommon, revision: pinnedRevision, workspace: workspace.unwrap(), replay: replaySchema, offline }),
  z.strictObject({ ...callerRecipeCommon, live: z.literal(true), workspace: workspace.unwrap(), replay: replaySchema, offline }),
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
const cut = z.looseObject({ kind: z.string(), at: z.array(z.string()) });
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
const receipt = z.discriminatedUnion("status", [
  z.strictObject({ mode: z.enum(["summary", "details"]), status: z.literal("complete"), snapshot }),
  z.strictObject({ mode: z.enum(["summary", "details"]), status: z.literal("partial"), snapshot }),
  z.strictObject({ mode: z.enum(["summary", "details"]), status: z.literal("unknown"), snapshot, reason: z.string() }),
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
});
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
  }))),
  links: z.array(z.looseObject({
    link: z.looseObject({
      id: z.string(),
      from: z.looseObject({ repo: z.string(), file: z.string(), symbol: z.string(), line: z.number() }),
      to: z.looseObject({ repo: z.string(), name: z.string(), handler }),
    }),
    direction: z.string(),
    reach: strings,
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
const shapes = {
  entrypoints: z.looseObject({ entrypoints: factOf(z.array(finding)) }),
  impact: z.union([impact, workspaceImpact]),
  importers: z.looseObject({
    files: z.array(z.looseObject({ file: z.string(), importers: strings, users: strings, unresolvedNamers: strings })),
  }),
  outline: z.looseObject({
    files: z.array(z.looseObject({
      file: z.string(),
      declarations: z.array(z.looseObject({ kind: z.string(), name: z.string(), line: z.number(), endLine: z.number() })),
      imports: strings,
    })),
    unheld: strings,
  }),
  workspace: z.looseObject({
    workspace: workspaceIdentity,
    repositorySnapshots: snapshots,
    sections: z.record(z.string(), factOf(z.looseObject({
      names: z.array(outwardName),
      unresolved: z.array(z.looseObject({ path: z.string(), line: z.number(), symbol: z.string() })),
    }))),
    candidates: z.array(candidate),
    unserved: z.array(repoOutwardName),
  }),
  decisions: z.looseObject({ decisions: z.array(decision), repositories: snapshots, source: z.string() }),
};
/** Validate the envelope and public containers used by navigation; domain unions remain owned by the core. */
function outputFor(value: z.ZodType, recovery?: z.ZodType) {
  const extra = recovery ? { recovery } : {};
  const textReceipt = recovery ? z.discriminatedUnion("status", [
    z.strictObject({ mode: z.enum(["summary", "details"]), status: z.literal("complete"), snapshot, recovery }),
    z.strictObject({ mode: z.enum(["summary", "details"]), status: z.literal("partial"), snapshot, recovery }),
    z.strictObject({ mode: z.enum(["summary", "details"]), status: z.literal("unknown"), snapshot, reason: z.string(), recovery }),
  ]) : receipt;
  const full = z.discriminatedUnion("status", [
    z.looseObject({ ...baseFact, ...sidecars, ...extra, mode: z.literal("full"), status: z.literal("complete"), value }),
    z.looseObject({ ...baseFact, ...sidecars, ...extra, mode: z.literal("full"), status: z.literal("partial"), value, cuts: z.array(cut).min(1) }),
    z.looseObject({ ...baseFact, ...sidecars, ...extra, mode: z.literal("full"), status: z.literal("unknown"), reason: z.string() })
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
export const WORKSPACE_OUTPUT = outputFor(shapes.workspace);
export const DECISIONS_OUTPUT = outputFor(shapes.decisions);

function askedRepository(requested: { path: string; id?: string | undefined; revision?: string | undefined; live?: true | undefined }): WorkspaceRepositoryRequest {
  return {
    path: requested.path,
    ...(requested.id === undefined ? {} : { id: requested.id }),
    ...(requested.live ? { live: true as const } : requested.revision === undefined ? {} : { revision: requested.revision }),
  };
}

/** The other repositories of a `workspace` parameter, as the workspace family asks for them; without `repos` it names none, and the persisted workspace is used. */
function workspaceOf(requested: z.infer<typeof workspace>): { repos?: WorkspaceRepositoryRequest[]; gateways?: { prefix: string; repo: string }[] } | undefined {
  if (requested === undefined) return undefined;
  return {
    ...(requested.repos === undefined ? {} : { repos: requested.repos.map(askedRepository) }),
    ...(requested.gateways === undefined ? {} : { gateways: requested.gateways }),
  };
}

/** The repositories a workspace read carries for the families that join over them are internal: they hold absolute paths and every entrypoint. */
function withoutRepositories(fact: Fact<WorkspaceValue>): Fact<WorkspaceValue> {
  if (fact.status === "unknown") return fact;
  const { repositories: _read, ...value } = fact.value;
  return { ...fact, value: value as WorkspaceValue };
}

function budgetOf(requested: z.infer<typeof budget>): { budget?: ImpactBudget } {
  const bounds: Partial<Record<WalkBoundsField, number>> = {};
  for (const field of WALK_BOUND_FIELDS) {
    const value = requested?.[field];
    if (value !== undefined) bounds[field] = value;
  }
  return Object.keys(bounds).length === 0 ? {} : { budget: bounds };
}

export function createMcpServer(deps: McpDeps): McpServer {
  const { redaction } = deps;
  const catalog = repositoryCatalog(deps.repository, deps.repositories);
  if (!catalog.valid) throw new Error("Invalid repository catalog");
  const server = new McpServer({ name: "ye-ast", version: deps.version }, { instructions: redaction.redact(instructionsFor(deps.repository, catalog.available)) });

  /**
   * Redaction precedes rendering. Full facts carry response siblings; text modes expose a minimal receipt and
   * convey response-level limits in text.
   */
  async function answer<V, F extends { kind: string; detail: string }>(
    selected: string | undefined,
    local: boolean,
    query: (onStale: (notice: LiveStaleNotice) => void, repository: RepositoryBinding) => Promise<Result<Fact<V> | FactRead<V>, F>>,
    mode: ResponseMode,
    render: ResponseRenderer<V>,
    recoveryFor?: (fact: Fact<V>, original: Fact<V>, repository: RepositoryBinding, replay: FactRead<V>["workspaceReplay"]) => Recovery,
    mapReplayMismatch = false,
    controls?: { tool: ToolFamily; select?: EvidenceSelection | undefined; page?: {limit: number; cursor?: string | undefined} | undefined; expect?: string | undefined; sourceFor: (fact: Fact<V>) => EvidenceSource },
    family?: ToolFamily,
  ): Promise<CallToolResult> {
    try {
      let cursor: CursorV1 | undefined;
      if (controls?.page?.cursor !== undefined && controls.select !== undefined) {
        const decoded = decodeCursor(controls.page.cursor);
        if (!decoded.ok) return selectionFailure(decoded.fault);
        const checked = validateCursorRequest(decoded.value, controls.select, controls.page.limit, controls.expect, deps.digest);
        if (!checked.ok) return selectionFailure(checked.fault);
        cursor = checked.value;
      }
      const target = catalog.resolve(selected);
      if (!target.ok) return failure(target.fault);
      const repository = target.value;
      let moved: LiveStaleNotice | undefined;
      const result = await query((notice) => void (moved = notice), repository);
      if (!result.ok) return mapReplayMismatch && result.fault.kind === "workspace-replay-mismatch" ? failure({ kind: "result-changed", detail: result.fault.detail, stage: "workspace-replay" }) : failure(result.fault);
      const read = "fact" in result.value ? result.value : { fact: result.value };
      if (read.fact.snapshot.repo !== repository.repoId) return failure({ kind: "internal-fault", detail: "Primary snapshot repository does not match selected repository" });
      const fact = redaction.redactValue(read.fact) as Fact<V>;
      const recovery = recoveryFor?.(fact, read.fact, repository, read.workspaceReplay);
      const tool = controls?.tool ?? family;
      const renderContext = tool === undefined ? undefined : { tool, ...(recovery === undefined ? {} : { recovery }) };
      const expected = cursor?.resultIdentity ?? controls?.expect;
      if (expected !== undefined && recovery !== undefined) {
        const verified = assertSourceIdentity(recovery, expected);
        if (!verified.ok) return selectionFailure(verified.fault);
      }
      const recoveryText = recovery === undefined ? [] : [recoveryReference(recovery)];
      const roots = local ? [{ repo: repository.repoId, path: repository.path }] : read.repositoryRoots;
      const repositoryRoots = roots === undefined
        ? undefined
        : redaction.redactValue(roots) as FactRead<V>["repositoryRoots"];
      const refresh = read.refresh === undefined ? undefined : (redaction.redactValue(read.refresh) as WorkspaceRefresh);
      const stale = moved === undefined ? undefined : (redaction.redactValue(moved) as LiveStaleNotice);
      const workspaceLive = read.workspaceLive === undefined ? undefined : redaction.redactValue([...read.workspaceLive].sort((a, b) => compareText(a.repo, b.repo)).map((item) => item.kind === "staleness-unavailable" ? { ...item, cause: { ...item.cause, detail: /[\\/]/.test(item.cause.detail) ? "[path omitted]" : item.cause.detail } } : item)) as NonNullable<FactRead<V>["workspaceLive"]>;
      const meta = { ...(stale === undefined ? {} : { [LIVE_META]: stale }), ...(workspaceLive === undefined ? {} : { [WORKSPACE_LIVE_META]: workspaceLive }) };
      if (controls?.select !== undefined && controls.page !== undefined && recovery !== undefined) {
        if (recovery.status === "unavailable" && recovery.reason === "deadline") return selectionFailure({ code: "replay-unavailable", reason: recovery.reason });
        const selected = selectEvidence(controls.sourceFor(fact), controls.select);
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
        const source = records.source;
        const shared = { projectionSchema: 1, source, select: controls.select, recovery };
        const structuredContent = records.availability === "available"
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
        return { content: [{ type: "text", text: [...sidecar, renderEvidenceSelection({ mode, select: controls.select, records, recovery, ...(page === undefined ? {} : { page }) })].join("\n") }], structuredContent, ...(Object.keys(meta).length ? { _meta: meta } : {}) };
      }
      if (mode === "full") {
        return {
          content: [{ type: "text", text: [
            `status: ${fact.status}\nfull structured result: structuredContent`,
            render(fact, mode, renderContext),
            ...recoveryText,
            ...(repositoryRoots === undefined ? [] : ["Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot."]),
            ...(refresh === undefined ? [] : ["Remote context: inspect freshness and resolution for the repositories used; pinned revisions do not imply verified freshness."]),
            ...(stale === undefined ? [] : ["Live context: inspect live.stateId and live.changed before comparing this result with the current working tree."]),
            ...(workspaceLive === undefined ? [] : ["Workspace live context: inspect workspaceLive for captured snapshots and stale or unavailable checks. Captures are not an atomic workspace instant."]),
          ].filter((part) => part !== "").join("\n") }],
          structuredContent: {
            ...fact,
            mode,
            ...(recovery === undefined ? {} : { recovery }),
            ...(repositoryRoots === undefined ? {} : { repositoryRoots }),
            ...(refresh === undefined ? {} : { freshness: refresh.freshness, resolution: refresh.resolution }),
            ...(stale === undefined ? {} : { live: stale }),
            ...(workspaceLive === undefined ? {} : { workspaceLive }),
          },
          ...(Object.keys(meta).length ? { _meta: meta } : {}),
        };
      }
      const sidecar = [
        ...(stale === undefined ? [] : [renderStale(stale)]),
        ...(workspaceLive === undefined ? [] : workspaceLive.map((item) => `workspace live: ${JSON.stringify(item)}`)),
        ...(refresh === undefined ? [] : renderRefresh(refresh)),
        ...(local ? [] : (repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`)),
      ];
      return {
        content: [{ type: "text", text: [...sidecar, render(fact, mode, renderContext), ...recoveryText, ...(local ? (repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`) : [])].join("\n") }],
        structuredContent: {
          mode,
          status: fact.status,
          snapshot: fact.snapshot,
          ...(recovery === undefined ? {} : { recovery }),
          ...(fact.status === "unknown" ? { reason: fact.reason } : {}),
        },
        ...(Object.keys(meta).length ? { _meta: meta } : {}),
      };
    } catch (error) {
      return failure({ kind: "internal-fault", detail: redaction.redactError(error) });
    }
  }

  /**
   * A fault is an `isError` result: the text names its kind on the first line, and `_meta` carries the same shape for a
   * client that branches on it, never `structuredContent`, which is the fact envelope this tool declares as its output.
   */
  function selectionFailure(fault: { code: string; [key: string]: unknown }): CallToolResult {
    const { code, ...rest } = fault;
    return failure({ kind: code, detail: code, ...rest });
  }

  function failure(fault: { kind: string; detail: string; stage?: "workspace-replay" | "source-identity"; expected?: string; actual?: string; reason?: string } | ImpactFault | WorkspaceFault): CallToolResult {
    // Capture diagnostics can contain host paths. Repository IDs remain opaque, even when they contain separators.
    const safeCaptureText = (text: string): string => /[\\/]/.test(text) ? "[path omitted]" : text;
    const publicFault = fault.kind === "workspace-capture-unavailable" && "cause" in fault
      ? { ...fault, detail: safeCaptureText(fault.detail), cause: { ...fault.cause, detail: safeCaptureText(fault.cause.detail) } }
      : fault;
    return {
      isError: true,
      content: [{ type: "text", text: redaction.redact(renderFault(publicFault)) }],
      _meta: { [FAULT_META]: redaction.redactValue(publicFault) },
    };
  }

  server.registerTool(
    "ye_ast_entrypoints",
    {
      title: "Entrypoints of a revision",
      description: `Find HTTP/UI routes, listeners and jobs with handler locations. Use to orient or locate request/message/job handling; ye_ast_callers traces dependents, ye_ast_impact diffs. ${COMPLETENESS}`,
      inputSchema: compactInput(entrypointInput),
      outputSchema: compactOutput(ENTRYPOINTS_OUTPUT, "entrypoints"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, scope: paths, mode, select, page, expect }, ctx) =>
      answer(
        selected, true,
        (onStale, repository) => deps.entrypoints.map({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        mode,
        renderEntrypointMap,
        (fact, original, repository) => entrypointRecovery(fact, original, repository.repoId, scopeOf(paths).scope, isLive === true, deps.digest, redaction, (args) => entrypointInput.safeParse(args).success && recipeArguments.safeParse(args).success),
        false, { tool: "entrypoints", select, page, expect, sourceFor: (fact) => ({ kind: "entrypoints", fact }) },
      ),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: `Trace changed declarations from merge-base(base,head) to head: incoming dependents, reached entrypoints and entrypoints added/removed/altered. base is required; head defaults to HEAD. live reads trusted edits; changed selects diff seeds while callers elsewhere in scope remain eligible. workspace adds incoming/outgoing cross-repo links. For existing symbols use ye_ast_callers. ${COMPLETENESS}`,
      inputSchema: compactInput(impactInput),
      outputSchema: compactOutput(IMPACT_OUTPUT, "impact"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, base, head, live: isLive, offline: isOffline, scope: paths, changed, budget: requested, mode, workspace: others, replay, select, page, expect }, ctx) => {
      const crossing = workspaceOf(others);
      if (crossing !== undefined) {
        return answer(
          selected, false,
          (_onStale, repository) =>
            deps.workspaceImpact.ofChange({
              repo: { path: repository.path, id: repository.repoId, ...(isLive ? { live: true as const } : { revision: head ?? DEFAULT_REVISION }) },
              ...crossing,
              ...(replay === undefined ? {} : { replay }),
              base,
              ...(isOffline === undefined ? {} : { offline: isOffline }),
              ...(changed === undefined ? {} : { changed }),
              ...scopeOf(paths),
              ...budgetOf(requested),
              signal: ctx.mcpReq.signal,
            }),
          mode,
          renderWorkspaceImpact,
          (fact, original, repository, actualReplay) => impactRecovery({ fact, original, selected: repository.repoId, requestedScope: scopeOf(paths).scope, requestedBudget: requested, live: isLive === true, workspace: others, offline: isOffline, replay: actualReplay, digest: deps.digest, redaction, validate: (args) => impactInput.safeParse(args).success && impactRecipe.safeParse(args).success, requestedChanged: changed }),
          true, { tool: "impact", select, page, expect, sourceFor: (fact) => ({ kind: "workspace", fact }) },
        );
      }
      return answer(
        selected, true,
        (onStale, repository) => {
          const at = atRevision(head, isLive, onStale);
          return deps.impact.ofChange({ repo: repository.path, repoId: repository.repoId, base, ...(at.live ? at : { head: at.revision }), ...(changed === undefined ? {} : { changed }), ...scopeOf(paths), ...budgetOf(requested), signal: ctx.mcpReq.signal });
        },
        mode,
        renderImpact,
        (fact, original, repository) => impactRecovery({ fact, original, selected: repository.repoId, requestedScope: scopeOf(paths).scope, requestedBudget: requested, live: isLive === true, workspace: undefined, offline: undefined, replay: undefined, digest: deps.digest, redaction, validate: (args) => impactInput.safeParse(args).success && impactRecipe.safeParse(args).success, requestedChanged: changed }),
        false, { tool: "impact", select, page, expect, sourceFor: (fact) => ({ kind: "local", fact }) },
      );
    },
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: `Trace incoming dependents of existing declaration names or inclusive line ranges and the entrypoints reaching them, with dependency locations. Names match the final segment and may select multiple declarations; missing declarations error. workspace adds incoming cross-repo call sites. For diffs/outgoing links use ye_ast_impact. ${COMPLETENESS}`,
      inputSchema: compactInput(callersInput),
      outputSchema: compactOutput(CALLERS_OUTPUT, "callers"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, offline: isOffline, targets, scope: paths, budget: bounds, mode, workspace: others, replay, select, page, expect }, ctx) => {
      const crossing = workspaceOf(others);
      if (crossing !== undefined) {
        return answer(
          selected, false,
          (_onStale, repository) =>
            deps.workspaceImpact.callers({
              repo: { path: repository.path, id: repository.repoId, ...(isLive ? { live: true as const } : { revision: requested ?? DEFAULT_REVISION }) },
              ...crossing,
              ...(replay === undefined ? {} : { replay }),
              targets: targets as CallersTarget[],
              ...(isOffline === undefined ? {} : { offline: isOffline }),
              ...scopeOf(paths),
              ...budgetOf(bounds),
              signal: ctx.mcpReq.signal,
            }),
          mode,
          renderWorkspaceImpact,
          (fact, original, repository, actualReplay) => callersRecovery({ fact, original, selected: repository.repoId, targets, requestedScope: scopeOf(paths).scope, requestedBudget: bounds, live: isLive === true, workspace: others, offline: isOffline, replay: actualReplay, digest: deps.digest, redaction, validate: (args) => callersInput.safeParse(args).success && callersRecipe.safeParse(args).success }),
          true, { tool: "callers", select, page, expect, sourceFor: (fact) => ({ kind: "workspace", fact }) },
        );
      }
      return answer(
        selected, true,
        (onStale, repository) =>
          deps.impact.callers({
            repo: repository.path,
            repoId: repository.repoId,
            ...atRevision(requested, isLive, onStale),
            targets: targets as CallersTarget[],
            ...scopeOf(paths),
            ...budgetOf(bounds),
            signal: ctx.mcpReq.signal,
          }),
        mode,
        renderImpact,
        (fact, original, repository) => callersRecovery({ fact, original, selected: repository.repoId, targets, requestedScope: scopeOf(paths).scope, requestedBudget: bounds, live: isLive === true, workspace: undefined, offline: undefined, replay: undefined, digest: deps.digest, redaction, validate: (args) => callersInput.safeParse(args).success && callersRecipe.safeParse(args).success }),
        false, { tool: "callers", select, page, expect, sourceFor: (fact) => ({ kind: "local", fact }) },
      );
    },
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: `File consumers: static/reexport/dynamic/type imports, users and unresolved names. details deduplicates paths, retaining categories and original positions; users without a module category are additional. Import edges do not prove declaration use; unresolved names prove neither dependencies nor affected files. TypeScript includes alias/barrel edges and exported test consumers; omitted live tests yield partial. Use for moves/renames/deletions/export changes; ye_ast_callers traces declarations/reached entrypoints. ${COMPLETENESS}`,
      inputSchema: compactInput(liveSchema({ repo, revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope, mode: responseModeSchema }, ["revision"])),
      outputSchema: compactOutput(IMPORTERS_OUTPUT, "importers"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, files, scope: paths, mode }, ctx) =>
      answer(
        selected, true,
        (onStale, repository) => deps.impact.importers({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        mode,
        renderImporters,
        undefined, false, undefined, "importers",
      ),
  );

  server.registerTool(
    "ye_ast_outline",
    {
      title: "Shape of files",
      description: `Indexed declaration spans/imports, without source. Use to choose source ranges; read known ranges directly. Unavailable files report cuts, not empty lists. Match revision/live to inspected source. ${COMPLETENESS}`,
      inputSchema: compactInput(liveSchema({ repo, revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope, mode: responseModeSchema }, ["revision"])),
      outputSchema: compactOutput(OUTLINE_OUTPUT, "outline"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, files, scope: paths, mode }, ctx) =>
      answer(
        selected, true,
        (onStale, repository) => deps.outline.outline({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        mode,
        renderOutline,
        undefined, false, undefined, "outline",
      ),
  );

  server.registerTool(
    "ye_ast_workspace",
    {
      title: "Repositories a workspace names",
      description: `Find outward names, candidate repos with match basis/evidence, and unserved names. Covers HTTP hosts/prefixes, config URLs, messaging, dependency coordinates, remotes and registries. Use to choose clones; no downloads or guessed unresolved targets. Trusted persisted remotes may refresh; offline prevents it. For traversal set workspace on ye_ast_callers/ye_ast_impact; ye_ast_decisions finds config gaps. ${COMPLETENESS}`,
      inputSchema: compactInput(liveSchema({
        repo,
        revision: workspaceRevision,
        live: z.literal(true).optional(),
        offline,
        scope,
        repos: workspaceRepos,
        gateways,
        mode: responseModeSchema,
      }, ["revision"])),
      outputSchema: compactOutput(WORKSPACE_OUTPUT, "workspace"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, offline: isOffline, scope: paths, repos, gateways: requestedGateways, mode }, ctx) =>
      answer(
        selected, false,
        async (_onStale, repository) => {
          const read = await deps.workspace.outwardNames({
            repo: { path: repository.path, id: repository.repoId, ...(isLive ? { live: true as const } : requested === undefined ? {} : { revision: requested }) },
            ...(repos === undefined ? {} : { repos: repos.map(askedRepository) }),
            ...(requestedGateways === undefined ? {} : { gateways: requestedGateways }),
            ...(isOffline === undefined ? {} : { offline: isOffline }),
            ...scopeOf(paths),
            signal: ctx.mcpReq.signal,
          });
          return read.ok ? { ok: true, value: { ...read.value, fact: withoutRepositories(read.value.fact) } } : read;
        },
        mode,
        renderWorkspace,
        undefined, false, undefined, "workspace",
      ),
  );

  server.registerTool(
    "ye_ast_decisions",
    {
      title: "Gaps a workspace leaves to the user",
      description: `Workspace config gaps: membership/identity, gateways, trust and remotes; evidence-backed options and rule-based recommendations. Some require free text. Use before ye-ast init --workspace or to build a config form. Suggestions concern configuration, not code quality/change approval. Reads workspace repos; writes nothing. ${COMPLETENESS}`,
      inputSchema: compactInput(liveSchema({ repo, revision: workspaceRevision, live: z.literal(true).optional(), offline, scope, repos: workspaceRepos, gateways, mode: responseModeSchema }, ["revision"])),
      outputSchema: compactOutput(DECISIONS_OUTPUT, "decisions"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, offline: isOffline, scope: paths, repos, gateways: requestedGateways, mode }, ctx) =>
      answer(
        selected, false,
        (_onStale, repository) =>
          deps.decisions.decisions({
            repo: { path: repository.path, id: repository.repoId, ...(isLive ? { live: true as const } : requested === undefined ? {} : { revision: requested }) },
            ...(repos === undefined ? {} : { repos: repos.map(askedRepository) }),
            ...(requestedGateways === undefined ? {} : { gateways: requestedGateways }),
            ...(isOffline === undefined ? {} : { offline: isOffline }),
            ...scopeOf(paths),
            signal: ctx.mcpReq.signal,
          }),
        mode,
        renderDecisions,
        undefined, false, undefined, "decisions",
      ),
  );

  return server;
}
