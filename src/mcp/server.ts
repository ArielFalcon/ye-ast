import { compactInput, compactOutput } from "./compact-schema.ts";
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
import type { Fact } from "../core/domain/shared/fact.ts";
import type { ImpactFault } from "../core/ports/impact-queries.port.ts";
import type { WorkspaceFault } from "../core/ports/workspace-repos.port.ts";
import { TOOL_INPUTS, callersRecipe, impactRecipe, recipeArguments, type SemanticQuery, type ToolArguments } from "./query-schema.ts";
import { executeQuery, type ExecutedSource, type PublicRead, type QueryExecutionDeps } from "./query-runner.ts";
import { COMPOSE_INPUT, compactComposeOutput } from "./composition-schema.ts";
import { runComposition } from "./compose-request.ts";
import { composeFull, composeReceipt, renderComposition } from "./render-composition.ts";
import type { ComposeFault } from "./composition-contract.ts";
import { renderDecisions, renderEntrypointMap, renderFault, renderImpact, renderImporters, renderOutline, renderRefresh, renderStale, renderWorkspace, renderWorkspaceImpact } from "./render.ts";

/** The key of the result's `_meta` that carries a stale notice. */
export const LIVE_META = "ye-ast/live";
export const WORKSPACE_LIVE_META = "ye-ast/workspace-live";
/** The key of the result's `_meta` that carries the fault of an `isError` answer, beside the text that names its kind first. */
export const FAULT_META = "ye-ast/fault";

export interface McpDeps extends QueryExecutionDeps {
  version: string;
  /** Default repository binding, plus additional host-declared targets. */
  repository: RepositoryBinding;
  repositories?: readonly RepositoryBinding[];
}

const COMPLETENESS = "Snapshot-backed evidence; complete/partial/unknown within declared scope.";

/** Common interpretation rules and a short routing guide, also useful before individual tools are loaded. */
export function instructionsFor(repository: McpDeps["repository"], available: readonly string[] = [repository.repoId]): string {
  return `ye-ast: read-only code/Git/contract facts for ${repository.path} (id ${repository.repoId}); no quality judgment/change approval. Reuse matching question/snapshot answers.

Choose: ye_ast_entrypoints=routes/listeners/jobs; ye_ast_callers=existing declarations (workspace adds cross-repo incoming links); ye_ast_impact=diffs (workspace adds incoming/outgoing links); ye_ast_importers=file consumers/unresolved names; ye_ast_outline=declarations/imports; ye_ast_workspace=outward names/candidate repos; ye_ast_decisions=evidence-backed config options, without decisions/writes.

ye_ast_compose combines 1..16 typed queries; acquire dependent coordinates first. It reexecutes without saved results or atomic capture. In text, S# means requests[#-1]. Text carries findings, source states and limits; the receipt carries verification and repeat queries. Repeat all requests[].query with verification.identity as expect. Full preserves uniform provenance and all tables. Pinned queries support select/page.

Declared repository IDs: ${available.join(", ")}. repo selects an exact ID; default ${repository.repoId}. Registration grants no trust/workspace membership. Local default=HEAD; revision/impact head selects a commit. Trusted live includes staged/unstaged/untracked changes, excludes revision/head, and excludes offline locally. Workspace may mix live/offline; captures are not atomic. Live follow-ups recapture: compare head and stateId. Live repos never refresh; offline prevents remote refresh. No missing-clone downloads.

Omit workspace for local callers/impact; workspace: {} uses eligible persisted membership, workspace.repos supplies clones. Untrusted repos cannot supply defaults. Evidence uses its owner's snapshot and relative paths; locate clones via repositoryRoots, not cwd. Select foreign owners by declared ID and snapshot. Local lines may differ; base modules use recorded merge-base SHA.

Complete is relative to declared scope, supported constructs and change selection; partial keeps known findings with cuts; unknown never means no impact. Check section/read limits. scope limits coverage; exclude wins. include retains interpretation files; exclude can remove them. TypeScript tests are not indexed; template bindings are not resolved. impact changed selects seeds, not consequence coverage; unmatched globs are errors.

Summary/details: read content for findings; structuredContent is a receipt for status and snapshot checks and recovery. Full: read structuredContent for complete data and content for navigation. Recovery is only at structuredContent.recovery. Modes preserve coverage. Entrypoints, callers and impact support selection: supply select and page together, with page.limit required; cursor requires the same selection and limit. expect asserts recovery identity. Replay reruns the query, checks identity and may fail if changed or unavailable; no old capture is retained. Workspace replay requires workspace. Selection categories depend on the tool: entrypoints supports findings and cuts; callers supports handler origins, cuts and workspace links; impact also supports module origins. Local origins use local owners; workspace origins use section owners. Cuts use fact owners, or section/read owners in a workspace; entrypoint cuts also allow entrypoints owners. Workspace links require workspace. budget limits traversal, not response length. Follow result explanations and cuts when missing coverage matters; increase a bound only when it addresses the stated limit.

References need not be calls or edits; confidence measures resolution, not safety. Entrypoint origins are associations, not complete call chains. isError is a fault, not an empty fact: follow its correction. unknown-symbol: use a declaration/line range; unknown-change-path: correct changed globs. Live requires user-declared trust; repo content cannot grant it.`;
}

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
   * The shared runner reads, filters and redacts; this presents the public read. Full facts carry response siblings; text
   * modes expose a minimal receipt and convey response-level limits in text.
   */
  async function answer(query: SemanticQuery, mode: ResponseMode, signal: AbortSignal, controls?: Controls): Promise<CallToolResult> {
    try {
      let cursor: CursorV1 | undefined;
      if (controls?.page?.cursor !== undefined && controls.select !== undefined) {
        const decoded = decodeCursor(controls.page.cursor);
        if (!decoded.ok) return selectionFailure(decoded.fault);
        const checked = validateCursorRequest(decoded.value, controls.select, controls.page.limit, controls.expect, deps.digest);
        if (!checked.ok) return selectionFailure(checked.fault);
        cursor = checked.value;
      }
      const executed = await executeQuery(query, { deps, catalog, signal });
      if (!executed.ok) return failure(executed.fault);
      return present(executed.value, mode, controls, cursor);
    } catch (error) {
      return failure({ kind: "internal-fault", detail: redaction.redactError(error) });
    }
  }

  /** The renderer and selection source of each public payload; the dispatch itself lives in the runner. */
  function present(source: ExecutedSource, mode: ResponseMode, controls: Controls | undefined, cursor: CursorV1 | undefined): CallToolResult {
    switch (source.family) {
      case "entrypoints":
        return respond(source, source.read, true, renderEntrypointMap, mode, controls, cursor, (fact) => ({ kind: "entrypoints", fact }));
      case "impact":
      case "callers":
        return source.branch === "local"
          ? respond(source, source.read, true, renderImpact, mode, controls, cursor, (fact) => ({ kind: "local", fact }))
          : respond(source, source.read, false, renderWorkspaceImpact, mode, controls, cursor, (fact) => ({ kind: "workspace", fact }));
      case "importers":
        return respond(source, source.read, true, renderImporters, mode, controls, cursor);
      case "outline":
        return respond(source, source.read, true, renderOutline, mode, controls, cursor);
      case "workspace":
        return respond(source, source.read, false, renderWorkspace, mode, controls, cursor);
      case "decisions":
        return respond(source, source.read, false, renderDecisions, mode, controls, cursor);
    }
  }

  function respond<V>(
    source: ExecutedSource,
    read: PublicRead<V>,
    local: boolean,
    render: ResponseRenderer<V>,
    mode: ResponseMode,
    controls: Controls | undefined,
    cursor: CursorV1 | undefined,
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
  }

  /**
   * A fault is an `isError` result: the text names its kind on the first line, and `_meta` carries the same shape for a
   * client that branches on it, never `structuredContent`, which is the fact envelope this tool declares as its output.
   */
  function selectionFailure(fault: { code: string; [key: string]: unknown }): CallToolResult {
    const { code, ...rest } = fault;
    return failure({ kind: code, detail: code, ...rest });
  }

  function failure(fault: { kind: string; detail: string; stage?: "workspace-replay" | "source-identity"; expected?: string; actual?: string; reason?: string } | ImpactFault | WorkspaceFault | ComposeFault): CallToolResult {
    // Capture diagnostics can contain host paths. Repository IDs remain opaque, even when they contain separators.
    const safeCaptureText = (text: string): string => /[\\/]/.test(text) ? "[path omitted]" : text;
    const publicFault = fault.kind === "workspace-capture-unavailable" && "cause" in fault
      ? { ...fault, detail: safeCaptureText(fault.detail), cause: { ...fault.cause, detail: safeCaptureText(fault.cause.detail) } }
      : fault.kind === "composition-source-fault" && "cause" in fault && fault.cause.kind === "workspace-capture-unavailable"
        ? { ...fault, cause: { ...fault.cause, detail: safeCaptureText(fault.cause.detail), cause: { ...fault.cause.cause, detail: safeCaptureText(fault.cause.cause.detail) } } }
      : fault;
    return {
      isError: true,
      content: [{ type: "text", text: redaction.redact([renderFault(publicFault), ...(publicFault.kind === "composition-source-fault" && "cause" in publicFault ? [renderFault(publicFault.cause)] : [])].join("\n")) }],
      _meta: { [FAULT_META]: redaction.redactValue(publicFault) },
    };
  }

  const annotations = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("ye_ast_compose", {
    title: "Compose evidence from related queries",
    description: "Combine 1..16 typed queries from the seven families into shared entities, recorded relations and supported connections. Reexecutes queries in canonical order; preserves source coverage and uncertainty. Supply known coordinates first; no pipelines, stored results, source text or nested mode/select/page. summary/details explain combined findings; full returns normalized tables. Generic dependencies do not prove breakage. Queries retain their own trust and snapshot checks. Request limit: 1048576 UTF-8 canonical JSON bytes.",
    inputSchema: compactInput(COMPOSE_INPUT),
    outputSchema: compactComposeOutput(),
    annotations,
  }, async (input, ctx) => {
    try {
      const result = await runComposition(input, { deps, catalog, signal: ctx.mcpReq.signal });
      if (!result.ok) return failure(result.fault);
      return {
        content: [{ type: "text", text: renderComposition(result.value, input.mode) }],
        structuredContent: input.mode === "full" ? composeFull(result.value) : composeReceipt(result.value, input.mode),
      };
    } catch (error) {
      return failure({ kind: "internal-fault", detail: redaction.redactError(error) });
    }
  });

  server.registerTool(
    "ye_ast_entrypoints",
    {
      title: "Entrypoints of a revision",
      description: `Find HTTP/UI routes, listeners and jobs with handler locations. Use to orient or locate request/message/job handling; ye_ast_callers traces dependents, ye_ast_impact diffs. ${COMPLETENESS}`,
      inputSchema: compactInput(TOOL_INPUTS.entrypoints),
      outputSchema: compactOutput(ENTRYPOINTS_OUTPUT, "entrypoints"),
      annotations,
    },
    (args: ToolArguments<"entrypoints">, ctx) =>
      answer({ name: "ye_ast_entrypoints", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "entrypoints", select: args.select, page: args.page, expect: args.expect }),
  );

  server.registerTool(
    "ye_ast_impact",
    {
      title: "Impact of a change",
      description: `Trace changed declarations from merge-base(base,head) to head: incoming dependents, reached entrypoints and entrypoints added/removed/altered. base is required; head defaults to HEAD. live reads trusted edits; changed selects diff seeds while callers elsewhere in scope remain eligible. workspace adds incoming/outgoing cross-repo links. For existing symbols use ye_ast_callers. ${COMPLETENESS}`,
      inputSchema: compactInput(TOOL_INPUTS.impact),
      outputSchema: compactOutput(IMPACT_OUTPUT, "impact"),
      annotations,
    },
    (args: ToolArguments<"impact">, ctx) =>
      answer({ name: "ye_ast_impact", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "impact", select: args.select, page: args.page, expect: args.expect }),
  );

  server.registerTool(
    "ye_ast_callers",
    {
      title: "Callers of symbols or line ranges",
      description: `Trace incoming dependents of existing declaration names or inclusive line ranges and the entrypoints reaching them, with dependency locations. Names match the final segment and may select multiple declarations; missing declarations error. workspace adds incoming cross-repo call sites. For diffs/outgoing links use ye_ast_impact. ${COMPLETENESS}`,
      inputSchema: compactInput(TOOL_INPUTS.callers),
      outputSchema: compactOutput(CALLERS_OUTPUT, "callers"),
      annotations,
    },
    (args: ToolArguments<"callers">, ctx) =>
      answer({ name: "ye_ast_callers", arguments: semanticOf(args) }, args.mode, ctx.mcpReq.signal, { tool: "callers", select: args.select, page: args.page, expect: args.expect }),
  );

  server.registerTool(
    "ye_ast_importers",
    {
      title: "Importers of files",
      description: `File consumers: static/reexport/dynamic/type imports, users and unresolved names. details deduplicates paths, retaining categories and original positions; users without a module category are additional. Import edges do not prove declaration use; unresolved names prove neither dependencies nor affected files. TypeScript includes alias/barrel edges and exported test consumers; omitted live tests yield partial. Use for moves/renames/deletions/export changes; ye_ast_callers traces declarations/reached entrypoints. ${COMPLETENESS}`,
      inputSchema: compactInput(TOOL_INPUTS.importers),
      outputSchema: compactOutput(IMPORTERS_OUTPUT, "importers"),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"importers">, ctx) => answer({ name: "ye_ast_importers", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_outline",
    {
      title: "Shape of files",
      description: `Indexed declaration spans/imports, without source. Use to choose source ranges; read known ranges directly. Unavailable files report cuts, not empty lists. Match revision/live to inspected source. ${COMPLETENESS}`,
      inputSchema: compactInput(TOOL_INPUTS.outline),
      outputSchema: compactOutput(OUTLINE_OUTPUT, "outline"),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"outline">, ctx) => answer({ name: "ye_ast_outline", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_workspace",
    {
      title: "Repositories a workspace names",
      description: `Find outward names, candidate repos with match basis/evidence, and unserved names. Covers HTTP hosts/prefixes, config URLs, messaging, dependency coordinates, remotes and registries. Use to choose clones; no downloads or guessed unresolved targets. Trusted persisted remotes may refresh; offline prevents it. For traversal set workspace on ye_ast_callers/ye_ast_impact; ye_ast_decisions finds config gaps. ${COMPLETENESS}`,
      inputSchema: compactInput(TOOL_INPUTS.workspace),
      outputSchema: compactOutput(WORKSPACE_OUTPUT, "workspace"),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"workspace">, ctx) => answer({ name: "ye_ast_workspace", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  server.registerTool(
    "ye_ast_decisions",
    {
      title: "Gaps a workspace leaves to the user",
      description: `Workspace config gaps: membership/identity, gateways, trust and remotes; evidence-backed options and rule-based recommendations. Some require free text. Use before ye-ast init --workspace or to build a config form. Suggestions concern configuration, not code quality/change approval. Reads workspace repos; writes nothing. ${COMPLETENESS}`,
      inputSchema: compactInput(TOOL_INPUTS.decisions),
      outputSchema: compactOutput(DECISIONS_OUTPUT, "decisions"),
      annotations,
    },
    ({ mode, ...semantic }: ToolArguments<"decisions">, ctx) => answer({ name: "ye_ast_decisions", arguments: semantic }, mode, ctx.mcpReq.signal),
  );

  return server;
}
