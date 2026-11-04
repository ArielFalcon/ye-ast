import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
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
import type { WorkspaceRepositoryRequest } from "../core/ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries, WorkspaceRefresh, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import { renderDecisions, renderEntrypointMap, renderFault, renderImpact, renderImporters, renderOutline, renderRefresh, renderStale, renderStructuredImporters, renderWorkspace, renderWorkspaceImpact, type Detail } from "./render.ts";

/** The key of the result's `_meta` that carries a stale notice. */
export const LIVE_META = "ye-ast/live";
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
  /** The one repository every tool reads: its root and the stable name recorded in every snapshot. */
  repository: { path: string; repoId: string };
}

const COMPLETENESS = "Returns snapshot-backed evidence and explicit complete, partial or unknown status within the declared scope.";

/** Exhaustive over the facts contract: every cut kind needs actionable guidance. */
export const CUT_GUIDANCE: Readonly<Record<Cut["kind"], string>> = {
  "unresolved-link": "a possible reference or cross-repository target could not be resolved, or several repositories match. Inspect the listed evidence if relevant; keep the target unknown unless code or a user declaration establishes it. A removed declaration's remaining names are potential references, not proven breakages.",
  "no-extractor": "the engine has no applicable extractor for this file or construct. Read the relevant source directly; repeating the same query adds no coverage.",
  "not-exported": "the snapshot omitted this path. Inspect the stated export limit or exclusion; evidence under that path is unavailable in this answer.",
  depth: "the walk reached budget.depth. Increase that bound if more levels matter, or query one boundary symbol with ye_ast_callers.",
  hub: "a symbol exceeded budget.hubFanIn and was not expanded. Increase that bound if its callers matter; querying it alone does not remove the bound.",
  "caller-budget": "inspect the cut's context: a walk may exhaust budget.expansions, while snapshot export may exhaust a host-set entry or byte budget. Adjust the applicable bound or narrow the question; walk bounds do not fix export limits.",
  "node-cap": "the walk reached its node cap. Query fewer targets, or narrow scope only if excluding that code is acceptable.",
  deadline: "the work exceeded its deadline. A smaller question may complete; retry unchanged only if the condition was transient.",
  section: "a composite section could not be completed. Inspect its repository, read status and reason; other sections retain their own evidence and limits. Retry only when the cause can change.",
};

const cutGuidance = Object.entries(CUT_GUIDANCE)
  .map(([kind, guidance]) => `  - ${kind}: ${guidance}`)
  .join("\n");

/** Common interpretation rules and a short routing guide, also useful before individual tools are loaded. */
export function instructionsFor(repository: McpDeps["repository"]): string {
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
- Local queries default to HEAD. Use revision, or head on impact, to select a committed snapshot. For trusted working-tree edits use live: true instead; it excludes revision/head, workspace and offline. Impact still requires base.
- Without workspace, callers and impact cover the bound repository only. workspace: {} enables the persisted workspace when available; workspace.repos supplies other local clones explicitly. workspace and decisions also accept repos directly. Untrusted repositories cannot supply their own workspace defaults. Repositories not included are not read, and missing clones are not downloaded.
- Workspace queries use each repository's snapshot and trust declaration. A trusted repository's persisted remote may be refreshed into an engine-owned mirror; request arguments cannot authorize a new remote. offline: true prevents refresh and reads local clones. Inspect remote freshness, revision resolution and section/read limits before relying on a cross-repository result.
- Local evidence paths are relative to the bound root; workspace evidence is relative to its owning repository. Use repositoryRoots (printed as repository root lines) to locate declared clones, never the process working directory. Evidence refers to the recorded snapshot; local files may have different content or line numbers.

Coverage and detail:
- complete means complete within inputs.declaredScope, supported languages/frameworks and any change selection; partial retains known results with cuts; unknown has a reason and never means no impact. Composite sections and reads can have their own limits. Read these before concluding that nothing depends on a change.
- scope.include/exclude changes coverage, not just presentation; exclude wins. Interpretation files such as manifests remain available under include but can be excluded explicitly. TypeScript test files are not indexed. Component template binding uses are not resolved; inspect relevant tests or templates separately.
- On impact, changed selects diff paths that seed the walk while callers elsewhere within scope remain eligible. For example, changed: ["src/api/**"] limits the change being investigated; scope would also limit where its consequences can be found. A changed glob matching no changed path is an error.
- Start with detail: "summary" (default). It groups results and cut locations; impact/callers summarize deeper symbols and seeds. Use detail: "full" for omitted names or evidence locations. This changes text detail, not coverage or walk budgets; a focused callers query is useful when only one branch needs investigation.
- Text carries the answer. Structured content normally carries its envelope and transport metadata, without the value or cut locations. full: true additionally includes the entire structured fact. On importers it replaces the text listing with a short acknowledgment; other tools leave text unchanged; use it only when that payload is needed.

- On importers, summary counts disjoint file groups when shorter; detail: "full" lists each related path once per target and marks overlapping unresolved name matches.

Reading evidence and faults:
- A span such as src/a.ts:3-9 identifies a declaration. In an incoming walk, via src/b.ts:B.user at 14, 21 identifies dependency locations in the reached symbol's own file; a reference is not necessarily a call or a place requiring edits. A relation with no line has no recorded call-site location. confidence describes edge resolution, not change safety; fan-in counts calling or instantiating places.
- Cuts may be grouped in summary, listed at the end or described under their workspace repository. Unknown sections name their reasons. For no-project, the source lacks a package.json that places it in a project, so route classification is unknown.
- isError names a fault, not an empty fact. For unknown-symbol use an actual declaration or a line range; for unknown-change-path correct changed. For live-requires-trusted use a committed revision unless the user declares trust through ye-ast init --trust trusted; repository content cannot grant trust.

Act on a cut only when its missing information matters:
${cutGuidance}`;
}

const revision = z.string().min(1).optional().describe("Committed Git revision for the bound repository; HEAD when omitted. Match it to the source you inspect.");
const live = z
  .boolean()
  .optional()
  .describe("Read staged, unstaged and untracked working-tree changes. Requires user-declared trusted mode. Omit revision/head, workspace and offline when true; impact still needs base.");
const offline = z
  .boolean()
  .optional()
  .describe("Prevent remote refresh and read local clones for a workspace query, including workspace/decisions. Otherwise trusted repositories may refresh persisted remotes. Has no effect on local-only queries. Omit this field with live: true.");

/** `live` and the revision it replaces are exclusive. */
const excludes = (field: string) => (value: { live?: boolean | undefined } & Record<string, unknown>): boolean => !(value.live === true && value[field] !== undefined);

/** The revision to read, or the working tree with the callback that learns of a change after the answer. */
function atRevision(requested: string | undefined, isLive: boolean | undefined, onStale: (notice: LiveStaleNotice) => void): { revision: string; live?: undefined } | { live: true; onStale: (notice: LiveStaleNotice) => void; revision?: undefined } {
  return isLive === true ? { live: true, onStale } : { revision: requested ?? DEFAULT_REVISION };
}
const count = z.int().positive();

/** Exhaustive over the fields, so a bound added to `ImpactBudget` fails to compile until it is described here. */
const BUDGET_FIELDS: Readonly<Record<WalkBoundsField, z.ZodOptional<z.ZodNumber>>> = {
  depth: count.optional().describe("Maximum incoming dependency depth; seeds are depth 0. A stopped branch reports a depth cut."),
  hubFanIn: count.optional().describe("Maximum fan-in for expanding a symbol; larger hubs report a hub cut."),
  expansions: count.optional().describe("Maximum symbols expanded while following incoming dependencies; exhaustion reports a caller-budget cut."),
};
const budget = z
  .strictObject(BUDGET_FIELDS)
  .optional()
  .describe("Optional walk bounds; these three bounds are unset by default. Set them to limit traversal work; a stopped branch reports a cut. detail changes presentation instead.");

const workspaceRepo = z.strictObject({
  path: z.string().min(1).describe("Root path of an existing local Git clone; this does not clone a repository or authorize remote refresh."),
  id: z
    .string()
    .min(1)
    .optional()
    .describe("Stable repository id, not a path; defaults to the root directory name. Supply the same id for a clone and its worktrees when they represent one repository."),
  revision: z.string().min(1).optional().describe("Revision requested for this repository. Without one, local reads use HEAD; refreshed reads report the revision-resolution rule and pinned SHA."),
});

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
  .describe("Enable cross-repository traversal. Omit for a local answer; {} uses eligible persisted repositories/gateways, or only the bound repository when none exist. An explicit repos list selects other clones. Includes incoming call-site links; impact also follows outgoing links. Uses committed snapshots and excludes live: true.");

/** `live` reads the working tree of one repository; a workspace reads committed snapshots. */
const withoutWorkspace = (value: { live?: boolean | undefined; workspace?: unknown }): boolean => !(value.live === true && value.workspace !== undefined);

const detail = z
  .enum(["summary", "full"] satisfies Detail[])
  .optional()
  .describe("Text detail only. summary (default) groups results and cut locations; impact/callers show depth 0-1 and summarize deeper symbols and seeds, workspace/decisions group names or gaps. full lists all available items and cut locations. Neither expands traversal nor adds the structured fact; use full: true for that. On importers, summary counts disjoint file groups when shorter; full lists related paths with pending matches grouped separately.");

const full = z
  .boolean()
  .optional()
  .describe("Include the entire fact in structuredContent, duplicating information available in text. Usually omit; detail set to full expands text instead. On importers this replaces the text listing with a short acknowledgment; other tools leave text unchanged. It does not extend coverage.");

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
  .describe("Coverage restriction using repository-relative globs; all paths when omitted, exclude wins. include retains configuration needed to interpret sources; exclude can remove it too. Callers and entrypoints outside scope are unknown. For shorter text use detail; on impact use changed to select seeds without excluding callers.");

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

const evidence = z.looseObject({ path: z.string(), line: z.int() });

/** The fact envelope every tool answers; `value` is the family's own shape, rendered in the text content. */
const FACT_OUTPUT = z.looseObject({
  schema: z.string().describe("The schema version of the fact."),
  snapshot: z.looseObject({ repo: z.string(), kind: z.enum(["sha", "live"]) }).describe("The revision (sha) or working-tree state (live) the fact read."),
  producer: z.looseObject({ name: z.string(), version: z.string() }),
  inputs: z
    .looseObject({ trust: z.enum(TRUST_MODES), declaredScope: z.looseObject({ languages: z.array(z.string()).readonly(), frameworks: z.array(z.string()).readonly() }) })
    .describe("What decided the fact; declaredScope is what completeness is relative to."),
  evidence: z.array(evidence).readonly().describe("Repo-relative path:line locations the fact rests on."),
  status: z.enum(["complete", "partial", "unknown"]),
  value: z.unknown().optional().describe("The complete structured payload, included only with full: true when status is not unknown."),
  cuts: z
    .array(z.looseObject({ kind: z.string(), at: z.array(z.string()).readonly() }))
    .readonly()
    .optional()
    .describe("Where a partial answer stops, and why."),
  reason: z.string().optional().describe("Why an unknown answer cannot tell."),
  repositoryRoots: z
    .array(z.strictObject({ repo: z.string(), path: z.string() }))
    .readonly()
    .optional()
    .describe("Local clone paths for the repository ids in a workspace answer. Transport metadata, outside the fact; evidence still refers to the recorded snapshot."),
  freshness: z
    .array(z.looseObject({ repo: z.string(), url: z.string(), freshness: z.looseObject({ status: z.enum(["verified", "unverified"]), reason: z.enum(["failed", "deadline", "offline", "refresh-in-progress"]).optional(), lastVerifiedAt: z.string().optional(), detail: z.string().optional() }) }))
    .readonly()
    .optional()
    .describe("Present only when the query refreshed a declared remote: per remote, whether this query verified it and, when it did not, why and what git said. A sibling of the fact, never a field of it."),
  resolution: z
    .array(
      z.looseObject({
        repo: z.string(),
        asked: z.string().optional(),
        step: z.enum(["explicit", "trigger-line", "default-branch", "revision-unavailable"]),
        consulted: z.array(z.looseObject({ branch: z.string(), sha: z.string().optional() })).readonly(),
        tie: z.array(z.string()).readonly().optional(),
        sha: z.string().optional(),
      }),
    )
    .readonly()
    .optional()
    .describe("Present only when the query refreshed a declared remote: per repository, what was asked, the rule step that chose its sha, the refs consulted and the sha pinned. A sibling of the fact, never a field of it."),
  live: z
    .looseObject({ stateId: z.string(), changed: z.array(z.string()).readonly() })
    .optional()
    .describe("Present only when the working tree moved after this answer was built: the state the answer reflects and the paths that changed since. A sibling of the fact, never a field of it."),
});

function askedRepository(requested: { path: string; id?: string | undefined; revision?: string | undefined }): WorkspaceRepositoryRequest {
  return {
    path: requested.path,
    ...(requested.id === undefined ? {} : { id: requested.id }),
    ...(requested.revision === undefined ? {} : { revision: requested.revision }),
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

/** The envelope a tool answers by default: the fact without the family's `value` and without the cut places the text already prints. */
function withoutPayload<V>(fact: Fact<V>): Record<string, unknown> {
  const { value: _value, cuts: _cuts, ...envelope } = fact as Fact<V> & { value?: unknown; cuts?: readonly Cut[] };
  return envelope;
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
  const { redaction, repository } = deps;
  const server = new McpServer({ name: "ye-ast", version: deps.version }, { instructions: instructionsFor(repository) });

  /**
   * The fact is redacted first and the text is rendered from the redacted fact, so neither carries a secret. The
   * structured content carries the envelope alone unless `full` asks for the whole fact: the text is what an agent
   * reads, and duplicating the fact cost it a multiple of the answer for a payload only a host consumes. A workspace
   * read answers its fact with the refresh beside it, attached as sibling keys of the structured content and never inside
   * the fact, so the fact's bytes depend only on what it read (ADR-0016 decision 4). The text opens with the same
   * response-level statuses it carries, so an answer read as text alone still knows what the refresh could not confirm.
   */
  async function answer<V, F extends { kind: string; detail: string }>(
    query: (onStale: (notice: LiveStaleNotice) => void) => Promise<Result<Fact<V> | FactRead<V>, F>>,
    render: (fact: Fact<V>) => string,
    full: boolean,
  ): Promise<CallToolResult> {
    try {
      let moved: LiveStaleNotice | undefined;
      const result = await query((notice) => void (moved = notice));
      if (!result.ok) return failure(result.fault);
      const read = "fact" in result.value ? result.value : { fact: result.value };
      const fact = redaction.redactValue(read.fact) as Fact<V>;
      const repositoryRoots = read.repositoryRoots === undefined ? undefined : redaction.redactValue(read.repositoryRoots) as FactRead<V>["repositoryRoots"];
      const refresh = read.refresh === undefined ? undefined : (redaction.redactValue(read.refresh) as WorkspaceRefresh);
      const stale = moved === undefined ? undefined : (redaction.redactValue(moved) as LiveStaleNotice);
      const sidecar = [...(stale === undefined ? [] : [renderStale(stale)]), ...(refresh === undefined ? [] : renderRefresh(refresh)), ...(repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`)];
      return {
        content: [{ type: "text", text: [...sidecar, render(fact)].join("\n") }],
        structuredContent: {
          ...(full ? fact : withoutPayload(fact)),
          ...(repositoryRoots === undefined ? {} : { repositoryRoots }),
          ...(refresh === undefined ? {} : { freshness: refresh.freshness, resolution: refresh.resolution }),
          ...(stale === undefined ? {} : { live: stale }),
        } as unknown as Record<string, unknown>,
        ...(stale !== undefined && { _meta: { [LIVE_META]: stale } }),
      };
    } catch (error) {
      return failure({ kind: "internal-fault", detail: redaction.redactError(error) });
    }
  }

  /**
   * A fault is an `isError` result: the text names its kind on the first line, and `_meta` carries the same shape for a
   * client that branches on it, never `structuredContent`, which is the fact envelope this tool declares as its output.
   */
  function failure(fault: { kind: string; detail: string } | ImpactFault): CallToolResult {
    return {
      isError: true,
      content: [{ type: "text", text: redaction.redact(renderFault(fault)) }],
      _meta: { [FAULT_META]: redaction.redactValue(fault) },
    };
  }

  server.registerTool(
    "ye_ast_entrypoints",
    {
      title: "Entrypoints of a revision",
      description: `Lists supported HTTP routes, UI routes, message listeners and scheduled jobs with handler locations. Use to orient in a repository or locate where a request, message or job is handled. To trace what depends on a known handler use ye_ast_callers; to inspect consequences of a diff use ye_ast_impact. ${COMPLETENESS}`,
      inputSchema: z.strictObject({ revision, live, scope, detail, full }).refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, scope: paths, detail: listing, full: whole }, ctx) =>
      answer(
        (onStale) => deps.entrypoints.map({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        (fact) => renderEntrypointMap(fact, listing),
        whole === true,
      ),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: `Traces incoming dependents of changed declarations from the merge base of base and head to head, and reports affected entrypoints plus entrypoints added, removed or altered. Use for a diff; base is required and head defaults to HEAD. Use live for trusted local edits, or changed to select diff paths without excluding callers elsewhere within scope. With workspace, also follows incoming cross-repository call sites and what the change sends onward. Use ye_ast_callers when the question concerns existing symbols without a diff; results inform investigation, not change approval. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({
          base: z.string().min(1).describe("Required comparison revision, usually the destination branch (for example main). The diff starts at its merge base with head; it is not necessarily a direct base-to-head diff."),
          head: z.string().min(1).optional().describe("Committed revision holding the change; HEAD when omitted. Omit with live: true."),
          live,
          offline,
          scope,
          changed: globs.describe("Diff-path globs selecting which changes seed traversal; all changed paths when omitted. Callers outside changed remain eligible within scope. This does not restrict consequence coverage like scope does. A glob matching no changed path is an error."),
          budget,
          detail,
          workspace,
          full,
        })
        .refine(excludes("head"), "live excludes head")
        .refine(excludes("offline"), "live excludes offline")
        .refine(withoutWorkspace, "live excludes workspace"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ base, head, live: isLive, offline: isOffline, scope: paths, changed, budget: requested, detail: listing, workspace: others, full: whole }, ctx) => {
      const crossing = workspaceOf(others);
      if (crossing !== undefined) {
        return answer(
          () =>
            deps.workspaceImpact.ofChange({
              repo: { path: repository.path, id: repository.repoId },
              ...crossing,
              base,
              head: head ?? DEFAULT_REVISION,
              ...(isOffline === undefined ? {} : { offline: isOffline }),
              ...(changed === undefined ? {} : { changed }),
              ...scopeOf(paths),
              ...budgetOf(requested),
              signal: ctx.mcpReq.signal,
            }),
          (fact) => renderWorkspaceImpact(fact, listing),
          whole === true,
        );
      }
      return answer(
        (onStale) => {
          const at = atRevision(head, isLive, onStale);
          return deps.impact.ofChange({ repo: repository.path, repoId: repository.repoId, base, ...(at.live ? at : { head: at.revision }), ...(changed === undefined ? {} : { changed }), ...scopeOf(paths), ...budgetOf(requested), signal: ctx.mcpReq.signal });
        },
        (fact) => renderImpact(fact, listing),
        whole === true,
      );
    },
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: `Traces incoming dependents of existing declarations or line ranges and reports the entrypoints that reach them, with dependency locations. Use when the starting symbols or ranges are known and no diff is needed. targets accepts names or inclusive line ranges; names match their final segment and may select several declarations in one file. A missing declaration is an error. With workspace, follows incoming cross-repository call-site links; use ye_ast_impact for a diff and its outgoing links. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, offline, targets: z.array(target).min(1).describe("The symbols or line ranges to start from."), scope, budget, detail, workspace, full })
        .refine(excludes("revision"), "live excludes revision")
        .refine(excludes("offline"), "live excludes offline")
        .refine(withoutWorkspace, "live excludes workspace"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, offline: isOffline, targets, scope: paths, budget: bounds, detail: listing, workspace: others, full: whole }, ctx) => {
      const crossing = workspaceOf(others);
      if (crossing !== undefined) {
        return answer(
          () =>
            deps.workspaceImpact.callers({
              repo: { path: repository.path, id: repository.repoId, revision: requested ?? DEFAULT_REVISION },
              ...crossing,
              targets: targets as CallersTarget[],
              ...(isOffline === undefined ? {} : { offline: isOffline }),
              ...scopeOf(paths),
              ...budgetOf(bounds),
              signal: ctx.mcpReq.signal,
            }),
          (fact) => renderWorkspaceImpact(fact, listing),
          whole === true,
        );
      }
      return answer(
        (onStale) =>
          deps.impact.callers({
            repo: repository.path,
            repoId: repository.repoId,
            ...atRevision(requested, isLive, onStale),
            targets: targets as CallersTarget[],
            ...scopeOf(paths),
            ...budgetOf(bounds),
            signal: ctx.mcpReq.signal,
          }),
        (fact) => renderImpact(fact, listing),
        whole === true,
      );
    },
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: `For each target, reports distinct related files as importers, additional users without an import edge, and unresolved-only candidates without a resolved link. Files with resolved links may also have unresolved name matches; detailed text annotates that overlap without repeating paths. Use to investigate file moves, renames, deletions or export changes. An import edge does not prove a declaration is used. Unresolved name matches do not prove dependencies or additional affected files. Summary counts groups when shorter; detail: "full" lists paths; full: true returns the original overlapping lists and cuts in structuredContent with a short text acknowledgment. For declaration-level incoming traversal and reached entrypoints use ye_ast_callers; this tool answers file-level relationships. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope, detail, full })
        .refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, files, scope: paths, detail: listing, full: whole }, ctx) =>
      answer(
        (onStale) => deps.impact.importers({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        (fact) => whole === true ? renderStructuredImporters(fact) : renderImporters(fact, listing),
        whole === true,
      ),
  );

  server.registerTool(
    "ye_ast_outline",
    {
      title: "Shape of files",
      description: `Returns indexed declarations with line spans and imports for each requested file, without returning source text. Use when that structure helps choose source ranges to read; read a known relevant range directly. A file the index cannot describe is reported as a cut, not an empty list. Match revision or live to the source you will inspect. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope, detail, full })
        .refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, files, scope: paths, detail: listing, full: whole }, ctx) =>
      answer(
        (onStale) => deps.outline.outline({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        (fact) => renderOutline(fact, listing),
        whole === true,
      ),
  );

  server.registerTool(
    "ye_ast_workspace",
    {
      title: "Repositories a workspace names",
      description: `Lists outward names stated by repositories, candidate repositories that serve them with matching basis and evidence, and names no included repository serves. Names include HTTP hosts/prefixes, configuration URLs, message destinations, dependency coordinates, remotes and registries. Use to discover which clones a cross-repository investigation needs; it does not download missing clones or establish an unresolved target by guesswork. Trusted repositories may refresh persisted remotes; offline prevents refresh. For traversal use workspace on ye_ast_callers or ye_ast_impact; for configuration gaps use ye_ast_decisions. ${COMPLETENESS}`,
      inputSchema: z.strictObject({
        revision,
        offline,
        scope,
        repos: workspaceRepos,
        gateways,
        detail,
        full,
      }),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, offline: isOffline, scope: paths, repos, gateways: requestedGateways, detail: listing, full: whole }, ctx) =>
      answer(
        async () => {
          const read = await deps.workspace.outwardNames({
            repo: { path: repository.path, id: repository.repoId, ...(requested === undefined ? {} : { revision: requested }) },
            ...(repos === undefined ? {} : { repos: repos.map(askedRepository) }),
            ...(requestedGateways === undefined ? {} : { gateways: requestedGateways }),
            ...(isOffline === undefined ? {} : { offline: isOffline }),
            ...scopeOf(paths),
            signal: ctx.mcpReq.signal,
          });
          return read.ok ? { ok: true, value: { ...read.value, fact: withoutRepositories(read.value.fact) } } : read;
        },
        (fact) => renderWorkspace(fact, listing),
        whole === true,
      ),
  );

  server.registerTool(
    "ye_ast_decisions",
    {
      title: "Gaps a workspace leaves to the user",
      description: `Lists workspace configuration gaps requiring user input, evidence-backed options and rule-based recommendations; some gaps allow only a user-supplied value. Use to prepare workspace/trust configuration or a form before ye-ast init --workspace. Gaps concern repository membership, identity, gateways, trust or remote resolution; recommendations are configuration suggestions, not judgments of code or proposed changes. Reads repositories using the workspace rules and writes no configuration. ${COMPLETENESS}`,
      inputSchema: z.strictObject({ revision, offline, scope, repos: workspaceRepos, gateways, detail, full }),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, offline: isOffline, scope: paths, repos, gateways: requestedGateways, detail: listing, full: whole }, ctx) =>
      answer(
        () =>
          deps.decisions.decisions({
            repo: { path: repository.path, id: repository.repoId, ...(requested === undefined ? {} : { revision: requested }) },
            ...(repos === undefined ? {} : { repos: repos.map(askedRepository) }),
            ...(requestedGateways === undefined ? {} : { gateways: requestedGateways }),
            ...(isOffline === undefined ? {} : { offline: isOffline }),
            ...scopeOf(paths),
            signal: ctx.mcpReq.signal,
          }),
        (fact) => renderDecisions(fact, listing),
        whole === true,
      ),
  );

  return server;
}
