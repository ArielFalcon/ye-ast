import { z } from "zod";
import { recoveryControlShapeFor, recoveryControlIssues, recoveryControlConstraintsFor } from "./evidence-schema.ts";
import { crossField, type CrossField } from "./compact-schema.ts";
import { responseModeSchema, type ToolFamily } from "./presentation.ts";
import { isWorkspaceReplayContext } from "../core/domain/topology/workspace-replay.ts";
import { FULL_OBJECT_ID_PATTERN, isFullObjectId } from "../core/domain/shared/revision.ts";
import type { WalkBoundsField } from "../core/domain/shared/fact.ts";
import { isValidGlob } from "../core/domain/shared/scope.ts";
import { ENTRYPOINT_KINDS, mixesTargetKinds, type TRACE_BOUND_FIELDS, type TraceTarget } from "../core/ports/trace-queries.port.ts";

/**
 * The input contracts of the eight query families. Each family has a semantic schema, which carries only the fields that
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
  .describe("Read trusted staged, unstaged and untracked changes; not with revision/head or local offline. Impact still requires base.");
export const offline = z
  .boolean()
  .optional()
  .describe("With workspace: skip refreshing trusted persisted remotes (live allowed). Without workspace: no effect; forbidden with live.");

/** A violated cross-field constraint, typed by `constraint` and anchored at the field a caller must change. */
type FieldIssue = { constraint: string; path: (string | number)[]; message: string };

/** Report each violated constraint as its own path-bearing issue instead of one blanket refinement failure. */
function reportIssues<T>(issuesOf: (value: T) => FieldIssue[]) {
  return (value: T, ctx: z.RefinementCtx) => {
    for (const { constraint, path, message } of issuesOf(value)) ctx.addIssue({ code: "custom", path, message, params: { constraint } });
  };
}

/** The field schemas already report malformed controls; the refinement adds only the cross-field constraints. */
const controlIssues = (tool: "entrypoints" | "callers" | "impact", value: { select?: unknown; page?: unknown; workspace?: unknown }) =>
  recoveryControlIssues(tool, value).filter(({ constraint }) => constraint !== "selection-shape" && constraint !== "page-shape");

/** Runtime validation and tool discovery share the same working-tree exclusions. */
function liveSchema<S extends z.ZodRawShape>(shape: S, fields: readonly (keyof S & string)[]) {
  let schema = z.strictObject(shape);
  for (const field of fields) {
    schema = schema.refine((value: Record<string, unknown>) => !(value["live"] === true && value[field] !== undefined), { message: `live reads the working tree; omit ${field} or live`, path: [field], params: { constraint: "live-excludes" } });
  }
  return schema.meta(crossField(...fields.map(liveExclusion)));
}
function liveExclusion(field: string): CrossField {
  return { dependentSchemas: { [field]: { properties: { live: { const: false } } } } };
}
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
  .describe("Optional traversal bounds, unset by default. Limits work, not result size; stopped branches report cuts.");

/** Exhaustive over the trace's own bounds; a caller-count bound has no outbound meaning, so the strict object refuses it. */
const TRACE_BUDGET_FIELDS: Readonly<Record<(typeof TRACE_BOUND_FIELDS)[number], z.ZodOptional<z.ZodNumber>>> = {
  depth: count.optional().describe("Deepest call level whose body is read (roots=0); a step stopped there yields a depth cut."),
  expansions: count.optional().describe("Max bodies read across the whole trace; once spent, every later step yields a caller-budget cut."),
};
const traceBudget = z
  .strictObject(TRACE_BUDGET_FIELDS)
  .optional()
  .describe("Optional bounds on how far the trace follows calls, unset by default. Limits work, not result size; stopped steps report cuts.");

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
  .describe("Cross-repo traversal: omit=local; {}=eligible persisted repos and gateways (else the selected repo only); repos supplies other clones. Incoming links; impact adds outgoing. Captures are per repo and not atomic.");

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
  .describe("Coverage globs over repo-relative paths; omitted=all, exclude wins; include keeps manifests readable, exclude can remove them. Callers and entrypoints outside scope are unknown. Use mode to shorten output.");

const file = z.string().min(1).describe("Repo-relative file path.");

export const target = z.union([
  z
    .strictObject({
      file,
      symbol: z
        .string()
        .min(1)
        .describe("Declaration or dotted Class.member path, as ye_ast_outline nests it; matches every declaration whose path ends with it, including overloads. A bare name matches at any depth."),
    })
    .describe("Match by declaration name."),
  z
    .strictObject({ file, start: count, end: count })
    .refine(({ start, end }) => end >= start, { message: "end must not precede start", path: ["end"] })
    .describe("File line range, 1-based inclusive; end >= start."),
]);

const focusSelector = z.union([
  z.strictObject({ file, symbol: z.string().min(1).describe("Dotted path as ye_ast_outline nests it, e.g. Class.member; matches every declaration whose path ends with it at whole names. A bare name matches at any depth.") }).describe("Focus by name."),
  z.strictObject({ file, line: count.describe("1-based line; selects the innermost declaration holding it.") }).describe("Focus by line."),
]);

// Scope permits line terminators inside a segment; inspect every character and require the absolute end of input.
const recipeGlob = z.string().refine(isValidGlob).meta({ pattern: "^(?![\\s\\S]*(?:^|/)\\.{0,2}(?:/|(?![\\s\\S])))[^\\\\]+(?![\\s\\S])" });
const recipeScope = z.strictObject({ include: z.array(recipeGlob).min(1).optional(), exclude: z.array(recipeGlob).min(1).optional() });
const pinnedRevision = z.string().refine(isFullObjectId, "a full commit object ID").meta({ pattern: FULL_OBJECT_ID_PATTERN });

const replaySchema = z.strictObject({
  version: z.literal(1),
  declaration: z.string().regex(/^ws-r1:[0-9a-f]{64}$/),
  snapshots: z.array(z.discriminatedUnion("kind", [z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("sha"), sha: pinnedRevision }), z.strictObject({ repo: z.string().regex(/\S/), kind: z.literal("live"), head: pinnedRevision, stateId: z.string().regex(/\S/) })])).meta({ uniqueItems: true }).describe("Echo actual snapshots in repo-ID order, one per ID."),
}).refine(isWorkspaceReplayContext, { message: "echo snapshots in repo-ID order, one per ID", path: ["snapshots"] });

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
function traversalIssues(value: { replay?: unknown; workspace?: unknown; live?: unknown; offline?: unknown; revision?: unknown; head?: unknown }): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (value.replay !== undefined && value.workspace === undefined) issues.push({ constraint: "replay-requires-workspace", path: ["replay"], message: "replay requires workspace" });
  if (value.workspace !== undefined) {
    if (value.live === false) issues.push({ constraint: "workspace-live", path: ["live"], message: "with workspace, live is true or omitted" });
    for (const field of ["revision", "head"] as const) {
      const ref = value[field];
      if (typeof ref === "string" && !/\S/.test(ref)) issues.push({ constraint: "workspace-blank-ref", path: [field], message: `with workspace, ${field} must not be blank` });
    }
  }
  if (value.live === true && value.workspace === undefined && value.offline !== undefined) issues.push({ constraint: "offline-requires-workspace", path: ["offline"], message: "offline only applies with workspace; omit it for a local live read" });
  return issues;
}
/** `ref` is the family's own revision field; the other one is not a property of the strict root. */
const traversalConstraints = (ref: "revision" | "head"): CrossField => ({
  dependentRequired: { replay: ["workspace"] },
  dependentSchemas: {
    workspace: { properties: { live: { const: true }, [ref]: { pattern: "\\S" } } },
    offline: { anyOf: [{ required: ["workspace"] }, { properties: { live: { const: false } } }] },
  },
});

const mode = responseModeSchema;

// Field order is part of the published schema: `mode` keeps its original position in every shape.
const entrypointFields = { repo, revision, live, scope };
const callersFields = { repo, revision, live, offline, targets: z.array(target).min(1), scope, budget };
const impactFields = {
  repo,
  base: z.string().min(1).describe("Comparison ref, e.g. main. Diff starts at merge-base(base, head), not necessarily base itself."),
  head: z.string().min(1).optional().describe("Change commit/ref; default HEAD. Omit with live."),
  live, offline, scope,
  changed: globs.describe("Globs of the diff paths that start the walk (seeds); omitted=all changes. Callers elsewhere within scope remain eligible. Unlike scope, leaves consequence coverage intact. Unmatched globs are errors."),
  budget,
};
const crossingFields = { workspace, replay: replaySchema.optional() };

const changeEntry = z.union([z.string(), z.record(z.string(), z.unknown())]);
const hypothesis = z.strictObject({
  method: z.string().describe("HTTP method of the operation, e.g. GET."),
  path: z.string().describe("Operation path starting with /, as the contract states it, e.g. /owners/{id}."),
  target: z.string().describe("response: what the handler returns; request: what the handler reads from the body."),
  property: z.string().describe("Access path of the changed property from the body root; [] marks array elements, e.g. pets[].name."),
  change: z.union([changeEntry, z.array(changeEntry).min(1)]).describe("One change entry or a non-empty list on the same property: a name (nullable, optional, removed; required, non-nullable for a request) or an object ({renamed}, {type}, {values}, {wrapped}, {meaning})."),
});
const consequencesFields = {
  repo,
  workspace: workspace.describe("Repositories read with the selected one; omit for the persisted workspace (else the selected repo only); repos supplies other clones. Always prepared once per call."),
  scope,
  hypotheses: z.array(hypothesis).min(1).optional().describe("One or more written contract changes to answer together; exclusive with base."),
  base: z.string().min(1).optional().describe("Comparison ref: derives the hypotheses from the contract change between base and head and answers them at head. Exclusive with hypotheses."),
  head: z.string().min(1).optional().describe("Change commit/ref with base; default HEAD."),
  revision: z.string().min(1).optional().describe("Commit/ref for this repo with hypotheses; default HEAD."),
  live: z.boolean().optional().describe("With hypotheses: read trusted staged, unstaged and untracked changes; not with revision."),
};
/** Exactly one subject, and each of `head` and `revision` only beside the subject that reads it; `live` is excluded by `liveSchema`. */
function consequencesIssues(value: { hypotheses?: unknown; base?: unknown; head?: unknown; revision?: unknown }): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if ((value.hypotheses === undefined) === (value.base === undefined)) issues.push({ constraint: "one-subject", path: ["hypotheses"], message: "give exactly one of hypotheses and base" });
  if (value.head !== undefined && value.base === undefined) issues.push({ constraint: "head-requires-base", path: ["head"], message: "head applies to a change: give base, or omit head" });
  if (value.revision !== undefined && value.base !== undefined) issues.push({ constraint: "revision-requires-hypotheses", path: ["revision"], message: "revision applies to hypotheses; a change reads head" });
  return issues;
}
const consequencesConstraints: CrossField = crossField(liveExclusion("revision"), liveExclusion("base"), {
  dependentRequired: { head: ["base"] },
  dependentSchemas: { base: { not: { anyOf: [{ required: ["hypotheses"] }, { required: ["revision"] }] } } },
  if: { not: { required: ["base"] } },
  then: { required: ["hypotheses"] },
});
const consequencesInput = <S extends z.ZodRawShape>(shape: S) =>
  liveSchema({ ...consequencesFields, ...shape }, ["revision", "base"]).superRefine(reportIssues(consequencesIssues)).meta(consequencesConstraints);
const fileFields = { repo, revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope };
const outlineFields = {
  repo, revision, live,
  files: fileFields.files.optional().describe("Repository-relative paths to list whole; exclusive with focus."),
  focus: z.array(focusSelector).min(1).optional().describe("Instead of files: the declarations to answer, each with its containers, its subtree and the count of its file's declarations omitted, without imports."),
  scope,
};
const exactlyOneSubject = (value: { files?: unknown; focus?: unknown }): boolean => (value.files === undefined) !== (value.focus === undefined);
const ONE_SUBJECT = { message: "give exactly one of files and focus", path: ["files"], params: { constraint: "one-subject" } };
const subjectConstraint: CrossField = { dependentSchemas: { files: { not: { required: ["focus"] } } }, if: { not: { required: ["files"] } }, then: { required: ["focus"] } };
const traceTarget = z.union([
  ...target.options,
  z.strictObject({ kind: z.enum(ENTRYPOINT_KINDS), name: z.string().min(1) }).describe("Entrypoint as ye_ast_entrypoints names it; starts at its handler, a UI route at its component."),
]);
const traceFields = { repo, revision, live, targets: z.array(traceTarget).min(1).refine((targets) => !mixesTargetKinds(targets as TraceTarget[]), "declarations or entrypoints, not both").describe("Declarations, or entrypoints, to start from; every declaration a target selects is a root."), scope, budget: traceBudget };
const workspaceFields = { repo, revision: workspaceRevision, live: z.literal(true).optional(), offline, scope, repos: workspaceRepos, gateways };

/** The semantic inputs: what the analysis reads, without `mode`, `select`, `page` or `expect`. */
export const SEMANTIC_INPUTS = {
  entrypoints: liveSchema(entrypointFields, ["revision"]),
  callers: liveSchema({ ...callersFields, ...crossingFields }, ["revision"])
    .superRefine(reportIssues(traversalIssues))
    .meta(crossField(liveExclusion("revision"), traversalConstraints("revision"))),
  impact: liveSchema({ ...impactFields, ...crossingFields }, ["head"])
    .superRefine(reportIssues(traversalIssues))
    .meta(crossField(liveExclusion("head"), traversalConstraints("head"))),
  importers: liveSchema(fileFields, ["revision"]),
  outline: liveSchema(outlineFields, ["revision"]).refine(exactlyOneSubject, ONE_SUBJECT).meta(crossField(liveExclusion("revision"), subjectConstraint)),
  trace: liveSchema(traceFields, ["revision"]),
  workspace: liveSchema(workspaceFields, ["revision"]),
  decisions: liveSchema(workspaceFields, ["revision"]),
  contract_consequences: consequencesInput({}),
} satisfies Record<ToolFamily, z.ZodType>;

/** The inputs each original tool publishes and validates: the semantic fields plus presentation and recovery controls. */
export const TOOL_INPUTS = {
  entrypoints: liveSchema({ ...entrypointFields, mode, ...recoveryControlShapeFor("entrypoints") }, ["revision"])
    .superRefine(reportIssues((value) => controlIssues("entrypoints", value)))
    .meta(crossField(liveExclusion("revision"), recoveryControlConstraintsFor("entrypoints"))),
  callers: liveSchema({ ...callersFields, mode, ...crossingFields, ...recoveryControlShapeFor("callers") }, ["revision"])
    .superRefine(reportIssues((value) => controlIssues("callers", value)))
    .superRefine(reportIssues(traversalIssues))
    .meta(crossField(liveExclusion("revision"), traversalConstraints("revision"), recoveryControlConstraintsFor("callers"))),
  impact: liveSchema({ ...impactFields, mode, ...crossingFields, ...recoveryControlShapeFor("impact") }, ["head"])
    .superRefine(reportIssues((value) => controlIssues("impact", value)))
    .superRefine(reportIssues(traversalIssues))
    .meta(crossField(liveExclusion("head"), traversalConstraints("head"), recoveryControlConstraintsFor("impact"))),
  importers: liveSchema({ ...fileFields, mode }, ["revision"]),
  outline: liveSchema({ ...outlineFields, mode }, ["revision"]).refine(exactlyOneSubject, ONE_SUBJECT).meta(crossField(liveExclusion("revision"), subjectConstraint)),
  trace: liveSchema({ ...traceFields, mode }, ["revision"]),
  workspace: liveSchema({ ...workspaceFields, mode }, ["revision"]),
  decisions: liveSchema({ ...workspaceFields, mode }, ["revision"]),
  contract_consequences: consequencesInput({ mode }),
} satisfies Record<ToolFamily, z.ZodType>;

export type QueryName = `ye_ast_${ToolFamily}`;
export type SemanticArguments<F extends ToolFamily> = z.infer<(typeof SEMANTIC_INPUTS)[F]>;
export type ToolArguments<F extends ToolFamily> = z.infer<(typeof TOOL_INPUTS)[F]>;
type AnySemanticQuery = { [F in ToolFamily]: { name: `ye_ast_${F}`; arguments: SemanticArguments<F> } }[ToolFamily];
/** The queries compose runs; contract_consequences joins in U3 (RFC-0023 Delivery 3). */
export type SemanticQuery = Exclude<AnySemanticQuery, { name: "ye_ast_contract_consequences" }>;
export type ConsequencesQuery = Extract<AnySemanticQuery, { name: "ye_ast_contract_consequences" }>;
/** Every query a tool answers: the composed ones and contract_consequences. */
export type ToolQuery = SemanticQuery | ConsequencesQuery;
export type SemanticQueryOf<F extends ToolFamily> = Extract<AnySemanticQuery, { name: `ye_ast_${F}` }>;

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
  [F in Exclude<ToolFamily, "contract_consequences">]: { name: `ye_ast_${F}`; arguments: SemanticArguments<F> } & (F extends RecoverableFamily ? { expect?: `mcp-r1:${string}` } : { expect?: never });
}[Exclude<ToolFamily, "contract_consequences">]; // compose joins contract_consequences in U3 (RFC-0023 Delivery 3)
