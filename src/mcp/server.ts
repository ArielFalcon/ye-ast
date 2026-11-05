import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { repositoryCatalog, type RepositoryBinding } from "./repository-targeting.ts";
import { responseModeSchema, type ResponseMode, type ResponseRenderer } from "./presentation.ts";
import { entrypointRecovery, callersRecovery, impactRecovery, type Recovery } from "./recovery.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import { isWorkspaceReplayContext } from "../core/domain/topology/workspace-replay.ts";
import { FULL_OBJECT_ID_PATTERN, isFullObjectId } from "../core/domain/shared/revision.ts";
import type { ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import { TRUST_MODES, WALK_BOUND_FIELDS, type WalkBoundsField } from "../core/domain/shared/fact.ts";
import type { Cut, Fact } from "../core/domain/shared/fact.ts";
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

const COMPLETENESS = "Returns snapshot-backed evidence and explicit complete, partial or unknown status within the declared scope.";

/** Exhaustive over the facts contract: every cut kind needs actionable guidance. */
export const CUT_GUIDANCE: Readonly<Record<Cut["kind"], string>> = {
  "unresolved-link": "a possible reference or cross-repository target could not be resolved, or several repositories match. Inspect the listed evidence if relevant; keep the target unknown unless code or a user declaration establishes it. A larger walk budget cannot resolve an ambiguous target or dynamic URL. A removed declaration's remaining names are potential references, not proven breakages.",
  "no-extractor": "the engine has no applicable extractor for this file or construct. Read the relevant source directly; repeating the same query adds no coverage.",
  "not-exported": "the snapshot omitted this path. Inspect the stated export limit or exclusion; evidence under that path is unavailable in this answer.",
  depth: "the symbol or module walk reached budget.depth. Increase that bound if more levels matter, query one boundary symbol with ye_ast_callers, or inspect direct module consumers with ye_ast_importers.",
  hub: "a symbol or module exceeded budget.hubFanIn and was not expanded. Increase that bound if its callers matter; querying it alone does not remove the bound.",
  "caller-budget": "inspect the cut's context: a walk may exhaust budget.expansions, counted separately for symbols and modules with the module allowance shared by base and head; snapshot export may exhaust a host-set entry or byte budget. Adjust the applicable bound or narrow the question; walk bounds do not fix export limits.",
  "node-cap": "the walk reached its node cap. Query fewer targets, or narrow scope only if excluding that code is acceptable.",
  deadline: "the work exceeded its deadline. A smaller question may complete; retry unchanged only if the condition was transient.",
  section: "a composite section could not be completed. Inspect its repository, read status and reason; other sections retain their own evidence and limits. Retry only when the cause can change.",
};

const cutGuidance = Object.entries(CUT_GUIDANCE)
  .map(([kind, guidance]) => `  - ${kind}: ${guidance}`)
  .join("\n");

/** Common interpretation rules and a short routing guide, also useful before individual tools are loaded. */
export function instructionsFor(repository: McpDeps["repository"], available: readonly string[] = [repository.repoId]): string {
  return `ye-ast provides read-only, deterministic facts about code, git and declared contracts for ${repository.path} (id ${repository.repoId}). Use these facts to investigate structure and consequences; they do not judge code quality or certify a proposed change. Choose a tool for information you still need; reuse an answer that already covers the question and snapshot.

Choose by question:
- ye_ast_entrypoints: where are HTTP/UI routes, message listeners and scheduled jobs handled?
- ye_ast_callers: what depends on an existing declaration or line range, and which entrypoints reach it? Add workspace for incoming links from other repositories.
- ye_ast_impact: what depends on a diff from a merge base, and which entrypoints changed? Supply base; add workspace for incoming links and what the change sends onward.
- ye_ast_importers: which files import or otherwise link to a file, and which have unresolved name matches? Useful for file moves and export changes.
- ye_ast_outline: what declarations, line spans and imports does a file have? Use it to choose source ranges when needed; read a known relevant range directly.
- ye_ast_workspace: which outward names do the supplied repositories state, and which repositories may serve them? Use it when cross-repository membership is unclear.
- ye_ast_decisions: which workspace configuration gaps need user input, and which options have evidence? Use for configuration or before ye-ast init --workspace; recommendations do not settle the user's choices and the tool writes nothing.

Snapshots and repositories:
- Declared repository IDs: ${available.join(", ")}. Set repo to select one; omission uses ${repository.repoId}. Availability grants neither trust nor workspace membership. IDs are exact and are not paths.
- Local queries default to HEAD. Use revision, or head on impact, to select a committed snapshot. For trusted working-tree edits use live: true instead; it excludes revision/head; local-only live also excludes offline. Impact still requires base. Workspace operations may mix live and committed repositories and use offline with live.
- Without workspace, callers and impact cover the selected repository only. workspace: {} enables the persisted workspace when available; workspace.repos supplies other local clones explicitly. workspace and decisions also accept repos directly. Untrusted repositories cannot supply their own workspace defaults. Repositories not included are not read, and missing clones are not downloaded.
- Workspace queries use each repository's snapshot choice and current trust declaration; their captures are not one atomic instant. Live repositories are never refreshed from their remotes. A trusted repository's persisted remote may be refreshed into an engine-owned mirror; request arguments cannot authorize a new remote. offline: true prevents refresh and reads local clones. Inspect remote freshness, revision resolution and section/read limits before relying on a cross-repository result.
- Local evidence paths are relative to the selected root; workspace evidence is relative to its owning repository. Use repositoryRoots (printed as repository root lines) to locate declared clones, never the process working directory. For a foreign coordinate choose its declared owner with repo and its recorded snapshot; an undeclared owner requires an updated host registration or an instance bound there. For a SHA use revision and the recorded file or symbol; symbols can match multiple declarations. A live follow-up is a fresh read: compare head and stateId, and never treat the commit alone as the old working tree. Base-side modules use the recorded merge-base SHA. Evidence refers to the recorded snapshot; local files may have different content or line numbers.

Coverage and detail:
- complete means complete within inputs.declaredScope, supported languages/frameworks and any change selection; partial retains known results with cuts; unknown has a reason and never means no impact. Composite sections and reads can have their own limits. Read these before concluding that nothing depends on a change.
- scope.include/exclude changes coverage, not just presentation; exclude wins. Interpretation files such as manifests remain available under include but can be excluded explicitly. TypeScript test files are not indexed. Component template binding uses are not resolved; inspect relevant tests or templates separately.
- On impact, changed selects diff paths that seed the walk while callers elsewhere within scope remain eligible. For example, changed: ["src/api/**"] limits the change being investigated; scope would also limit where its consequences can be found. A changed glob matching no changed path is an error.
- Select mode directly: "summary" (default) identifies findings and limitations; "details" adds recorded explanatory evidence and locations; "full" returns the complete redacted public fact in structuredContent and a brief contextual guide in text. Text modes return a strict receipt with mode, status, snapshot and reason only when unknown. Modes do not change coverage, snapshots or traversal. A client may expose both text and structured content to a model.
- budget limits traversal work, not response length. depth counts incoming dependency levels, not hops between services. To reproduce an impact answer for more detail, use its recovery recipe and recorded merge base. Workspace recipes preserve the declaration and snapshot vector; live replay captures again and compares head and stateId. A live answer can change between calls.
- When useful, impact/callers text includes an investigation guide adapted to the recorded data: full JSON paths are relative to structuredContent, origin indexes join within one walk, and workspace links use IDs rather than display numbers. Follow its snapshot and coverage context when choosing the next query. Fault responses explain an applicable correction or the prerequisite to inspect before retrying.

Reading evidence and faults:
- A span such as src/a.ts:3-9 identifies a declaration. In an incoming walk, via src/b.ts:B.user at 14, 21 identifies dependency locations in the reached symbol's own file; a reference is not necessarily a call or a place requiring edits. A relation with no line has no recorded call-site location. confidence describes edge resolution, not change safety; fan-in counts calling or instantiating places.
- A shared via heading applies to the declarations indented beneath it; locations still belong to their file. Workspace links locate both ends; reach lists the displayed link numbers in recorded order, nearest to the change first. It does not assert an unrecorded path within a repository. An entrypoint's verified origin is one recorded association, not a complete call chain or a nearest-origin ranking; mode: "full" preserves all recorded associations in structuredContent.
- Cuts may be grouped in summary, listed at the end or described under their workspace repository. Unknown sections name their reasons. For no-project, the source lacks a package.json that places it in a project, so route classification is unknown.
- isError names a fault, not an empty fact. For unknown-symbol use an actual declaration or a line range; for unknown-change-path correct changed. For live-requires-trusted use a committed revision unless the user declares trust through ye-ast init --trust trusted; repository content cannot grant trust.

Act on a cut only when its missing information matters:
${cutGuidance}`;
}

const repo = z.string().min(1).optional().describe("Declared repository ID; omission uses the launch repository.");
const revision = z.string().min(1).optional().describe("Committed Git revision for the selected repository; HEAD when omitted. Match it to the source you inspect.");
const workspaceRevision = z.string().regex(/\S/).optional().describe("Committed Git revision for the selected repository; HEAD when omitted.");
const live = z
  .boolean()
  .optional()
  .describe("Read staged, unstaged and untracked working-tree changes. Requires user-declared trusted mode. Omit revision/head when true; local-only operations also exclude offline. Impact still needs base.");
const offline = z
  .boolean()
  .optional()
  .describe("Prevent remote refresh and read local clones for a workspace query, including workspace/decisions. Otherwise trusted repositories may refresh persisted remotes. Has no effect on local-only queries. Local-only live queries exclude this field; workspace operations may combine them.");

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
  depth: count.optional().describe("Maximum incoming depth in each symbol or module walk; seeds are depth 0. Counts dependency levels, not hops between services. A stopped branch reports a depth cut."),
  hubFanIn: count.optional().describe("Maximum fan-in for expanding a symbol or module; larger hubs report a hub cut."),
  expansions: count.optional().describe("Maximum expansions per walk: symbols separately from modules; the module allowance spans base and head. Exhaustion reports a caller-budget cut."),
};
const budget = z
  .strictObject(BUDGET_FIELDS)
  .optional()
  .describe("Optional walk bounds; these three bounds are unset by default. Set them to limit traversal work, not response bytes or tokens; a stopped branch reports a cut. mode changes presentation instead.");

const workspaceRepo = liveSchema({
  path: z.string().regex(/\S/).describe("Root path of an existing local Git clone; this does not clone a repository or authorize remote refresh."),
  id: z
    .string()
    .regex(/\S/)
    .optional()
    .describe("Stable repository id, not a path; defaults to the root directory name. Supply the same id for a clone and its worktrees when they represent one repository."),
  revision: z.string().regex(/\S/).optional().describe("Revision requested for this repository. Without one, local reads use HEAD; refreshed reads report the revision-resolution rule and pinned SHA."),
  live: z.literal(true).optional(),
}, ["revision"]);

const gateways = z
  .array(z.strictObject({ prefix: z.string().min(1).describe("The gateway prefix a call carries, such as a first path segment."), repo: z.string().min(1).describe("The repository id it routes to.") }))
  .min(1)
  .optional()
  .describe("Optional user-known gateway mappings. A declared prefix overrides route-overlap inference; do not invent a mapping to resolve ambiguity.");

const workspaceRepos = z
  .array(workspaceRepo)
  .min(1)
  .optional()
  .describe("Other local clones; an explicit nonempty list replaces persisted workspace membership. Omit to use eligible persisted defaults. The answer states the membership source.");

const workspace = z
  .strictObject({
    repos: z
      .array(workspaceRepo)
      .min(1)
      .optional()
      .describe("Other local clones; an explicit nonempty list replaces persisted workspace membership. Omit to use eligible defaults saved by ye-ast init --workspace."),
    gateways,
  })
  .optional()
  .describe("Enable cross-repository traversal. Omit for a local answer; {} uses eligible persisted repositories/gateways, or only the selected repository when none exist. An explicit repos list selects other clones. Includes incoming call-site links; impact also follows outgoing links. Each repository may select a committed revision or a trusted live capture. Captures do not represent one atomic instant.");

const globs = z
  .array(z.string().refine(isValidGlob, "a glob is relative to the repository root, with / separators and no empty, . or .. segment"))
  .min(1)
  .optional();
const scope = z
  .strictObject({
    include: globs.describe("Only paths matching one of these globs; every path when omitted."),
    exclude: globs.describe("Paths matching one of these globs are left out, even when included."),
  })
  .optional()
  .describe("Coverage restriction using repository-relative globs; all paths when omitted, exclude wins. include retains configuration needed to interpret sources; exclude can remove it too. Callers and entrypoints outside scope are unknown. For shorter text use mode: summary; on impact use changed to select seeds without excluding callers.");

const entrypointInput = liveSchema({ repo, revision, live, scope, mode: responseModeSchema }, ["revision"]);
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

const file = z.string().min(1).describe("Repository-relative path of the file.");

const target = z.union([
  z
    .strictObject({
      file,
      symbol: z
        .string()
        .min(1)
        .describe("The declaration's name: a function, class or constant by its name, a member as Class.member. Only the part after the last dot is matched in the file, so every declaration of that name in it, overloads included, is a start."),
    })
    .describe("A declaration by name."),
  z
    .strictObject({ file, start: count, end: count })
    .refine(({ start, end }) => end >= start, "end must not precede start")
    .describe("A file's lines, 1-based, inclusive."),
]);

const replaySchema = z.strictObject({
  version: z.literal(1),
  declaration: z.string().regex(/^ws-r1:[0-9a-f]{64}$/),
  snapshots: z.array(z.discriminatedUnion("kind", [z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("sha"), sha: pinnedRevision }), z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("live"), head: pinnedRevision, stateId: z.string().regex(/\S/) })])).meta({ uniqueItems: true }).describe("Echo the actual snapshot vector in repository ID order, with each ID appearing once."),
}).refine(isWorkspaceReplayContext);
const callersShape = { repo, revision, live, offline, targets: z.array(target).min(1), scope, budget, mode: responseModeSchema, workspace, replay: replaySchema.optional() };
const replayRequiresWorkspace = { if: { required: ["replay"] }, then: { required: ["workspace"] } };
const callersInput = liveSchema(callersShape, ["revision"])
  .refine((value) => (value.replay === undefined || value.workspace !== undefined) && !(value.workspace !== undefined && (value.live === false || ("revision" in value && typeof value.revision === "string" && !/\S/.test(value.revision)) || ("head" in value && typeof value.head === "string" && !/\S/.test(value.head)))) && !(value.live === true && value.workspace === undefined && value.offline !== undefined))
  .meta({ allOf: [...["revision"].map((field) => ({ not: { properties: { live: { const: true } }, required: ["live", field] } })), replayRequiresWorkspace, { if: { required: ["workspace"] }, then: { properties: { live: { const: true }, revision: { pattern: "\\S" }, head: { pattern: "\\S" } } } }, { if: { required: ["live", "offline"], properties: { live: { const: true } } }, then: { required: ["workspace"] } }] });
const impactInput = liveSchema({
  repo,
  base: z.string().min(1).describe("Required comparison revision, usually the destination branch (for example main). The diff starts at its merge base with head; it is not necessarily a direct base-to-head diff."),
  head: z.string().min(1).optional().describe("Committed revision holding the change; HEAD when omitted. Omit with live: true."),
  live, offline, scope,
  changed: globs.describe("Diff-path globs selecting which changes seed traversal; all changed paths when omitted. Callers outside changed remain eligible within scope. This does not restrict consequence coverage like scope does. A glob matching no changed path is an error."),
  budget, mode: responseModeSchema, workspace, replay: replaySchema.optional(),
}, ["head"])
  .refine((value) => (value.replay === undefined || value.workspace !== undefined) && !(value.workspace !== undefined && (value.live === false || ("revision" in value && typeof value.revision === "string" && !/\S/.test(value.revision)) || ("head" in value && typeof value.head === "string" && !/\S/.test(value.head)))) && !(value.live === true && value.workspace === undefined && value.offline !== undefined))
  .meta({ allOf: [...["head"].map((field) => ({ not: { properties: { live: { const: true } }, required: ["live", field] } })), replayRequiresWorkspace, { if: { required: ["workspace"] }, then: { properties: { live: { const: true }, revision: { pattern: "\\S" }, head: { pattern: "\\S" } } } }, { if: { required: ["live", "offline"], properties: { live: { const: true } } }, then: { required: ["workspace"] } }] });
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
export const ENTRYPOINTS_OUTPUT = outputFor(shapes.entrypoints, recoverySchema);
export const IMPACT_OUTPUT = outputFor(shapes.impact, impactRecoverySchema);
export const CALLERS_OUTPUT = outputFor(shapes.impact, callersRecoverySchema);
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
  ): Promise<CallToolResult> {
    try {
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
      const recoveryText = recovery === undefined ? [] : [`recovery: ${JSON.stringify(recovery)}`];
      const roots = local ? [{ repo: repository.repoId, path: repository.path }] : read.repositoryRoots;
      const repositoryRoots = roots === undefined
        ? undefined
        : redaction.redactValue(roots) as FactRead<V>["repositoryRoots"];
      const refresh = read.refresh === undefined ? undefined : (redaction.redactValue(read.refresh) as WorkspaceRefresh);
      const stale = moved === undefined ? undefined : (redaction.redactValue(moved) as LiveStaleNotice);
      const workspaceLive = read.workspaceLive === undefined ? undefined : redaction.redactValue([...read.workspaceLive].sort((a, b) => compareText(a.repo, b.repo)).map((item) => item.kind === "staleness-unavailable" ? { ...item, cause: { ...item.cause, detail: /[\\/]/.test(item.cause.detail) ? "[path omitted]" : item.cause.detail } } : item)) as NonNullable<FactRead<V>["workspaceLive"]>;
      const meta = { ...(stale === undefined ? {} : { [LIVE_META]: stale }), ...(workspaceLive === undefined ? {} : { [WORKSPACE_LIVE_META]: workspaceLive }) };
      if (mode === "full") {
        return {
          content: [{ type: "text", text: [
            `status: ${fact.status}\nfull structured result: structuredContent`,
            render(fact, mode),
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
        content: [{ type: "text", text: [...sidecar, render(fact, mode), ...recoveryText, ...(local ? (repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`) : [])].join("\n") }],
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
  function failure(fault: { kind: string; detail: string; stage?: "workspace-replay" } | ImpactFault | WorkspaceFault): CallToolResult {
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
      description: `Lists supported HTTP routes, UI routes, message listeners and scheduled jobs with handler locations. Use to orient in a repository or locate where a request, message or job is handled. To trace what depends on a known handler use ye_ast_callers; to inspect consequences of a diff use ye_ast_impact. ${COMPLETENESS}`,
      inputSchema: entrypointInput,
      outputSchema: ENTRYPOINTS_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, scope: paths, mode }, ctx) =>
      answer(
        selected, true,
        (onStale, repository) => deps.entrypoints.map({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        mode,
        renderEntrypointMap,
        (fact, original, repository) => entrypointRecovery(fact, original, repository.repoId, scopeOf(paths).scope, isLive === true, deps.digest, redaction, (args) => entrypointInput.safeParse(args).success && recipeArguments.safeParse(args).success),
      ),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: `Traces incoming dependents of changed declarations from the merge base of base and head to head, and reports affected entrypoints plus entrypoints added, removed or altered. Use for a diff; base is required and head defaults to HEAD. Use live for trusted local edits, or changed to select diff paths without excluding callers elsewhere within scope. With workspace, also follows incoming cross-repository call sites and what the change sends onward. Use ye_ast_callers when the question concerns existing symbols without a diff; results inform investigation, not change approval. ${COMPLETENESS}`,
      inputSchema: impactInput,
      outputSchema: IMPACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, base, head, live: isLive, offline: isOffline, scope: paths, changed, budget: requested, mode, workspace: others, replay }, ctx) => {
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
          true,
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
      );
    },
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: `Traces incoming dependents of existing declarations or line ranges and reports the entrypoints that reach them, with dependency locations. Use when the starting symbols or ranges are known and no diff is needed. targets accepts names or inclusive line ranges; names match their final segment and may select several declarations in one file. A missing declaration is an error. With workspace, follows incoming cross-repository call-site links; use ye_ast_impact for a diff and its outgoing links. ${COMPLETENESS}`,
      inputSchema: callersInput,
      outputSchema: CALLERS_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, offline: isOffline, targets, scope: paths, budget: bounds, mode, workspace: others, replay }, ctx) => {
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
          true,
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
      );
    },
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: `For each target, reports distinct related files as static importers, reexporters, dynamic importers, type importers, additional users without a module edge, and unresolved-only candidates without a resolved link. A file is listed in its first matching group; the structured fact retains overlapping module forms. Files with resolved links may also have unresolved name matches; detailed text annotates that overlap without repeating paths. Use to investigate file moves, renames, deletions or export changes. An import edge does not prove a declaration is used. Static TypeScript resolution includes alias and barrel module edges. Revision queries include exported test consumers; a live mirror that omits them remains partial. Unresolved name matches do not prove dependencies or additional affected files. For declaration-level incoming traversal and reached entrypoints use ye_ast_callers; this tool answers file-level relationships. ${COMPLETENESS}`,
      inputSchema: liveSchema({ repo, revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope, mode: responseModeSchema }, ["revision"]),
      outputSchema: IMPORTERS_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, files, scope: paths, mode }, ctx) =>
      answer(
        selected, true,
        (onStale, repository) => deps.impact.importers({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        mode,
        renderImporters,
      ),
  );

  server.registerTool(
    "ye_ast_outline",
    {
      title: "Shape of files",
      description: `Returns indexed declarations with line spans and imports for each requested file, without returning source text. Use when that structure helps choose source ranges to read; read a known relevant range directly. A file the index cannot describe is reported as a cut, not an empty list. Match revision or live to the source you will inspect. ${COMPLETENESS}`,
      inputSchema: liveSchema({ repo, revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope, mode: responseModeSchema }, ["revision"]),
      outputSchema: OUTLINE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ repo: selected, revision: requested, live: isLive, files, scope: paths, mode }, ctx) =>
      answer(
        selected, true,
        (onStale, repository) => deps.outline.outline({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        mode,
        renderOutline,
      ),
  );

  server.registerTool(
    "ye_ast_workspace",
    {
      title: "Repositories a workspace names",
      description: `Lists outward names stated by repositories, candidate repositories that serve them with matching basis and evidence, and names no included repository serves. Names include HTTP hosts/prefixes, configuration URLs, message destinations, dependency coordinates, remotes and registries. Use to discover which clones a cross-repository investigation needs; it does not download missing clones or establish an unresolved target by guesswork. Trusted repositories may refresh persisted remotes; offline prevents refresh. For traversal use workspace on ye_ast_callers or ye_ast_impact; for configuration gaps use ye_ast_decisions. ${COMPLETENESS}`,
      inputSchema: liveSchema({
        repo,
        revision: workspaceRevision,
        live: z.literal(true).optional(),
        offline,
        scope,
        repos: workspaceRepos,
        gateways,
        mode: responseModeSchema,
      }, ["revision"]),
      outputSchema: WORKSPACE_OUTPUT,
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
      ),
  );

  server.registerTool(
    "ye_ast_decisions",
    {
      title: "Gaps a workspace leaves to the user",
      description: `Lists workspace configuration gaps requiring user input, evidence-backed options and rule-based recommendations; some gaps allow only a user-supplied value. Use to prepare workspace/trust configuration or a form before ye-ast init --workspace. Gaps concern repository membership, identity, gateways, trust or remote resolution; recommendations are configuration suggestions, not judgments of code or proposed changes. Reads repositories using the workspace rules and writes no configuration. ${COMPLETENESS}`,
      inputSchema: liveSchema({ repo, revision: workspaceRevision, live: z.literal(true).optional(), offline, scope, repos: workspaceRepos, gateways, mode: responseModeSchema }, ["revision"]),
      outputSchema: DECISIONS_OUTPUT,
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
      ),
  );

  return server;
}
