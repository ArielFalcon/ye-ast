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
import { renderDecisions, renderEntrypointMap, renderFault, renderImpact, renderImporters, renderOutline, renderRefresh, renderStale, renderWorkspace, renderWorkspaceImpact, type Detail } from "./render.ts";

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

const COMPLETENESS = "The answer states its completeness: complete, partial with every cut, or unknown with its reason.";

/**
 * What to do at each kind of cut, exhaustive over `Cut["kind"]`, so a kind added to the facts contract fails to compile
 * until the agent is told how to act on it.
 */
export const CUT_GUIDANCE: Readonly<Record<Cut["kind"], string>> = {
  "unresolved-link":
    "places that name the symbol where the index could not tell what the name points at; open each place to decide. After a declaration was removed, the places listed under it are unresolved candidates, not proven broken dependencies: verify their bindings and targets before deciding whether they still use it. In a workspace answer it is a call site whose target the code does not decide, or one two repositories serve equally: the answer lists it with the declaration it is written in, its transport, the library it goes through and, when only the base is undecided, the request it writes, so decide which repository it calls from that line.",
  "no-extractor": "a file ye-ast cannot read, such as a template, a style sheet or a language outside the declared scope; read it yourself when it bears on the task.",
  "not-exported": "a path the snapshot left out, so nothing under it was read; read it yourself when it bears on the task.",
  depth: "the walk stopped at the depth bound; raise budget.depth, query a boundary symbol with ye_ast_callers, or read direct module consumers with ye_ast_importers at the indicated snapshot.",
  hub: "a symbol or module with more direct consumers than budget.hubFanIn was not expanded; raise the bound if that branch matters. Querying it alone does not remove the bound.",
  "caller-budget": "a bound stopped the work: on a walk it is budget.expansions, counted separately for symbols and modules, with the module allowance shared by base and head; on an entrypoint map it is the host's export budget. Adjust the applicable bound or narrow the request.",
  "node-cap": "the walk stopped at the node cap; narrow the request with scope or ask about fewer symbols.",
  deadline: "time ran out before the answer was whole; ask again, with a narrower scope when it repeats.",
  section: "one section of a composite answer could not be produced; the rest stands, and asking again may complete it.",
};

const cutGuidance = Object.entries(CUT_GUIDANCE)
  .map(([kind, guidance]) => `  - ${kind}: ${guidance}`)
  .join("\n");

/** What the agent reads at `initialize`: the root every answer is relative to, when each tool earns a call, and how to read one. */
export function instructionsFor(repository: McpDeps["repository"]): string {
  return `ye-ast answers verifiable facts about the code of the repository this server is bound to: ${repository.path} (id ${repository.repoId}). Every path in an answer is relative to that root, so open it there, never against the process working directory, which a client may set to anything. Every answer is derived from code and git, carries path:line evidence and the snapshot it read, and states its completeness. Prefer it over guessing from search results whenever a decision depends on what reaches what.

When to call:
- ye_ast_entrypoints: when orienting in the repository, or to find the handler of an HTTP route, UI route, message listener or scheduled job.
- ye_ast_callers: before changing or deleting a function, method or class, or a range of lines, to learn what depends on it and which entrypoints it serves. Before deleting a declaration, ask here: once it is gone, ye_ast_impact can only list the places that still name it.
- ye_ast_importers: before moving, renaming or deleting a file, or changing what it exports.
- ye_ast_impact: after changing code and before reporting the work done or opening a pull request, with base set to the branch the change merges into; set live to true to include uncommitted edits. It repeats what ye_ast_callers already answered when the change stays inside the symbols asked about, so call ye_ast_impact once for the whole change before reporting it done, not once per symbol.
- ye_ast_workspace: when the work crosses repositories (a frontend calling services, a service calling another, a message between them). It lists the hosts, path prefixes, configuration URLs, dependency coordinates, remotes and registries the repository writes outward, the local repository that serves each one and the basis that says why, and the names no repository given serves. Pass the other clones with repos, or none to read the ones the repository persists, then ask ye_ast_callers or ye_ast_impact again with workspace set to those repos so the call sites of the other repositories that land in what the walk reaches are joined. It reads each repository from its own clone, and refreshes a declared remote only for a repository the user declared trusted; nothing else reaches the network: a name nothing serves is the next clone to make with your own tools.
- ye_ast_decisions: when the workspace has gaps only the user can fill (a name no clone given serves, a clone that states no name, a prefix that routes nowhere, a repository with no trust record, a repository the remote could not pin at the trigger's line, a repository declared without a remote), and before \`ye-ast init --workspace\`, to show the user a form. It reads the same repositories as ye_ast_workspace, says which declaration they came from, and answers each gap with every option the workspace can verify, the places that make each one valid, and the option a rule recommends; a gap whose answer is a value no fact states says so. It writes nothing: render the options, then persist the answers with \`ye-ast init --workspace\` and \`ye-ast init --trust\`.
- workspace on ye_ast_callers and ye_ast_impact: when the symbol or change can be called from another repository (a route or a handler a frontend or another service calls). Pass the other local clones as workspace.repos (a path each; gateways only when a path prefix routes to a repository and the code does not say it), or pass workspace without repos to work over the repositories and gateways the user persisted with \`ye-ast init --workspace\`; a repository that persists none answers about itself alone. The answer adds the links from call sites in those repositories to what a walk reaches, and follows each link into its own repository, so a chain of repositories answers as one: what depends on those call sites in their own repository, the call sites that reached a declared service and matched none of its routes (unmatched), the ones that name a service no repository given serves (external), and every call site it could not decide as a cut. On ye_ast_impact the links also run the other way: what the change sends onward, each link naming the links crossed from it (reach). A repository not passed is not read: an answer without workspace says nothing about other repositories. Each repository is read at its HEAD or the revision given, under its own trust declaration; a repository the user declared trusted whose remote is declared is refreshed and read at the sha the remote's listing pins. A refreshed answer opens its text with a \`remote:\` line per remote saying whether this query verified it and why not, and a \`pinned:\` line per repository naming the step that chose its sha, and carries the same freshness and resolution beside the fact. live cannot be combined with workspace.
- Every tool takes scope: include and exclude globs over repository-relative paths (exclude wins). include selects the content the answer is about, and the configuration that interprets it (a package.json, a tsconfig, a build file, a Spring application file, an OpenAPI document) is read whatever the scope selects, so narrowing never hides what an extractor needs to place a source. exclude leaves a path out of both, and a path outside the scope is never answered about, so callers and entrypoints through it are not known and the answer is complete only within the scope, which it names under its status. Use scope to keep one service or package of a repository apart; to shorten an answer, leave scope out and rely on detail.
- ye_ast_impact takes changed: globs over the changed paths. Only the changed paths they select seed the walk, while the repository is still indexed whole, so a caller outside the selection is still known. Use it on a large change to answer one area at a time; a glob that selects no changed path is an error, never an empty answer.
- ye-ast does not say which templates bind one input or output of a component; search the templates for the binding's name.

Reading an answer:
- status "complete": the result is everything within the declared scope and the change selection the answer prints under its status (inputs.declaredScope, inputs.declaredConfig.changed); code in languages or frameworks outside it is not covered.
- status "partial": the result stops at each listed cut; what lies past a cut is not known.
- status "unknown": ye-ast cannot tell, and the reason says why; never read it as "no impact".
- an item with reason "no-project": no package.json above that source places it in a project, so nothing says whether it declares routes; scope does not hide the manifest, unless an exclude glob leaves it out.
- Every tool takes detail. A summary, the default, lists the symbols at depth 0 and 1, the seeds the caller asked for by name, and each file's remaining seeds with their count and basis; it leaves the symbols past that depth out with their count, and counts per file the cuts anchored at them. Full lists every symbol, every seed and every place a cut could not settle. Set detail to "full" when the deeper symbols themselves, a seed's name, the place of each unresolved reference or every cut is needed. A workspace summary groups the outward names by kind and counts the dependency coordinates no repository given serves; a decisions summary groups the gaps by kind and counts the free-text-only dependency gaps. Full lists them. For one ring past the listed symbols, ask ye_ast_callers about one of them: it answers that branch alone in one call, which costs less than full when one branch matters and more turns when every branch does.
- The index is built from each repository's production sources: a TypeScript test file is not written to it, so no answer names a test as an importer, a caller or a cut, and "complete" means complete over the production sources. A change also breaks the tests that exercise it; open them yourself when the change touches a surface they cover.

- Before reading a file you did not write, ask ye_ast_outline for it: it answers the span of every declaration and the files it imports, so you read the ranges you need instead of the whole file. A file it cannot tell about is listed in the cuts; read that one whole.

- The text is the answer: it lists what detail asks for, while the structured content beside it carries only the envelope, so nothing is paid for twice. A host that needs the fact itself passes full: true, which adds every value and every cut place to the structured content and leaves the text unchanged.
- A place prints its span when its declaration is longer than one line (\`src/a.ts:3-9\`). A reached symbol prints \`via src/b.ts:B.user at 14, 21, 33\`: the lines are the places inside the symbol itself, in its own file, where it depends on B.user, and every one of them is a place to change; never assume one use per symbol. \`at\` with no reason is a call; \`(reference)\` means it only names the symbol; \`(call)\`, \`(reference)\`, \`(contains)\`, \`(dispatch)\`, \`(relation)\` and \`(import)\` in parentheses with no line name a dependence the store placed no line for, so look at the symbol rather than searching for a call site.
- confidence is 0-1 and printed only below 1: how strongly the edge that reached the symbol was resolved, 1 for a relation read from the code itself and lower for one the extractor inferred. fan-in is how many places call or instantiate the symbol, whether or not the walk followed them.
- Every answer closes with a \`cuts:\` list after the content: a summary names the declaration an unresolved link stopped at, or the file it led and the references it could not attribute, so each one is settled by reading it; a cut anchored at a symbol the summary does not list is counted per file with its kind, saying so, and detail "full" lists every place. The status line only counts them by kind, so a partial answer read without its list reads as complete. A workspace answer lists its unresolved call sites under their repository instead, each with its declaration and the request it writes, so the cuts list carries only what is left.
- An isError result names a fault kind. "live-requires-trusted" means the user must declare the repository trusted with \`ye-ast init --trust trusted\` before live can be used; answer from a revision meanwhile. "unknown-symbol" lists what the file declares; ask again with one of those names. "unknown-change-path" means a changed glob selected no path the change touches; fix the glob or drop it.

What to do at each kind of cut:
${cutGuidance}`;
}

const revision = z.string().min(1).optional().describe("Git revision to read; HEAD when omitted.");
const live = z
  .boolean()
  .optional()
  .describe("True reads the working tree, including staged, unstaged and untracked changes, instead of a revision; only for a repository declared trusted with `ye-ast init --trust trusted`. Excludes the revision.");
const offline = z
  .boolean()
  .optional()
  .describe("True reads every repository from its own clone and refreshes no declared remote, as under `untrusted`: the query reaches no network, even for a repository declared trusted with a remote. Only a query with workspace can refresh one; excludes live.");

/** `live` and the revision it replaces are exclusive. */
const excludes = (field: string) => (value: { live?: boolean | undefined } & Record<string, unknown>): boolean => !(value.live === true && value[field] !== undefined);

/** The revision to read, or the working tree with the callback that learns of a change after the answer. */
function atRevision(requested: string | undefined, isLive: boolean | undefined, onStale: (notice: LiveStaleNotice) => void): { revision: string; live?: undefined } | { live: true; onStale: (notice: LiveStaleNotice) => void; revision?: undefined } {
  return isLive === true ? { live: true, onStale } : { revision: requested ?? DEFAULT_REVISION };
}
const count = z.int().positive();

/** Exhaustive over the fields, so a bound added to `ImpactBudget` fails to compile until it is described here. */
const BUDGET_FIELDS: Readonly<Record<WalkBoundsField, z.ZodOptional<z.ZodNumber>>> = {
  depth: count.optional().describe("The deepest dependency level in each symbol or module walk."),
  hubFanIn: count.optional().describe("The most direct consumers a symbol or module may have to be expanded."),
  expansions: count.optional().describe("The maximum expansions per walk: symbols separately from modules; the module allowance spans base and head."),
};
const budget = z
  .strictObject(BUDGET_FIELDS)
  .optional()
  .describe("Optional bounds on the walk; none applies unless set, and a bound that stops the walk is reported as a cut.");

const workspaceRepo = z.strictObject({
  path: z.string().min(1).describe("Path of the root of a local git repository."),
  id: z
    .string()
    .min(1)
    .optional()
    .describe("The name its snapshot carries; the directory name of the path when omitted, so a linked worktree keeps its own name: pass the repository's name when a clone and its worktrees must answer as one. Never a path."),
  revision: z.string().min(1).optional().describe("The revision to read; HEAD when omitted."),
  remote: z
    .string()
    .min(1)
    .optional()
    .describe("The repository's source of truth: an absolute URL or an scp-like git address. Under `trusted` the query refreshes it into ye-ast's mirror and reads the repository there; under `untrusted` it is ignored."),
});

const gateways = z
  .array(z.strictObject({ prefix: z.string().min(1).describe("The gateway prefix a call carries, such as a first path segment."), repo: z.string().min(1).describe("The repository id it routes to.") }))
  .min(1)
  .optional()
  .describe("Prefixes the caller declares; a declared prefix overrides the one inferred from route overlap.");

const workspaceRepos = z
  .array(workspaceRepo)
  .min(1)
  .optional()
  .describe("Other local repositories to read beside the bound one; leave it out to read the repositories the repository persists. The answer says which of the two declared them.");

const workspace = z
  .strictObject({
    repos: z
      .array(workspaceRepo)
      .min(1)
      .optional()
      .describe("Other local repositories to read beside the bound one; leave it out to use the repositories `ye-ast init --workspace` persisted for the bound repository."),
    gateways,
  })
  .optional()
  .describe("Other local repositories whose call sites to join to what a walk reaches: the answer then also holds the links from them and from the repositories they chain into, what depends on those call sites, and the call sites that match nothing. Without repos the repositories and gateways the bound repository persists are used, and a repository that persists none answers about itself alone and says so. Each is read at its own snapshot under its own trust declaration; live excludes it.");

/** `live` reads the working tree of one repository; a workspace reads committed snapshots. */
const withoutWorkspace = (value: { live?: boolean | undefined; workspace?: unknown }): boolean => !(value.live === true && value.workspace !== undefined);

const detail = z
  .enum(["summary", "full"] satisfies Detail[])
  .optional()
  .describe("How much the text lists: summary (the default) names the symbols at depth 0 and 1 and the declarations a cut could not settle to, leaving the symbols past that depth out with their count and counting per file the cuts anchored at them; full lists every symbol and every place a cut could not settle. A workspace summary also counts the dependency coordinates no repository given serves, and a decisions summary the free-text-only dependency gaps; full lists them. The structured content carries none of it unless the full argument is true.");

const full = z
  .boolean()
  .optional()
  .describe("Hosts only: returns the whole fact, including every impacted symbol and every cut place.");

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
  .describe("The part of the repository the answer is about, as globs over repository-relative paths; the whole repository when omitted. include selects the content, and the configuration that interprets it (a manifest, a compiler configuration, a build file, a Spring configuration, a contract document) is read whatever the scope selects; exclude leaves a path out of both. A path outside the scope is not answered about, so callers and entrypoints through it are not known.");

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

function askedRepository(requested: { path: string; id?: string | undefined; revision?: string | undefined; remote?: string | undefined }): WorkspaceRepositoryRequest {
  return {
    path: requested.path,
    ...(requested.id === undefined ? {} : { id: requested.id }),
    ...(requested.revision === undefined ? {} : { revision: requested.revision }),
    ...(requested.remote === undefined ? {} : { remote: requested.remote }),
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
      const refresh = read.refresh === undefined ? undefined : (redaction.redactValue(read.refresh) as WorkspaceRefresh);
      const stale = moved === undefined ? undefined : (redaction.redactValue(moved) as LiveStaleNotice);
      const sidecar = [...(stale === undefined ? [] : [renderStale(stale)]), ...(refresh === undefined ? [] : renderRefresh(refresh))];
      return {
        content: [{ type: "text", text: [...sidecar, render(fact)].join("\n") }],
        structuredContent: {
          ...(full ? fact : withoutPayload(fact)),
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
      description: `Lists the entrypoints of the repository at a revision: HTTP routes, UI routes, message listeners and scheduled jobs, each with the handler's path:line. Use it to orient in the repository or to find where a request, message or job is handled. ${COMPLETENESS}`,
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
      description: `What depends on the change from the merge base of base and head to head: the symbols that reach it, the entrypoints they serve and the entrypoints the change adds, removes or alters, with path:line evidence. Use it after changing code and before reporting the work done; live includes uncommitted edits. With changed, only the changed paths its globs select seed the walk, while the repository is still indexed whole, so callers outside the selection are known; use it on a large change to answer one area at a time. With workspace it also joins the call sites other local repositories make to the routes the change reaches, follows them into their own repositories, and lists what the change sends onward. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({
          base: z.string().min(1).describe("The revision the change is read against."),
          head: z.string().min(1).optional().describe("The revision holding the change; HEAD when omitted."),
          live,
          offline,
          scope,
          changed: globs.describe("Only the changed paths matching one of these globs seed the walk; the repository is still indexed whole, so callers outside them are known. A glob that selects no changed path is an error. The whole change when omitted."),
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
      description: `What depends on the symbols or line ranges asked for at a revision: the callers they reach and the entrypoints those serve, with path:line evidence. A symbol that names no declaration is reported as an error. Use it before changing or deleting a symbol or a range of lines. With workspace it also joins the call sites other local repositories make to the routes the symbols serve, and follows each link into its own repository. ${COMPLETENESS}`,
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
      description: `Per file, static importers, separate reexporters, dynamic importers, type importers, users and unresolved namers. Static TypeScript module resolution fills missing alias/barrel edges. A revision query includes exported test consumers; a live mirror that omitted them remains partial. Use before moving, renaming or deleting a file, or changing its exports. Module dependence does not prove use by every declaration. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, files: z.array(z.string().min(1)).min(1).describe("Repository-relative paths."), scope, detail, full })
        .refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, files, scope: paths, detail: listing, full: whole }, ctx) =>
      answer(
        (onStale) => deps.impact.importers({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, ...scopeOf(paths), signal: ctx.mcpReq.signal }),
        (fact) => renderImporters(fact, listing),
        whole === true,
      ),
  );

  server.registerTool(
    "ye_ast_outline",
    {
      title: "Shape of files",
      description: `Per file, the declarations a reader can open by line span and the files it imports, read from the index: no file is opened. Call it before reading a file you did not write, so you read only the ranges a change touches instead of the whole file. A file it cannot tell about is a cut, never an empty list. ${COMPLETENESS}`,
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
      description: `The outward names this repository (and any repos passed) writes: HTTP hosts and path prefixes, configuration URLs, message destinations, dependency coordinates, its own remote and the registries it declares, each with path:line evidence; the local repositories that serve each name, with basis exact-name, artifact, remote or route-overlap; and the names no repository given serves. Use it to learn which clones a cross-repository question needs. It reads each repository from its own clone, and refreshes a declared remote only for a repository the user declared trusted. ${COMPLETENESS}`,
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
          return read.ok ? { ok: true, value: { fact: withoutRepositories(read.value.fact), ...(read.value.refresh === undefined ? {} : { refresh: read.value.refresh }) } } : read;
        },
        (fact) => renderWorkspace(fact, listing),
        whole === true,
      ),
  );

  server.registerTool(
    "ye_ast_decisions",
    {
      title: "Gaps a workspace leaves to the user",
      description: `What the workspace does not state and only the user can fill: the clones that serve an outward name, the clones that state no name, the names no repository given serves, the prefixes that route nowhere and the repositories without a trust record. Each gap lists every option the workspace can verify with path:line evidence and marks the one a rule recommends; a gap whose answer is a value no fact states says so. Use it before \`ye-ast init --workspace\` to show the user a form; it reads the same repositories and writes nothing. ${COMPLETENESS}`,
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
