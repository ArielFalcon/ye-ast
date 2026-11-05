import { z } from "zod";
import { recoveryControlShapeFor, validRecoveryControls, recoveryControlConstraintsFor } from "./evidence-schema.ts";
import { responseModeSchema, type ToolFamily } from "./presentation.ts";
import { isWorkspaceReplayContext } from "../core/domain/topology/workspace-replay.ts";
import { FULL_OBJECT_ID_PATTERN, isFullObjectId } from "../core/domain/shared/revision.ts";
import type { WalkBoundsField } from "../core/domain/shared/fact.ts";
import { isValidGlob } from "../core/domain/shared/scope.ts";

/**
 * The input contracts of the seven query families. Each family has a semantic schema, which carries only the fields that
 * decide what is analysed, and the full schema its tool publishes, built from the same fields plus the presentation and
 * recovery controls. Both share the same refinements, so a semantic query is valid exactly when the original tool would
 * accept it without controls.
 */

export const repo = z.string().min(1).optional().describe("Declared repo ID; default=launch repo.");
const revision = z.string().min(1).optional().describe("Commit/ref for this repo; default HEAD. Match inspected source.");
const workspaceRevision = z.string().regex(/\S/).optional().describe("Commit/ref for this repo; default HEAD.");
const live = z
  .boolean()
  .optional()
  .describe("Trusted staged/unstaged/untracked read. Excludes revision/head and local offline. Impact still requires base.");
export const offline = z
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
const liveExclusion = (field: string) => ({ not: { properties: { live: { const: true } }, required: ["live", field] } });
const count = z.int().positive();

/** Exhaustive over the fields, so a bound added to `ImpactBudget` fails to compile until it is described here. */
const BUDGET_FIELDS: Readonly<Record<WalkBoundsField, z.ZodOptional<z.ZodNumber>>> = {
  depth: count.optional().describe("Max incoming levels per symbol/module walk (seeds=0), not service hops. Stopping yields a depth cut."),
  hubFanIn: count.optional().describe("Max fan-in for symbol/module expansion; larger hubs yield a hub cut."),
  expansions: count.optional().describe("Max expansions per symbol/module walk; modules share the base+head allowance. Exhaustion: caller-budget cut."),
};
export const budget = z
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

export const workspace = z
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
export const scope = z
  .strictObject({
    include: globs.describe("Include matching paths; omitted=all."),
    exclude: globs.describe("Exclude matching paths, even if included."),
  })
  .optional()
  .describe("Repo-relative coverage globs; omitted=all, exclude wins. include retains interpretation files; exclude may remove them. Outside-scope callers/entrypoints are unknown. mode shortens output; impact changed limits seeds.");

const file = z.string().min(1).describe("Repo-relative file path.");

export const target = z.union([
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

// Scope permits line terminators inside a segment; inspect every character and require the absolute end of input.
const recipeGlob = z.string().refine(isValidGlob).meta({ pattern: "^(?![\\s\\S]*(?:^|/)\\.{0,2}(?:/|(?![\\s\\S])))[^\\\\]+(?![\\s\\S])" });
const recipeScope = z.strictObject({ include: z.array(recipeGlob).min(1).optional(), exclude: z.array(recipeGlob).min(1).optional() });
const pinnedRevision = z.string().refine(isFullObjectId).meta({ pattern: FULL_OBJECT_ID_PATTERN });

export const replaySchema = z.strictObject({
  version: z.literal(1),
  declaration: z.string().regex(/^ws-r1:[0-9a-f]{64}$/),
  snapshots: z.array(z.discriminatedUnion("kind", [z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("sha"), sha: pinnedRevision }), z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("live"), head: pinnedRevision, stateId: z.string().regex(/\S/) })])).meta({ uniqueItems: true }).describe("Echo actual snapshots in repo-ID order, one per ID."),
}).refine(isWorkspaceReplayContext);

/** The recovery recipes: the arguments a pinned replay reruns, validated beside the family's own schema. */
export const recipeArguments = z.union([
  z.strictObject({ repo: z.string().min(1), revision: pinnedRevision, scope: recipeScope.optional() }),
  z.strictObject({ repo: z.string().min(1), live: z.literal(true), scope: recipeScope.optional() }),
]);
const impactRecipeCommon = { repo: z.string().min(1), base: pinnedRevision, scope: recipeScope.optional(), changed: z.array(recipeGlob).min(1).optional(), budget };
export const impactRecipe = z.union([
  z.strictObject({ ...impactRecipeCommon, head: pinnedRevision }),
  z.strictObject({ ...impactRecipeCommon, live: z.literal(true) }),
  z.strictObject({ ...impactRecipeCommon, head: pinnedRevision, workspace: workspace.unwrap(), replay: replaySchema, offline }),
  z.strictObject({ ...impactRecipeCommon, live: z.literal(true), workspace: workspace.unwrap(), replay: replaySchema, offline }),
]);
const callerRecipeCommon = { repo: z.string().min(1), targets: z.array(target).min(1), scope: recipeScope.optional(), budget, };
export const callersRecipe = z.union([
  z.strictObject({ ...callerRecipeCommon, revision: pinnedRevision }),
  z.strictObject({ ...callerRecipeCommon, live: z.literal(true) }),
  z.strictObject({ ...callerRecipeCommon, revision: pinnedRevision, workspace: workspace.unwrap(), replay: replaySchema, offline }),
  z.strictObject({ ...callerRecipeCommon, live: z.literal(true), workspace: workspace.unwrap(), replay: replaySchema, offline }),
]);

/**
 * Callers and impact share their cross-field rule: replay requires workspace; a workspace read refuses `live: false` and
 * blank revisions; local live refuses `offline`.
 */
function validTraversalArguments(value: { replay?: unknown; workspace?: unknown; live?: unknown; offline?: unknown }): boolean {
  return (value.replay === undefined || value.workspace !== undefined) && !(value.workspace !== undefined && (value.live === false || ("revision" in value && typeof value.revision === "string" && !/\S/.test(value.revision)) || ("head" in value && typeof value.head === "string" && !/\S/.test(value.head)))) && !(value.live === true && value.workspace === undefined && value.offline !== undefined);
}
const replayRequiresWorkspace = { if: { required: ["replay"] }, then: { required: ["workspace"] } };
const traversalConstraints = [replayRequiresWorkspace, { if: { required: ["workspace"] }, then: { properties: { live: { const: true }, revision: { pattern: "\\S" }, head: { pattern: "\\S" } } } }, { if: { required: ["live", "offline"], properties: { live: { const: true } } }, then: { required: ["workspace"] } }];

const mode = responseModeSchema;

// Field order is part of the published schema: `mode` keeps its original position in every shape.
const entrypointFields = { repo, revision, live, scope };
const callersFields = { repo, revision, live, offline, targets: z.array(target).min(1), scope, budget };
const impactFields = {
  repo,
  base: z.string().min(1).describe("Comparison ref, e.g. main. Diff starts at merge-base(base, head), not necessarily base itself."),
  head: z.string().min(1).optional().describe("Change commit/ref; default HEAD. Omit with live."),
  live, offline, scope,
  changed: globs.describe("Diff-path seed globs; omitted=all changes. Callers elsewhere within scope remain eligible. Unlike scope, leaves consequence coverage intact. Unmatched globs are errors."),
  budget,
};
const crossingFields = { workspace, replay: replaySchema.optional() };
const fileFields = { repo, revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope };
const workspaceFields = { repo, revision: workspaceRevision, live: z.literal(true).optional(), offline, scope, repos: workspaceRepos, gateways };

/** The semantic inputs: what the analysis reads, without `mode`, `select`, `page` or `expect`. */
export const SEMANTIC_INPUTS = {
  entrypoints: liveSchema(entrypointFields, ["revision"]),
  callers: liveSchema({ ...callersFields, ...crossingFields }, ["revision"])
    .refine(validTraversalArguments)
    .meta({ allOf: [liveExclusion("revision"), ...traversalConstraints] }),
  impact: liveSchema({ ...impactFields, ...crossingFields }, ["head"])
    .refine(validTraversalArguments)
    .meta({ allOf: [liveExclusion("head"), ...traversalConstraints] }),
  importers: liveSchema(fileFields, ["revision"]),
  outline: liveSchema(fileFields, ["revision"]),
  workspace: liveSchema(workspaceFields, ["revision"]),
  decisions: liveSchema(workspaceFields, ["revision"]),
} satisfies Record<ToolFamily, z.ZodType>;

/** The inputs each original tool publishes and validates: the semantic fields plus presentation and recovery controls. */
export const TOOL_INPUTS = {
  entrypoints: liveSchema({ ...entrypointFields, mode, ...recoveryControlShapeFor("entrypoints") }, ["revision"])
    .refine((value) => validRecoveryControls("entrypoints", value))
    .meta({ allOf: [liveExclusion("revision"), ...recoveryControlConstraintsFor("entrypoints")] }),
  callers: liveSchema({ ...callersFields, mode, ...crossingFields, ...recoveryControlShapeFor("callers") }, ["revision"])
    .refine((value) => validRecoveryControls("callers", value))
    .refine(validTraversalArguments)
    .meta({ allOf: [liveExclusion("revision"), ...traversalConstraints, ...recoveryControlConstraintsFor("callers")] }),
  impact: liveSchema({ ...impactFields, mode, ...crossingFields, ...recoveryControlShapeFor("impact") }, ["head"])
    .refine((value) => validRecoveryControls("impact", value))
    .refine(validTraversalArguments)
    .meta({ allOf: [liveExclusion("head"), ...traversalConstraints, ...recoveryControlConstraintsFor("impact")] }),
  importers: liveSchema({ ...fileFields, mode }, ["revision"]),
  outline: liveSchema({ ...fileFields, mode }, ["revision"]),
  workspace: liveSchema({ ...workspaceFields, mode }, ["revision"]),
  decisions: liveSchema({ ...workspaceFields, mode }, ["revision"]),
} satisfies Record<ToolFamily, z.ZodType>;

export type QueryName = `ye_ast_${ToolFamily}`;
export type SemanticArguments<F extends ToolFamily> = z.infer<(typeof SEMANTIC_INPUTS)[F]>;
export type ToolArguments<F extends ToolFamily> = z.infer<(typeof TOOL_INPUTS)[F]>;
export type SemanticQuery = { [F in ToolFamily]: { name: `ye_ast_${F}`; arguments: SemanticArguments<F> } }[ToolFamily];
export type SemanticQueryOf<F extends ToolFamily> = Extract<SemanticQuery, { name: `ye_ast_${F}` }>;

/** The family a query name addresses. */
export function familyOf(name: QueryName): ToolFamily {
  return name.slice("ye_ast_".length) as ToolFamily;
}

/** The three families whose answers carry an `mcp-r1` recovery identity. */
export type RecoverableFamily = "entrypoints" | "impact" | "callers";
/**
 * One query of a composition: a semantic query, with an `mcp-r1` assertion only where the family already has recovery.
 * The runtime schema of `ye_ast_compose` (composition-schema.ts) must accept exactly these shapes.
 */
export type ComposeQuery = {
  [F in ToolFamily]: { name: `ye_ast_${F}`; arguments: SemanticArguments<F> } & (F extends RecoverableFamily ? { expect?: `mcp-r1:${string}` } : { expect?: never });
}[ToolFamily];
