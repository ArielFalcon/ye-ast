import { compareText } from "../core/domain/shared/code-node.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { WALK_BOUND_FIELDS, type Fact, type WalkBoundsField } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import { escapePointer } from "../core/domain/shared/json-pointer.ts";
import type { ScopeRequest } from "../core/domain/shared/scope.ts";
import type { ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import type { Digest } from "../core/ports/digest.port.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { CallersTarget, ImpactFault, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { LiveFault, LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { OutlineFault, OutlineQueries } from "../core/ports/outline-queries.port.ts";
import { TRACE_BOUND_FIELDS, type TraceFault, type TraceQueries, type TraceTarget } from "../core/ports/trace-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { DEFAULT_REVISION, type VcsFault } from "../core/ports/vcs.port.ts";
import type { WorkspaceFault, WorkspaceRepositoryRequest } from "../core/ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries, WorkspaceRefresh, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { ConsequencesFault, ContractConsequencesQueries } from "../core/ports/contract-consequences-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { repositoryCatalog, RepositoryBinding, RepositoryTargetFault } from "./repository-targeting.ts";
import { callersRecovery, entrypointRecovery, impactRecovery, type Recovery } from "./recovery.ts";
import { TOOL_INPUTS, callersRecipe, impactRecipe, recipeArguments, type SemanticArguments, type SemanticQuery, type SemanticQueryOf } from "./query-schema.ts";
import type { EvidenceComposition, PublicRead, PublicWorkspaceValue, QueryFamily, SourcePayload } from "../core/ports/evidence-composition.port.ts";

/** The read ports and the public-boundary services a query needs; `McpDeps` extends it with version and bindings. */
export interface QueryExecutionDeps {
  /** Read query families only: nothing here can write, by type. */
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  trace: TraceQueries;
  workspace: WorkspaceQueries;
  workspaceImpact: WorkspaceImpactQueries;
  decisions: DecisionQueries;
  contractConsequences: ContractConsequencesQueries;
  evidenceComposition: EvidenceComposition;
  redaction: Redaction;
  digest: Digest;
}

export type QueryExecutionContext = {
  deps: QueryExecutionDeps;
  catalog: ReturnType<typeof repositoryCatalog>;
  signal?: AbortSignal;
};

/**
 * What redaction changed, by public position only, compared inside the runner before the original is discarded.
 * `changedIdentityPointers` are RFC 6901 pointers into the public fact (`read.fact`) of every value redaction altered; when
 * redaction rewrote an object's keys, the pointer names that whole object. `changedArguments` covers the semantic
 * arguments and the selected repository ID; `changedSnapshot` the fact's own snapshot (nested snapshots are pointers).
 * Neither original values nor digests of them are carried.
 */
export type RedactionIdentityGuard = {
  changedIdentityPointers: readonly string[];
  changedArguments: boolean;
  changedSnapshot: boolean;
};

type WithQuery<P> = P extends { family: infer F extends QueryFamily } ? P & { query: SemanticQueryOf<F> } : never;

/**
 * One executed query after the public boundary. `query` is the validated semantic query as received: it is internal and
 * may hold values redaction would change (see `identityGuard.changedArguments`). `live` is the local stale notice the
 * port reported; `workspaceLive`, roots and refresh stay in `read`.
 */
export type ExecutedSource = WithQuery<SourcePayload> & {
  recovery?: Recovery;
  identityGuard: RedactionIdentityGuard;
  live?: LiveStaleNotice;
};

/** A workspace replay that no longer matches is reported as a changed result of the original query. */
export type ReplayChangedFault = { kind: "result-changed"; detail: string; stage: "workspace-replay" };
export type InternalFault = { kind: "internal-fault"; detail: string };
export type QueryFault = VcsFault | LiveFault | ImpactFault | OutlineFault | WorkspaceFault | TraceFault | ConsequencesFault | RepositoryTargetFault | ReplayChangedFault | InternalFault;

type Run = Promise<Result<ExecutedSource, QueryFault>>;

/** The single semantic dispatch, shared by the original tools and composition. */
export async function executeQuery(query: SemanticQuery, ctx: QueryExecutionContext): Run {
  try {
    const target = ctx.catalog.resolve(query.arguments.repo);
    if (!target.ok) return target;
    return await dispatch(query, target.value, ctx);
  } catch (error) {
    return { ok: false, fault: { kind: "internal-fault", detail: ctx.deps.redaction.redactError(error) } };
  }
}

async function dispatch(query: SemanticQuery, repository: RepositoryBinding, ctx: QueryExecutionContext): Run {
  const { deps } = ctx;
  const signal = ctx.signal === undefined ? {} : { signal: ctx.signal };
  let moved: LiveStaleNotice | undefined;
  const onStale = (notice: LiveStaleNotice) => void (moved = notice);
  const local = { repo: repository.path, repoId: repository.repoId };
  switch (query.name) {
    case "ye_ast_entrypoints": {
      const a = query.arguments;
      const result = await deps.entrypoints.map({ ...local, ...atRevision(a.revision, a.live, onStale), ...scopeOf(a.scope), ...signal });
      if (!result.ok) return result;
      return finish({ fact: result.value }, query, repository, true, moved, ctx, (fact, original) =>
        entrypointRecovery(fact, original, repository.repoId, scopeOf(a.scope).scope, a.live === true, deps.digest, deps.redaction, (args) => TOOL_INPUTS.entrypoints.safeParse(args).success && recipeArguments.safeParse(args).success),
        (read, rest) => ({ family: "entrypoints", read, query, ...rest }));
    }
    case "ye_ast_impact": {
      const a = query.arguments;
      const validate = (args: unknown) => TOOL_INPUTS.impact.safeParse(args).success && impactRecipe.safeParse(args).success;
      const crossing = workspaceOf(a.workspace);
      const recovery = (workspace: unknown, replay: FactRead<unknown>["workspaceReplay"]) => (fact: Fact<unknown>, original: Fact<unknown>) =>
        impactRecovery({ fact, original, selected: repository.repoId, requestedScope: scopeOf(a.scope).scope, requestedBudget: a.budget, live: a.live === true, workspace, offline: workspace === undefined ? undefined : a.offline, replay, digest: deps.digest, redaction: deps.redaction, validate, requestedChanged: a.changed });
      if (crossing !== undefined) {
        const result = await deps.workspaceImpact.ofChange({
          repo: { path: repository.path, id: repository.repoId, ...(a.live ? { live: true as const } : { revision: a.head ?? DEFAULT_REVISION }) },
          ...crossing,
          ...(a.replay === undefined ? {} : { replay: a.replay }),
          base: a.base,
          ...(a.offline === undefined ? {} : { offline: a.offline }),
          ...(a.changed === undefined ? {} : { changed: a.changed }),
          ...scopeOf(a.scope),
          ...budgetOf(a.budget),
          ...signal,
        });
        if (!result.ok) return { ok: false, fault: replayChanged(result.fault) };
        return finish(result.value, query, repository, false, moved, ctx, recovery(a.workspace, result.value.workspaceReplay), (read, rest) => ({ family: "impact", branch: "workspace", read, query, ...rest }));
      }
      const at = atRevision(a.head, a.live, onStale);
      const result = await deps.impact.ofChange({ ...local, base: a.base, ...(at.live ? at : { head: at.revision }), ...(a.changed === undefined ? {} : { changed: a.changed }), ...scopeOf(a.scope), ...budgetOf(a.budget), ...signal });
      if (!result.ok) return result;
      return finish({ fact: result.value }, query, repository, true, moved, ctx, recovery(undefined, undefined), (read, rest) => ({ family: "impact", branch: "local", read, query, ...rest }));
    }
    case "ye_ast_callers": {
      const a = query.arguments;
      const validate = (args: unknown) => TOOL_INPUTS.callers.safeParse(args).success && callersRecipe.safeParse(args).success;
      const targets = a.targets as CallersTarget[];
      const crossing = workspaceOf(a.workspace);
      const recovery = (workspace: unknown, replay: FactRead<unknown>["workspaceReplay"]) => (fact: Fact<unknown>, original: Fact<unknown>) =>
        callersRecovery({ fact, original, selected: repository.repoId, targets: a.targets, requestedScope: scopeOf(a.scope).scope, requestedBudget: a.budget, live: a.live === true, workspace, offline: workspace === undefined ? undefined : a.offline, replay, digest: deps.digest, redaction: deps.redaction, validate });
      if (crossing !== undefined) {
        const result = await deps.workspaceImpact.callers({
          repo: { path: repository.path, id: repository.repoId, ...(a.live ? { live: true as const } : { revision: a.revision ?? DEFAULT_REVISION }) },
          ...crossing,
          ...(a.replay === undefined ? {} : { replay: a.replay }),
          targets,
          ...(a.offline === undefined ? {} : { offline: a.offline }),
          ...scopeOf(a.scope),
          ...budgetOf(a.budget),
          ...signal,
        });
        if (!result.ok) return { ok: false, fault: replayChanged(result.fault) };
        return finish(result.value, query, repository, false, moved, ctx, recovery(a.workspace, result.value.workspaceReplay), (read, rest) => ({ family: "callers", branch: "workspace", read, query, ...rest }));
      }
      const result = await deps.impact.callers({ ...local, ...atRevision(a.revision, a.live, onStale), targets, ...scopeOf(a.scope), ...budgetOf(a.budget), ...signal });
      if (!result.ok) return result;
      return finish({ fact: result.value }, query, repository, true, moved, ctx, recovery(undefined, undefined), (read, rest) => ({ family: "callers", branch: "local", read, query, ...rest }));
    }
    case "ye_ast_importers": {
      const a = query.arguments;
      const result = await deps.impact.importers({ ...local, ...atRevision(a.revision, a.live, onStale), files: a.files, ...scopeOf(a.scope), ...signal });
      if (!result.ok) return result;
      return finish({ fact: result.value }, query, repository, true, moved, ctx, undefined, (read, rest) => ({ family: "importers", read, query, ...rest }));
    }
    case "ye_ast_outline": {
      const a = query.arguments;
      const subject = a.focus === undefined ? { files: a.files ?? [] } : { focus: a.focus };
      const result = await deps.outline.outline({ ...local, ...atRevision(a.revision, a.live, onStale), ...subject, ...scopeOf(a.scope), ...signal });
      if (!result.ok) return result;
      return finish({ fact: result.value }, query, repository, true, moved, ctx, undefined, (read, rest) => ({ family: "outline", read, query, ...rest }));
    }
    case "ye_ast_trace": {
      const a = query.arguments;
      const result = await deps.trace.walk({ ...local, ...atRevision(a.revision, a.live, onStale), targets: a.targets as TraceTarget[], ...(a.workspace === undefined ? {} : { workspace: workspaceOf(a.workspace)! }), ...(a.offline === undefined ? {} : { offline: a.offline }), ...scopeOf(a.scope), ...budgetOf(a.budget, TRACE_BOUND_FIELDS), ...signal });
      if (!result.ok) return result;
      return finish({ fact: result.value }, query, repository, true, moved, ctx, undefined, (read, rest) => ({ family: "trace", read, query, ...rest }));
    }
    case "ye_ast_workspace": {
      const result = await deps.workspace.outwardNames({ ...workspaceRequest(query.arguments, repository), ...signal });
      if (!result.ok) return result;
      const read: FactRead<PublicWorkspaceValue> = { ...result.value, fact: withoutRepositories(result.value.fact) };
      return finish(read, query, repository, false, moved, ctx, undefined, (read, rest) => ({ family: "workspace", read, query, ...rest }));
    }
    case "ye_ast_decisions": {
      const result = await deps.decisions.decisions({ ...workspaceRequest(query.arguments, repository), ...signal });
      if (!result.ok) return result;
      return finish(result.value, query, repository, false, moved, ctx, undefined, (read, rest) => ({ family: "decisions", read, query, ...rest }));
    }
    case "ye_ast_contract_consequences": {
      const a = query.arguments;
      const request = {
        // A change is answered at its head: the use case pins the bound repository there and refuses a different revision.
        repo: { path: repository.path, id: repository.repoId, ...(a.live ? { live: true as const } : a.base === undefined ? { revision: a.revision ?? DEFAULT_REVISION } : {}) },
        ...(workspaceOf(a.workspace) ?? {}),
        ...scopeOf(a.scope),
        ...signal,
      };
      const { contractConsequences } = deps;
      const result = a.hypotheses === undefined
        ? await contractConsequences.ofChange({ ...request, base: a.base ?? "", head: a.head ?? DEFAULT_REVISION })
        : await contractConsequences.ofHypotheses({ ...request, hypotheses: a.hypotheses });
      if (!result.ok) return result;
      return finish({ fact: result.value }, query, repository, false, moved, ctx, undefined, (read, rest) => ({ family: "contract_consequences", read, query, ...rest }));
    }
    default:
      return unreachable(query);
  }
}

function unreachable(query: never): never {
  throw new Error(`Unsupported query ${(query as { name: string }).name}`);
}

type Rest = { recovery?: Recovery; identityGuard: RedactionIdentityGuard; live?: LiveStaleNotice };

/**
 * The public boundary, in the original order: the primary snapshot must belong to the selected repository; the fact is
 * redacted; recovery compares the public fact with the original; sidecars are redacted. Local families report the
 * selected binding as their repository root.
 */
function finish<V>(
  read: FactRead<V>,
  query: SemanticQuery,
  repository: RepositoryBinding,
  local: boolean,
  moved: LiveStaleNotice | undefined,
  ctx: QueryExecutionContext,
  recoveryFor: ((fact: Fact<V>, original: Fact<V>) => Recovery) | undefined,
  build: (read: PublicRead<V>, rest: Rest) => ExecutedSource,
): Result<ExecutedSource, QueryFault> {
  const { redaction } = ctx.deps;
  if (read.fact.snapshot.repo !== repository.repoId) return { ok: false, fault: { kind: "internal-fault", detail: "Primary snapshot repository does not match selected repository" } };
  const fact = redaction.redactValue(read.fact) as Fact<V>;
  const recovery = recoveryFor?.(fact, read.fact);
  const roots = local ? [{ repo: repository.repoId, path: repository.path }] : read.repositoryRoots;
  const repositoryRoots = roots === undefined ? undefined : redaction.redactValue(roots) as FactRead<V>["repositoryRoots"];
  const refresh = read.refresh === undefined ? undefined : redaction.redactValue(read.refresh) as WorkspaceRefresh;
  const live = moved === undefined ? undefined : redaction.redactValue(moved) as LiveStaleNotice;
  const workspaceLive = read.workspaceLive === undefined ? undefined : redaction.redactValue([...read.workspaceLive].sort((a, b) => compareText(a.repo, b.repo)).map((item) => item.kind === "staleness-unavailable" ? { ...item, cause: { ...item.cause, detail: /[\\/]/.test(item.cause.detail) ? "[path omitted]" : item.cause.detail } } : item)) as NonNullable<FactRead<V>["workspaceLive"]>;
  const workspaceReplay = read.workspaceReplay === undefined ? undefined : redaction.redactValue(read.workspaceReplay) as NonNullable<FactRead<V>["workspaceReplay"]>;
  const publicRead: PublicRead<V> = {
    fact,
    ...(workspaceReplay === undefined ? {} : { workspaceReplay }),
    ...(workspaceLive === undefined ? {} : { workspaceLive }),
    ...(repositoryRoots === undefined ? {} : { repositoryRoots }),
    ...(refresh === undefined ? {} : { refresh }),
  };
  const selected = { repository: repository.repoId, arguments: query.arguments };
  const identityGuard: RedactionIdentityGuard = {
    changedIdentityPointers: changedPointers(read.fact, fact),
    changedArguments: canonicalJson(redaction.redactValue(selected)) !== canonicalJson(selected),
    changedSnapshot: canonicalJson(fact.snapshot) !== canonicalJson(read.fact.snapshot),
  };
  return { ok: true, value: build(publicRead, { ...(recovery === undefined ? {} : { recovery }), identityGuard, ...(live === undefined ? {} : { live }) }) };
}

/** RFC 6901 pointers of the public positions whose values differ from the original; a rewritten key set names its object. */
export function changedPointers(original: unknown, published: unknown): string[] {
  const changed: string[] = [];
  const visit = (before: unknown, after: unknown, pointer: string): void => {
    if (Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) return void changed.push(pointer);
      before.forEach((item, index) => visit(item, after[index], `${pointer}/${index}`));
      return;
    }
    if (isRecord(before) && isRecord(after) && !Array.isArray(before) && !Array.isArray(after)) {
      const keys = Object.keys(after);
      const originalKeys = new Set(Object.keys(before));
      if (keys.length !== originalKeys.size || keys.some((key) => !originalKeys.has(key))) return void changed.push(pointer);
      for (const key of keys) visit(before[key], after[key], `${pointer}/${escapePointer(key)}`);
      return;
    }
    changed.push(pointer);
  };
  visit(original, published, "");
  return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function replayChanged(fault: ImpactFault | WorkspaceFault): QueryFault {
  return fault.kind === "workspace-replay-mismatch" ? { kind: "result-changed", detail: fault.detail, stage: "workspace-replay" } : fault;
}

/** The revision to read, or the working tree with the callback that learns of a change after the answer. */
function atRevision(requested: string | undefined, isLive: boolean | undefined, onStale: (notice: LiveStaleNotice) => void): { revision: string; live?: undefined } | { live: true; onStale: (notice: LiveStaleNotice) => void; revision?: undefined } {
  return isLive === true ? { live: true, onStale } : { revision: requested ?? DEFAULT_REVISION };
}

/** The scope the caller set, or nothing, so a query receives no scope it was not given. */
function scopeOf(requested: SemanticArguments<"entrypoints">["scope"]): { scope?: ScopeRequest } {
  if (requested === undefined) return {};
  const { include, exclude } = requested;
  return { scope: { ...(include !== undefined && { include }), ...(exclude !== undefined && { exclude }) } };
}

function budgetOf(requested: Partial<Record<WalkBoundsField, number | undefined>> | undefined, fields: readonly WalkBoundsField[] = WALK_BOUND_FIELDS): { budget?: ImpactBudget } {
  const bounds: Partial<Record<WalkBoundsField, number>> = {};
  for (const field of fields) {
    const value = requested?.[field];
    if (value !== undefined) bounds[field] = value;
  }
  return Object.keys(bounds).length === 0 ? {} : { budget: bounds };
}

function askedRepository(requested: { path: string; id?: string | undefined; revision?: string | undefined; live?: true | undefined }): WorkspaceRepositoryRequest {
  return {
    path: requested.path,
    ...(requested.id === undefined ? {} : { id: requested.id }),
    ...(requested.live ? { live: true as const } : requested.revision === undefined ? {} : { revision: requested.revision }),
  };
}

/** The other repositories of a `workspace` parameter, as the workspace family asks for them; without `repos` it names none, and the persisted workspace is used. */
function workspaceOf(requested: SemanticArguments<"impact">["workspace"] | SemanticArguments<"contract_consequences">["workspace"]): { repos?: WorkspaceRepositoryRequest[]; gateways?: { prefix: string; repo: string }[] } | undefined {
  if (requested === undefined) return undefined;
  return {
    ...(requested.repos === undefined ? {} : { repos: requested.repos.map(askedRepository) }),
    ...(requested.gateways === undefined ? {} : { gateways: requested.gateways }),
  };
}

function workspaceRequest(a: SemanticArguments<"workspace"> | SemanticArguments<"decisions">, repository: RepositoryBinding) {
  return {
    repo: { path: repository.path, id: repository.repoId, ...(a.live ? { live: true as const } : a.revision === undefined ? {} : { revision: a.revision }) },
    ...(a.repos === undefined ? {} : { repos: a.repos.map(askedRepository) }),
    ...(a.gateways === undefined ? {} : { gateways: a.gateways }),
    ...(a.offline === undefined ? {} : { offline: a.offline }),
    ...scopeOf(a.scope),
  };
}

function withoutRepositories(fact: Fact<WorkspaceValue>): Fact<PublicWorkspaceValue> {
  if (fact.status === "unknown") return fact;
  const { repositories: _read, ...value } = fact.value;
  return { ...fact, value };
}
