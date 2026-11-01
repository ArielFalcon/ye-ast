import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import { TRUST_MODES, WALK_BOUND_FIELDS, type WalkBoundsField } from "../core/domain/shared/fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { CallersTarget, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { DEFAULT_REVISION } from "../core/ports/vcs.port.ts";
import { renderEntrypointMap, renderFault, renderImpact, renderImporters, renderStale, type Detail } from "./render.ts";

/** The key of the result's `_meta` that carries a stale notice. */
export const LIVE_META = "ye-ast/live";

export interface McpDeps {
  version: string;
  /** Read query families only: nothing here can write, by type. */
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  redaction: Redaction;
  /** The one repository every tool reads: its root and the stable name recorded in every snapshot. */
  repository: { path: string; repoId: string };
}

const COMPLETENESS = "The answer states its completeness: complete, partial with every cut, or unknown with its reason.";

/** What the agent reads at `initialize`: when each tool earns a call and how to read its answer. */
export const INSTRUCTIONS = `ye-ast answers verifiable facts about the code of the repository this server is bound to. Every answer is derived from code and git, carries path:line evidence and the snapshot it read, and states its completeness. Prefer it over guessing from search results whenever a decision depends on what reaches what.

When to call:
- ye_ast_entrypoints: when orienting in the repository, or to find the handler of an HTTP route, UI route, message listener or scheduled job.
- ye_ast_callers: before changing or deleting a function, method or class, or a range of lines, to learn what depends on it and which entrypoints it serves.
- ye_ast_importers: before moving, renaming or deleting a file, or changing what it exports.
- ye_ast_impact: after changing code and before reporting the work done or opening a pull request, with base set to the branch the change merges into; set live to true to include uncommitted edits. It repeats what ye_ast_callers already answered when the change stays inside the symbols asked about, so call ye_ast_impact once for the whole change before reporting it done, not once per symbol.

Reading an answer:
- status "complete": the result is everything within the declared scope (inputs.declaredScope); code in languages or frameworks outside it is not covered.
- status "partial": the result stops at each listed cut; what lies past a cut is not known.
- status "unknown": ye-ast cannot tell, and the reason says why; never read it as "no impact".
- ye_ast_impact and ye_ast_callers list the symbols at depth 0 and 1 and count deeper ones per file; set detail to "full" when the deeper symbols themselves are needed.
- Every answer closes with a \`cuts:\` list holding every place past each cut, after the content; the status line only counts them by kind, so a partial answer read without its list reads as complete.
- An isError result names a fault kind. "live-requires-trusted" means the user must declare the repository trusted with \`ye-ast install --trust trusted\` before live can be used; answer from a revision meanwhile.`;

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

const detail = z
  .enum(["summary", "full"] satisfies Detail[])
  .optional()
  .describe("How much of the impacted symbols the text lists: summary (the default) lists depth 0 and 1 and counts deeper ones per file; full lists every one. The structured content always holds every one.");

const target = z.union([
  z.strictObject({ file: z.string().min(1), symbol: z.string().min(1) }).describe("A declaration by name."),
  z
    .strictObject({ file: z.string().min(1), start: count, end: count })
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
      inputSchema: z.strictObject({ revision, live }).refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive }, ctx) =>
      answer(
        (onStale) => deps.entrypoints.map({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), signal: ctx.mcpReq.signal }),
        renderEntrypointMap,
      ),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: `What depends on the change from the merge base of base and head to head: the symbols that reach it, the entrypoints they serve and the entrypoints the change adds, removes or alters, with path:line evidence. Use it after changing code and before reporting the work done; live includes uncommitted edits. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({
          base: z.string().min(1).describe("The revision the change is read against."),
          head: z.string().min(1).optional().describe("The revision holding the change; HEAD when omitted."),
          live,
          budget,
          detail,
        })
        .refine(excludes("head"), "live excludes head"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ base, head, live: isLive, budget: requested, detail: listing }, ctx) =>
      answer(
        (onStale) => {
          const at = atRevision(head, isLive, onStale);
          return deps.impact.ofChange({ repo: repository.path, repoId: repository.repoId, base, ...(at.live ? at : { head: at.revision }), ...budgetOf(requested), signal: ctx.mcpReq.signal });
        },
        (fact) => renderImpact(fact, listing),
      ),
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: `What depends on the symbols or line ranges asked for at a revision: the callers they reach and the entrypoints those serve, with path:line evidence. A symbol that names no declaration is reported as an error. Use it before changing or deleting a symbol or a range of lines. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, targets: z.array(target).min(1).describe("The symbols or line ranges to start from."), budget, detail })
        .refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, targets, budget: bounds, detail: listing }, ctx) =>
      answer(
        (onStale) =>
          deps.impact.callers({
            repo: repository.path,
            repoId: repository.repoId,
            ...atRevision(requested, isLive, onStale),
            targets: targets as CallersTarget[],
            ...budgetOf(bounds),
            signal: ctx.mcpReq.signal,
          }),
        (fact) => renderImpact(fact, listing),
      ),
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: `Per file, the files that import it, the files that use it and the files holding a reference to its names that the index could not resolve. Use it before moving, renaming or deleting a file, or changing its exports. ${COMPLETENESS}`,
      inputSchema: z
        .strictObject({ revision, live, files: z.array(z.string().min(1)).min(1).describe("Repo-relative paths.") })
        .refine(excludes("revision"), "live excludes revision"),
      outputSchema: FACT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ revision: requested, live: isLive, files }, ctx) =>
      answer(
        (onStale) => deps.impact.importers({ repo: repository.path, repoId: repository.repoId, ...atRevision(requested, isLive, onStale), files, signal: ctx.mcpReq.signal }),
        renderImporters,
      ),
  );

  return server;
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
