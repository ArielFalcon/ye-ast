import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import { TRUST_MODES, WALK_BOUND_FIELDS, type WalkBoundsField } from "../core/domain/shared/fact.ts";
import type { Cut, Fact } from "../core/domain/shared/fact.ts";
import { isValidGlob, type ScopeRequest } from "../core/domain/shared/scope.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { CallersTarget, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { DEFAULT_REVISION } from "../core/ports/vcs.port.ts";
import type { WorkspaceRepositoryRequest } from "../core/ports/workspace-repos.port.ts";
import type { WorkspaceQueries, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import { renderEntrypointMap, renderFault, renderImpact, renderImporters, renderStale, renderWorkspace, renderWorkspaceImpact, type Detail } from "./render.ts";

/** The key of the result's `_meta` that carries a stale notice. */
export const LIVE_META = "ye-ast/live";

export interface McpDeps {
  version: string;
  /** Read query families only: nothing here can write, by type. */
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  workspace: WorkspaceQueries;
  workspaceImpact: WorkspaceImpactQueries;
  redaction: Redaction;
  /** The one repository every tool reads: its root and the stable name recorded in every snapshot. */
  repository: { path: string; repoId: string };
}

const COMPLETENESS = "The answer states its completeness: complete, partial with every cut, or unknown with its reason.";

/**
 * What to do at each kind of cut, exhaustive over `Cut["kind"]`, so a kind added to the facts contract fails to compile
 * until the agent is told how to act on it.
 */
export const CUT_GUIDANCE: Readonly<Record<Cut["kind"], string>> = {
  "unresolved-link":
    "places that name the symbol where the index could not tell what the name points at; open each place to decide. After a declaration was removed, the places listed under it still name it, so each one breaks. In a workspace answer it is also a call site whose target the code does not decide, or that two repositories serve equally: open it and decide which repository it calls.",
  "no-extractor": "a file ye-ast cannot read, such as a template, a style sheet or a language outside the declared scope; read it yourself when it bears on the task.",
  "not-exported": "a path the snapshot left out, so nothing under it was read; read it yourself when it bears on the task.",
  depth: "the walk stopped at the depth bound; raise budget.depth, or ask ye_ast_callers about the symbol at the cut.",
  hub: "a symbol with more callers than budget.hubFanIn was not expanded; raise the bound, or ask ye_ast_callers about it alone.",
  "caller-budget": "a bound stopped the work: on a walk it is budget.expansions, so raise it; on an entrypoint map it is the export budget the host set, so narrow the request with scope.",
  "node-cap": "the walk stopped at the node cap; narrow the request with scope or ask about fewer symbols.",
  deadline: "time ran out before the answer was whole; ask again, with a narrower scope when it repeats.",
  section: "one section of a composite answer could not be produced; the rest stands, and asking again may complete it.",
};

const cutGuidance = Object.entries(CUT_GUIDANCE)
  .map(([kind, guidance]) => `  - ${kind}: ${guidance}`)
  .join("\n");

/** What the agent reads at `initialize`: when each tool earns a call and how to read its answer. */
export const INSTRUCTIONS = `ye-ast answers verifiable facts about the code of the repository this server is bound to. Every answer is derived from code and git, carries path:line evidence and the snapshot it read, and states its completeness. Prefer it over guessing from search results whenever a decision depends on what reaches what.

When to call:
- ye_ast_entrypoints: when orienting in the repository, or to find the handler of an HTTP route, UI route, message listener or scheduled job.
- ye_ast_callers: before changing or deleting a function, method or class, or a range of lines, to learn what depends on it and which entrypoints it serves. Before deleting a declaration, ask here: once it is gone, ye_ast_impact can only list the places that still name it.
- ye_ast_importers: before moving, renaming or deleting a file, or changing what it exports.
- ye_ast_impact: after changing code and before reporting the work done or opening a pull request, with base set to the branch the change merges into; set live to true to include uncommitted edits. It repeats what ye_ast_callers already answered when the change stays inside the symbols asked about, so call ye_ast_impact once for the whole change before reporting it done, not once per symbol.
- ye_ast_workspace: when the work crosses repositories (a frontend calling services, a service calling another, a message between them). It lists the hosts, path prefixes, configuration URLs, dependency coordinates, remotes and registries the repository writes outward, the local repository that serves each one and the basis that says why, and the names no repository given serves. Pass the other clones with repos, then ask ye_ast_callers or ye_ast_impact again with workspace set to those repos so the call sites of the other repositories that land in what the walk reaches are joined. It makes no network request: a name nothing serves is the next clone to make with your own tools.
- workspace on ye_ast_callers and ye_ast_impact: when the symbol or change can be called from another repository (a route or a handler a frontend or another service calls). Pass the other local clones as workspace.repos (a path each; gateways only when a path prefix routes to a repository and the code does not say it). The answer adds the links from call sites in those repositories to what the walk reaches, what depends on those call sites in their own repository, the call sites that reached a declared service and matched none of its routes (unmatched), the ones that name a service no repository given serves (external), and every call site it could not decide as a cut. A repository not passed is not read: an answer without workspace says nothing about other repositories. Each repository is read at its HEAD or the revision given, under its own trust declaration; live cannot be combined with workspace.
- Every tool takes scope: include and exclude globs over repository-relative paths (exclude wins). A path outside the scope is not read at all, so callers and entrypoints through it are not known and the answer is complete only within the scope, which it names under its status. Use scope to keep one service or package of a repository apart; to shorten an answer, leave scope out and rely on detail.
- ye-ast does not say which templates bind one input or output of a component; search the templates for the binding's name.

Reading an answer:
- status "complete": the result is everything within the declared scope (inputs.declaredScope); code in languages or frameworks outside it is not covered.
- status "partial": the result stops at each listed cut; what lies past a cut is not known.
- status "unknown": ye-ast cannot tell, and the reason says why; never read it as "no impact".
- ye_ast_impact and ye_ast_callers list the symbols at depth 0 and 1 and count deeper ones per file; set detail to "full" when the deeper symbols themselves are needed.
- Every answer closes with a \`cuts:\` list holding every place past each cut, after the content; the status line only counts them by kind, so a partial answer read without its list reads as complete.
- An isError result names a fault kind. "live-requires-trusted" means the user must declare the repository trusted with \`ye-ast install --trust trusted\` before live can be used; answer from a revision meanwhile. "unknown-symbol" lists what the file declares; ask again with one of those names.

What to do at each kind of cut:
${cutGuidance}`;

const revision = z.string().min(1).optional().describe("Git revision to read; HEAD when omitted.");
const live = z
  .boolean()
  .optional()
  .describe("True reads the working tree, including staged, unstaged and untracked changes, instead of a revision; only for a repository declared trusted with `ye-ast install --trust trusted`. Excludes the revision.");

/** `live` and the revision it replaces are exclusive. */
const excludes = (field: string) => (value: { live?: boolean | undefined } & Record<string, unknown>): boolean => !(value.live === true && value[field] !== undefined);

/** The revision to read, or the working tree with the callback that learns of a change after the answer. */
function atRevision(requested: string | undefined, isLive: boolean | undefined, onStale: (notice: LiveStaleNotice) => void): { revision: string; live?: undefined } | { live: true; onStale: (notice: LiveStaleNotice) => void; revision?: undefined } {
  return isLive === true ? { live: true, onStale } : { revision: requested ?? DEFAULT_REVISION };
}
const count = z.int().positive();

/** Exhaustive over the fields, so a bound added to `ImpactBudget` fails to compile until it is described here. */
const BUDGET_FIELDS: Readonly<Record<WalkBoundsField, z.ZodOptional<z.ZodNumber>>> = {
  depth: count.optional().describe("The deepest level of callers reached."),
  hubFanIn: count.optional().describe("The most callers a symbol may have to be expanded."),
  expansions: count.optional().describe("The most symbols whose callers are followed."),
};
const budget = z
  .strictObject(BUDGET_FIELDS)
  .optional()
  .describe("Optional bounds on the walk; none applies unless set, and a bound that stops the walk is reported as a cut.");

const workspaceRepo = z.strictObject({
  path: z.string().min(1).describe("Path of the root of a local git repository."),
  id: z.string().min(1).optional().describe("The name its snapshot carries; the directory name when omitted. Never a path."),
  revision: z.string().min(1).optional().describe("The revision to read; HEAD when omitted."),
});

const gateways = z
  .array(z.strictObject({ prefix: z.string().min(1).describe("The gateway prefix a call carries, such as a first path segment."), repo: z.string().min(1).describe("The repository id it routes to.") }))
  .min(1)
  .optional()
  .describe("Prefixes the caller declares; a declared prefix overrides the one inferred from route overlap.");

const workspace = z
  .strictObject({
    repos: z.array(workspaceRepo).min(1).describe("Other local repositories to read beside the bound one."),
    gateways,
  })
  .optional()
  .describe("Other local repositories whose call sites to join to what the walk reaches: the answer then also holds the links from them, what depends on those call sites, and the call sites that match nothing. Each is read at its own snapshot under its own trust declaration; live excludes it.");

/** `live` reads the working tree of one repository; a workspace reads committed snapshots. */
const withoutWorkspace = (value: { live?: boolean | undefined; workspace?: unknown }): boolean => !(value.live === true && value.workspace !== undefined);

const detail = z
  .enum(["summary", "full"] satisfies Detail[])
  .optional()
  .describe("How much of the impacted symbols the text lists: summary (the default) lists depth 0 and 1 and counts deeper ones per file; full lists every one. The structured content always holds every one.");

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
  .describe("The part of the repository ye-ast reads, as globs over repository-relative paths; the whole repository when omitted. Paths outside it are not read, so callers and entrypoints through them are not known.");

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
  value: z.unknown().optional().describe("The answer; absent when status is unknown."),
  cuts: z
    .array(z.looseObject({ kind: z.string(), at: z.array(z.string()).readonly() }))
    .readonly()
    .optional()
    .describe("Where a partial answer stops, and why."),
  reason: z.string().optional().describe("Why an unknown answer cannot tell."),
});

function askedRepository(requested: { path: string; id?: string | undefined; revision?: string | undefined }): WorkspaceRepositoryRequest {
  return {
    path: requested.path,
    ...(requested.id === undefined ? {} : { id: requested.id }),
    ...(requested.revision === undefined ? {} : { revision: requested.revision }),
  };
}

/** The other repositories of a `workspace` parameter, as the workspace family asks for them. */
function workspaceOf(requested: z.infer<typeof workspace>): { repos: WorkspaceRepositoryRequest[]; gateways?: { prefix: string; repo: string }[] } | undefined {
  return requested === undefined ? undefined : { repos: requested.repos.map(askedRepository), ...(requested.gateways === undefined ? {} : { gateways: requested.gateways }) };
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
  const { redaction, repository } = deps;
  const server = new McpServer({ name: "ye-ast", version: deps.version }, { instructions: INSTRUCTIONS });

  /** The fact is redacted first and the text is rendered from the redacted fact, so neither carries a secret. */
  async function answer<V, F extends { kind: string; detail: string }>(
    query: (onStale: (notice: LiveStaleNotice) => void) => Promise<Result<Fact<V>, F>>,
    render: (fact: Fact<V>) => string,
  ): Promise<CallToolResult> {
    try {
      let moved: LiveStaleNotice | undefined;
      const result = await query((notice) => void (moved = notice));
      if (!result.ok) return failure(redaction.redact(renderFault(result.fault)));
      const fact = redaction.redactValue(result.value) as Fact<V>;
      const text = render(fact);
      const stale = moved === undefined ? undefined : (redaction.redactValue(moved) as LiveStaleNotice);
      return {
        content: [{ type: "text", text: stale === undefined ? text : `${renderStale(stale)}\n${text}` }],
        structuredContent: fact as unknown as Record<string, unknown>,
        ...(stale !== undefined && { _meta: { [LIVE_META]: stale } }),
      };
    } catch (error) {
      return failure(`fault: internal-fault\n${redaction.redactError(error)}`);
    }
  }

  server.registerTool(
    "ye_ast_entrypoints",
    {
      title: "Entrypoints of a revision",
      description: `Lists the entrypoints of the repository at a revision: HTTP routes, UI routes, message listeners and scheduled jobs, each with the handler's path:line. Use it to orient in the repository or to find where a request, message or job is handled. ${COMPLETENESS}`,
      inputSchema: z.strictObject({ revision, live, scope }).refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, scope: paths }, ctx) =>
      answer(
        (onStale) => deps.entrypoints.map({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        renderEntrypointMap,
      ),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: `What depends on the change from the merge base of base and head to head: the symbols that reach it, the entrypoints they serve and the entrypoints the change adds, removes or alters, with path:line evidence. Use it after changing code and before reporting the work done; live includes uncommitted edits. With workspace it also joins the call sites other local repositories make to the routes the change reaches. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({
          base: z.string().min(1).describe("The revision the change is read against."),
          head: z.string().min(1).optional().describe("The revision holding the change; HEAD when omitted."),
          live,
          scope,
          budget,
          detail,
          workspace,
        })
        .refine(excludes("head"), "live excludes head")
        .refine(withoutWorkspace, "live excludes workspace"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ base, head, live: isLive, scope: paths, budget: requested, detail: listing, workspace: others }, ctx) => {
      const crossing = workspaceOf(others);
      if (crossing !== undefined) {
        return answer(
          () =>
            deps.workspaceImpact.ofChange({
              repo: { path: repository.path, id: repository.repoId },
              ...crossing,
              base,
              head: head ?? DEFAULT_REVISION,
              ...scopeOf(paths),
              ...budgetOf(requested),
              signal: ctx.mcpReq.signal,
            }),
          (fact) => renderWorkspaceImpact(fact, listing),
        );
      }
      return answer(
        (onStale) => {
          const at = atRevision(head, isLive, onStale);
          return deps.impact.ofChange({ repo: repository.path, repoId: repository.repoId, base, ...(at.live ? at : { head: at.revision }), ...scopeOf(paths), ...budgetOf(requested), signal: ctx.mcpReq.signal });
        },
        (fact) => renderImpact(fact, listing),
      );
    },
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: `What depends on the symbols or line ranges asked for at a revision: the callers they reach and the entrypoints those serve, with path:line evidence. A symbol that names no declaration is reported as an error. Use it before changing or deleting a symbol or a range of lines. With workspace it also joins the call sites other local repositories make to the routes the symbols serve. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, targets: z.array(target).min(1).describe("The symbols or line ranges to start from."), scope, budget, detail, workspace })
        .refine(excludes("revision"), "live excludes revision")
        .refine(withoutWorkspace, "live excludes workspace"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, targets, scope: paths, budget: bounds, detail: listing, workspace: others }, ctx) => {
      const crossing = workspaceOf(others);
      if (crossing !== undefined) {
        return answer(
          () =>
            deps.workspaceImpact.callers({
              repo: { path: repository.path, id: repository.repoId, revision: requested ?? DEFAULT_REVISION },
              ...crossing,
              targets: targets as CallersTarget[],
              ...scopeOf(paths),
              ...budgetOf(bounds),
              signal: ctx.mcpReq.signal,
            }),
          (fact) => renderWorkspaceImpact(fact, listing),
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
      );
    },
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: `Per file, the files that import it, the files that use it and the files holding a reference to its names that the index could not resolve. Use it before moving, renaming or deleting a file, or changing its exports. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope })
        .refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, files, scope: paths }, ctx) =>
      answer(
        (onStale) => deps.impact.importers({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        renderImporters,
      ),
  );

  server.registerTool(
    "ye_ast_workspace",
    {
      title: "Repositories a workspace names",
      description: `The outward names this repository (and any repos passed) writes: HTTP hosts and path prefixes, configuration URLs, message destinations, dependency coordinates, its own remote and the registries it declares, each with path:line evidence; the local repositories that serve each name, with basis exact-name, artifact, remote or route-overlap; and the names no repository given serves. Use it to learn which clones a cross-repository question needs. It reads only local repositories and makes no network request. ${COMPLETENESS}`,
      inputSchema: z.strictObject({
        revision,
        scope,
        repos: z.array(workspaceRepo).min(1).optional().describe("Other local repositories to read beside the bound one."),
        gateways,
      }),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, scope: paths, repos, gateways: requestedGateways }, ctx) =>
      answer(
        async () => {
          const read = await deps.workspace.outwardNames({
            repo: { path: repository.path, id: repository.repoId, ...(requested === undefined ? {} : { revision: requested }) },
            ...(repos === undefined ? {} : { repos: repos.map(askedRepository) }),
            ...(requestedGateways === undefined ? {} : { gateways: requestedGateways }),
            ...scopeOf(paths),
            signal: ctx.mcpReq.signal,
          });
          return read.ok ? { ok: true, value: withoutRepositories(read.value) } : read;
        },
        renderWorkspace,
      ),
  );

  return server;
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
