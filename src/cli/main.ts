import { unknownTargetKey } from "../core/ports/impact-queries.port.ts";
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Result } from "../core/domain/shared/result.ts";
import { isValidGlob, type ScopeRequest } from "../core/domain/shared/scope.ts";
import type { EntrypointQueries, MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactBudget } from "../core/domain/impact/impact-fact.ts";
import { isPositiveCount } from "../core/domain/shared/count.ts";
import { WALK_BOUND_FIELDS, type WalkBoundsField } from "../core/domain/shared/fact.ts";
import type { CallersTarget, ImpactCallersRequest, ImpactFault, ImpactImportersRequest, ImpactOfChangeRequest, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineFault, OutlineQueries, OutlineRequest, OutlineSelector } from "../core/ports/outline-queries.port.ts";
import type { TraceQueries } from "../core/ports/trace-queries.port.ts";
import type { WorkspaceQueries, WorkspaceRequest } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceFault } from "../core/ports/workspace-repos.port.ts";
import type { DecisionQueries, DecisionsRequest } from "../core/ports/decision-queries.port.ts";
import { isTrustMode } from "../core/domain/shared/fact.ts";
import { FIXED_LAYER_DIRECTORY } from "../core/ports/fixed-layer-store.port.ts";
import type { Install, InstallOutcome, InstallRequest, BatchInstallRequest, BatchInstallReport } from "../core/ports/install.port.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { DEFAULT_REVISION, type Vcs, type VcsFault } from "../core/ports/vcs.port.ts";
import { WORKSPACE_MANIFEST_FILE, type WorkspaceManifestFault } from "../core/ports/workspace-defaults.port.ts";

/**
 * `queryFailed`: the query answered with a typed fault. `usage`: the command line is wrong. `internalFault`: ye-ast
 * itself failed unexpectedly (sysexits `EX_SOFTWARE`). `interrupted`: the caller aborted the query; a process killed
 * by a signal exits with 128 plus the signal number instead.
 */
export const EXIT_CODE = { ok: 0, queryFailed: 1, usage: 2, internalFault: 70, interrupted: 130 } as const;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  version: string;
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  trace: TraceQueries;
  workspace: WorkspaceQueries;
  decisions: DecisionQueries;
  install: Install;
  /** The command that starts this build of ye-ast; `init` appends `mcp <repo>` and prints it as the MCP registration. */
  mcpCommand: readonly string[];
  /** Applied to every string that leaves the process on stdout or stderr. */
  redaction: Redaction;
  /** The name a repository answers to; `--repo-id` overrides it. */
  repositoryName: Vcs["repositoryName"];
  canonicalRepositoryRoot: Vcs["canonicalRoot"];
  readWorkspaceFile?: (path: string) => Promise<Result<{ path: string; text: string }, WorkspaceManifestFault>>;
  /** Aborted when the process is asked to stop. */
  signal: AbortSignal;
}

const MEASURE_FLAG = "--measure";

const USAGE = [
  "usage: ye-ast --version | --help",
  "       ye-ast map [--revision <rev> | --live] [--repo-id <id>] [scope] <repo>",
  "       ye-ast impact --base <rev> [--head <rev> | --live] [--repo-id <id>] [scope] [changed] [budget] <repo>",
  "       ye-ast callers [--revision <rev> | --live] [--repo-id <id>] [scope] [budget] <repo> <file>:<symbol> | <file>:<start>-<end> ...",
  "       ye-ast importers [--revision <rev> | --live] [--repo-id <id>] [scope] <repo> <file> ...",
  "       ye-ast outline [--revision <rev> | --live] [--repo-id <id>] [scope] <repo> <file> ...",
  "       ye-ast outline [--revision <rev> | --live] [--repo-id <id>] [scope] --focus <file>:<symbol> | --focus <file>:<line> ... <repo>",
  "       ye-ast trace [--revision <rev> | --live] [--repo-id <id>] [scope] [--depth <n>] [--expansions <n>] <repo> <file>:<symbol> | <file>:<start>-<end> ...   (what the declarations execute, in source order, with a reading plan)",
  "       ye-ast workspace [--revision <rev>] [--repo-id <id>] [--offline] [scope] <repo>",
  "       ye-ast decisions [--revision <rev>] [--repo-id <id>] [--offline] [scope] <repo>",
  "       ye-ast init --trust trusted|untrusted [--workspace <file>] [<repo>]   (declares the trust mode, writes the fixed layer under .ye-ast/, ignores ye-ast's folders locally, prints the MCP registration)",
  "       ye-ast init --trust trusted|untrusted [--workspace <file>] --repo <id> <path> [--repo <id> <path>]... <launch-repo>",
  "       ye-ast serve   (the query protocol, JSON-RPC 2.0, one message per line on stdin/stdout)",
  "       ye-ast mcp [<launch-root>] [--repo <id> <root>]...   (read-only stdio MCP server)",
  "--repo-id: the name every fact carries; the directory name of the repository's main worktree when omitted, so every worktree of one repository answers the same name",
  "--live: reads the working tree of a repository declared trusted (ye-ast init --trust trusted) instead of a revision; the first run builds ye-ast's mirror of it, and a stale answer is reported on stderr and as a live sibling of the fact in the JSON",
  "--focus: outline only, repeatable, instead of files: <file>:<symbol> selects the declarations whose dotted containment path ends with it at whole names (Class.member, or a bare name at any depth); <file>:<line> the innermost declaration holding that line. Each match comes with its containers and how many of the file's declarations were left out, without imports",
  "--offline: reads every repository from its own clone and refreshes no declared remote, as under untrusted; only workspace and decisions take it",
  "scope: [--include <glob>]... [--exclude <glob>]...   (globs over repository-relative paths, on map, impact, callers, importers, outline, trace, workspace and decisions; without --include every path is included; --exclude wins)",
  "changed: [--changed <glob>]...   (impact only: globs over the changed paths; only the change's paths they select seed the walk, while the repository is read whole, so callers outside them are known; a glob that selects no changed path is an error)",
  "budget: [--depth <n>] [--hub-fan-in <n>] [--expansions <n>]   (positive integers; none has a default; trace takes no --hub-fan-in, which counts callers)",
  "workspace: --workspace <file>   (the workspace init persists as .ye-ast/workspace.json: { \"repos\": [{ \"path\", \"id\", \"revision\", \"remote\" }], \"gateways\": [{ \"prefix\", \"repo\" }] }; a relative repository path is stored as written and resolved against the installed repository, and a remote is the source of truth a trusted repository's queries refresh into ye-ast's own mirror)",
  "measure: --measure   (one JSON measurement line per query and per index build, on stderr; never on stdout)",
].join("\n");

type Query = () => Promise<Result<unknown, ImpactFault | OutlineFault | WorkspaceFault>>;

/** The stale notice a live query reports once its answer is built, when the working tree moved. */
interface StaleWatch {
  notice?: LiveStaleNotice;
}

/** What the CLI prints for an answer: its fact, and the stale notice beside it as the same response-level sibling the MCP carries. */
function printedAnswer(redaction: Redaction, value: unknown, notice: LiveStaleNotice | undefined): unknown {
  const fact = redaction.redactValue(value);
  return notice === undefined ? fact : { ...(fact as Record<string, unknown>), live: redaction.redactValue(notice) };
}

export async function run(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  const [command, ...named] = argv;
  const args = named.filter((argument) => argument !== MEASURE_FLAG);
  if (command === "--version") {
    io.out(deps.version);
    return EXIT_CODE.ok;
  }
  if (command === "--help") {
    io.out(USAGE);
    return EXIT_CODE.ok;
  }
  if (command === "init") return runInit(named.includes("--repo") ? named : args, io, deps);
  try {
    const moved: StaleWatch = {};
    const query = await queryOf(command, args, deps, io, moved);
    if (query === undefined) {
      io.err(USAGE);
      return EXIT_CODE.usage;
    }
    const result = await query();
    if (!result.ok) {
      for (const line of faultText(result.fault, deps.redaction)) io.err(line);
      return result.fault.kind === "aborted" ? EXIT_CODE.interrupted : EXIT_CODE.queryFailed;
    }
    io.out(JSON.stringify(printedAnswer(deps.redaction, result.value, moved.notice), null, 2));
    return EXIT_CODE.ok;
  } catch (error) {
    io.err(`ye-ast: internal fault: ${deps.redaction.redact(firstLine(error))}`);
    return EXIT_CODE.internalFault;
  }
}

/** Every line a fault prints: the kind and detail, then the symbol each entry named and what its file declares. */
function faultText(fault: ImpactFault | OutlineFault | WorkspaceFault, redaction: Redaction): string[] {
  const entries =
    fault.kind === "unknown-symbol" ? fault.entries.map((entry) => `  - ${unknownTargetKey(entry)}: ${declarationText(entry)}`)
    : fault.kind === "top-level-line" ? fault.entries.map((entry) => `  - ${entry.file}:${entry.line}: ${declarationText(entry)}`)
    : [];
  return [`ye-ast: ${fault.kind}: ${redaction.redact(fault.detail.trim())}`, ...entries.map((line) => redaction.redact(line))];
}

/** What a fault entry can be told to the caller: the declarations of the file that could have been asked instead. */
function declarationText(entry: { file: string; candidates: readonly string[] }): string {
  return entry.candidates.length === 0 ? `${entry.file} declares no symbol` : `declared in ${entry.file}: ${entry.candidates.join(", ")}`;
}

async function runInit(args: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  try {
    if (args.includes("--repo")) return await runBatchInit(args, io, deps);
    const parsed = await parseInitRequest(args, deps);
    if (parsed === undefined) {
      io.err(USAGE);
      return EXIT_CODE.usage;
    }
    const { workspaceFile, ...request } = parsed;
    const workspace = workspaceFile === undefined ? undefined : await readWorkspaceFile(workspaceFile);
    if (workspace !== undefined && !workspace.ok) {
      io.err(deps.redaction.redact(`ye-ast: ${workspace.fault.kind}: ${workspace.fault.detail}`));
      return EXIT_CODE.queryFailed;
    }
    const result = await deps.install.run({ ...request, ...(workspace === undefined ? {} : { workspace: workspace.value }), signal: deps.signal });
    if (!result.ok) {
      if (result.fault.trustRecorded) io.err(`ye-ast: trust ${request.trust} was recorded outside the repository before init stopped`);
      io.err(`ye-ast: ${result.fault.kind}: ${deps.redaction.redact(result.fault.detail.trim())}`);
      return result.fault.kind === "aborted" ? EXIT_CODE.interrupted : EXIT_CODE.queryFailed;
    }
    for (const line of initReport(result.value, request.repo, deps.mcpCommand)) io.out(line);
    return EXIT_CODE.ok;
  } catch (error) {
    io.err(`ye-ast: internal fault: ${deps.redaction.redact(firstLine(error))}`);
    return EXIT_CODE.internalFault;
  }
}

async function runBatchInit(args: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  let trust: string | undefined;
  let workspaceFile: string | undefined;
  let launchPath: string | undefined;
  const repositories: { path: string; id: string }[] = [];
  const operand = (value: string | undefined): value is string => value !== undefined && value.trim() !== "" && !value.startsWith("-");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repo") {
      const id = args[++i];
      const path = args[++i];
      if (!operand(id) || !operand(path)) { io.err(USAGE); return EXIT_CODE.usage; }
      repositories.push({ id, path: resolve(path) });
    } else if (arg === "--trust" || arg === "--workspace") {
      const value = args[++i];
      if (!operand(value) || (arg === "--trust" ? trust !== undefined : workspaceFile !== undefined)) { io.err(USAGE); return EXIT_CODE.usage; }
      if (arg === "--trust") trust = value;
      else workspaceFile = resolve(value);
    } else if (operand(arg) && launchPath === undefined) {
      launchPath = resolve(arg);
    } else {
      io.err(USAGE);
      return EXIT_CODE.usage;
    }
  }
  if (!isTrustMode(trust) || !launchPath || repositories.length === 0) {
    io.err(USAGE);
    return EXIT_CODE.usage;
  }
  type Target = BatchInstallReport["targets"][number];
  const launch = { path: launchPath, id: "" };
  const selected = [...repositories, launch];
  const targets: Target[] = selected.map(({ path, id }) => ({ requestedPaths: [path], id, status: "not-attempted", trust: "not-recorded" }));
  const launchIndex = targets.length - 1;
  const emit = (report: BatchInstallReport, code: number): number => {
    io.out(JSON.stringify(deps.redaction.redactValue(report)));
    return code;
  };
  const aborted = (): number => emit({ targets, termination: "aborted" }, EXIT_CODE.interrupted);
  const fail = (index: number, fault: VcsFault | WorkspaceManifestFault): number => {
    targets[index] = { ...targets[index]!, status: "failed", stage: "preflight", fault: { ...fault, stage: "preflight", trustRecorded: false } };
    return emit({ targets, ...(fault.kind === "aborted" ? { termination: "aborted" as const } : {}) }, fault.kind === "aborted" ? EXIT_CODE.interrupted : EXIT_CODE.queryFailed);
  };
  let active = launchIndex;
  let installing = false;
  let report: BatchInstallReport;
  if (deps.signal.aborted) return aborted();
  try {
    const canonical = await deps.canonicalRepositoryRoot(launchPath, deps.signal);
    if (deps.signal.aborted) return aborted();
    if (!canonical.ok) return fail(launchIndex, canonical.fault);
    for (const [index, candidate] of repositories.entries()) {
      active = index;
      const root = await deps.canonicalRepositoryRoot(candidate.path, deps.signal);
      if (deps.signal.aborted) return aborted();
      if (!root.ok) return fail(index, root.fault);
      if (root.value === canonical.value) {
        launch.id = candidate.id;
        break;
      }
    }
    active = launchIndex;
    if (!launch.id) {
      const named = await deps.repositoryName(launchPath, deps.signal);
      if (deps.signal.aborted) return aborted();
      if (!named.ok && named.fault.kind === "aborted") return fail(launchIndex, named.fault);
      launch.id = named.ok ? named.value : basename(launchPath);
    }
    targets[launchIndex] = { ...targets[launchIndex]!, id: launch.id };
    const workspace = workspaceFile === undefined ? undefined : await (deps.readWorkspaceFile ?? readWorkspaceFile)(workspaceFile);
    if (deps.signal.aborted) return aborted();
    if (workspace && !workspace.ok) return fail(launchIndex, workspace.fault);
    const request: BatchInstallRequest = { launch, repositories: selected, trust, ...(workspace?.ok ? { workspace: workspace.value } : {}), signal: deps.signal };
    installing = true;
    report = await deps.install.runBatch(request);
  } catch {
    if (deps.signal.aborted && !installing) return aborted();
    if (installing) {
      for (let index = 0; index < targets.length; index++) {
        targets[index] = { ...targets[index]!, status: "failed", trust: "unknown" };
      }
    } else {
      targets[active] = { ...targets[active]!, status: "failed", stage: "preflight" };
    }
    return emit({ targets, termination: "unexpected" }, EXIT_CODE.internalFault);
  }
  io.out(JSON.stringify(deps.redaction.redactValue(report)));
  if (report.termination === "aborted") return EXIT_CODE.interrupted;
  if (report.termination === "unexpected") return EXIT_CODE.internalFault;
  if (report.targets.length === 0 || report.targets.some((target) => target.status !== "completed" || !target.canonicalRoot || !target.outcome || target.outcome.layer.outcome === "not-written")) return EXIT_CODE.queryFailed;
  const launchTarget = report.targets.find((target) => target.id === launch.id && target.requestedPaths.includes(launch.path));
  if (!launchTarget?.canonicalRoot || !deps.mcpCommand[0]) return EXIT_CODE.internalFault;
  const registration = { command: deps.mcpCommand[0], args: [...deps.mcpCommand.slice(1), "mcp", launchTarget.canonicalRoot, ...report.targets.flatMap((target) => ["--repo", target.id, target.canonicalRoot!])] };
  io.out(JSON.stringify(deps.redaction.redactValue(registration)));
  return EXIT_CODE.ok;
}

/** The manifest the user named: the CLI reads the file, since the core reads no environment. */
async function readWorkspaceFile(path: string): Promise<Result<{ path: string; text: string }, WorkspaceManifestFault>> {
  try {
    return { ok: true, value: { path, text: await readFile(path, "utf8") } };
  } catch (error) {
    return { ok: false, fault: { kind: "workspace-invalid", detail: `${path}: ${firstLine(error)}` } };
  }
}

function initReport({ trust, excluded, layer, workspace }: InstallOutcome, repo: string, mcpCommand: readonly string[]): string[] {
  const layerLines =
    layer.outcome === "not-written"
      ? [`fixed layer: not written (${layer.reason})`]
      : layer.files.map((file) => `${FIXED_LAYER_DIRECTORY}/${file}: ${layer.outcome}`);
  return [
    `trust: ${trust} (recorded outside the repository)`,
    excluded.length === 0 ? "local exclude: already held" : `local exclude: added ${excluded.join(" ")}`,
    ...layerLines,
    ...(workspace === undefined ? [] : [`${FIXED_LAYER_DIRECTORY}/${WORKSPACE_MANIFEST_FILE}: ${workspace.outcome}`]),
    "register the MCP server with Claude Code:",
    `claude mcp add ye-ast -- ${mcpCommand.map(shellWord).join(" ")} mcp ${shellWord(repo)}`,
  ];
}

function shellWord(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

async function queryOf(command: string | undefined, args: readonly string[], deps: CliDeps, io: CliIo, moved: StaleWatch): Promise<Query | undefined> {
  const { signal } = deps;
  const onStale = (notice: LiveStaleNotice): void => {
    moved.notice = notice;
    io.err(deps.redaction.redact(`ye-ast: stale: the working tree changed after this answer, which reflects state ${notice.stateId}: ${notice.changed.join(", ")}`));
  };
  switch (command) {
    case "map": {
      const request = await parseMapRequest(args, deps);
      return request && (() => deps.entrypoints.map({ ...request, signal, ...(request.live && { onStale }) }));
    }
    case "impact": {
      const request = await parseImpactRequest(args, deps);
      return request && (() => deps.impact.ofChange({ ...request, signal, ...(request.live && { onStale }) }));
    }
    case "callers": {
      const request = await parseCallersRequest(args, deps);
      return request && (() => deps.impact.callers({ ...request, signal, ...(request.live && { onStale }) }));
    }
    case "importers": {
      const request = await parseImportersRequest(args, deps);
      return request && (() => deps.impact.importers({ ...request, signal, ...(request.live && { onStale }) }));
    }
    case "outline": {
      const request = await parseOutlineRequest(args, deps);
      return request && (() => deps.outline.outline({ ...request, signal, ...(request.live && { onStale }) }));
    }
    case "trace": {
      const request = await parseCallersRequest(args, deps, TRACE_BUDGET_OPTIONS);
      return request && (() => deps.trace.walk({ ...request, signal, ...(request.live && { onStale }) }));
    }
    case "workspace": {
      const request = await parseWorkspaceRequest(args, deps);
      return request && (() => deps.workspace.outwardNames({ ...request, signal }));
    }
    case "decisions": {
      const request = await parseDecisionsRequest(args, deps);
      return request && (() => deps.decisions.decisions({ ...request, signal }));
    }
    default:
      return undefined;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
}

/** What naming a repository needs, so a command that parses one asks for no query family it will not run. */
type RepositoryNaming = Pick<CliDeps, "repositoryName" | "signal">;

/**
 * The repository a command line names and the name it answers to: the one the caller gave, or the one git states, so every
 * worktree of one repository carries the same name. A name never fails a command before its own query does: whatever git
 * cannot name keeps the directory name.
 */
async function repositoryOf(deps: RepositoryNaming, path: string, repoId: string | undefined): Promise<{ repo: string; repoId: string }> {
  const repo = resolve(path);
  if (repoId !== undefined) return { repo, repoId };
  const named = await deps.repositoryName(repo, deps.signal).catch(() => undefined);
  return { repo, repoId: named?.ok ? named.value : basename(repo) };
}

async function parseMapRequest(args: readonly string[], deps: RepositoryNaming): Promise<MapRequest | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { revision: { type: "string" }, live: { type: "boolean" }, "repo-id": { type: "string" }, ...SCOPE_OPTIONS },
      allowPositionals: true,
    });
    const [path, ...extra] = positionals;
    const scope = parseScope(values);
    const at = atRevision(values);
    if (path === undefined || extra.length > 0 || scope === undefined || at === undefined) return undefined;
    return { ...(await repositoryOf(deps, path, values["repo-id"])), ...at, ...scope };
  } catch {
    return undefined;
  }
}

/** What the `init` flags name: the request, and the manifest file to read before it runs. */
interface ParsedInit extends Omit<InstallRequest, "signal" | "workspace"> {
  /** The path of the manifest to persist, resolved against the working directory. */
  workspaceFile?: string;
}

async function parseInitRequest(args: readonly string[], deps: RepositoryNaming): Promise<ParsedInit | undefined> {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options: { trust: { type: "string" }, workspace: { type: "string" } }, allowPositionals: true });
    const [path = ".", ...extra] = positionals;
    if (!isTrustMode(values.trust) || extra.length > 0 || values.workspace === "") return undefined;
    return { ...(await repositoryOf(deps, path, undefined)), trust: values.trust, ...(values.workspace === undefined ? {} : { workspaceFile: resolve(values.workspace) }) };
  } catch {
    return undefined;
  }
}

/** `--live` or a revision, never both; HEAD when neither is given. */
function atRevision(values: { revision?: string | undefined; live?: boolean | undefined }): { live: true; revision?: undefined } | { revision: string; live?: undefined } | undefined {
  if (values.live !== true) return { revision: values.revision ?? DEFAULT_REVISION };
  return values.revision === undefined ? { live: true } : undefined;
}

const SCOPE_OPTIONS = { include: { type: "string", multiple: true }, exclude: { type: "string", multiple: true } } as const;

const CHANGED_OPTION = { changed: { type: "string", multiple: true } } as const;

type ChangedValues = { [Name in keyof typeof CHANGED_OPTION]?: string[] | undefined };

/** The selection over the change the flags name, `undefined` for a glob that is not valid, `{}` when no flag is given. */
function parseChanged(values: ChangedValues): { changed?: readonly string[] } | undefined {
  const globs = values.changed;
  if (globs === undefined) return {};
  return globs.every(isValidGlob) ? { changed: globs } : undefined;
}

type ScopeValues = { [Name in keyof typeof SCOPE_OPTIONS]?: string[] | undefined };

/** The scope the flags name, `undefined` for an invalid glob, `{}` when no flag is given. */
function parseScope(values: ScopeValues): { scope?: ScopeRequest } | undefined {
  const scope: ScopeRequest = {};
  for (const field of ["include", "exclude"] as const) {
    const globs = values[field];
    if (globs === undefined) continue;
    if (!globs.every(isValidGlob)) return undefined;
    scope[field] = globs;
  }
  return Object.keys(scope).length === 0 ? {} : { scope };
}

const BUDGET_OPTIONS = { depth: { type: "string" }, "hub-fan-in": { type: "string" }, expansions: { type: "string" } } as const;

/** A trace walks outbound, where a caller count bounds nothing. */
const TRACE_BUDGET_OPTIONS = { depth: BUDGET_OPTIONS.depth, expansions: BUDGET_OPTIONS.expansions } as const;

type BudgetValues = { [Name in keyof typeof BUDGET_OPTIONS]?: string | undefined };

/** The budget the flags name, `undefined` for a value that is not a positive integer, `{}` when no flag is given. */
function parseBudget(values: BudgetValues): ImpactBudget | undefined {
  const named: Readonly<Record<WalkBoundsField, string | undefined>> = { depth: values.depth, hubFanIn: values["hub-fan-in"], expansions: values.expansions };
  const budget: Partial<Record<WalkBoundsField, number>> = {};
  for (const field of WALK_BOUND_FIELDS) {
    const text = named[field];
    if (text === undefined) continue;
    const value = Number(text);
    if (!/^[1-9]\d*$/.test(text) || !isPositiveCount(value)) return undefined;
    budget[field] = value;
  }
  return budget;
}

function withBudget(budget: ImpactBudget): { budget?: ImpactBudget } {
  return Object.keys(budget).length === 0 ? {} : { budget };
}

async function parseImpactRequest(args: readonly string[], deps: RepositoryNaming): Promise<ImpactOfChangeRequest | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { base: { type: "string" }, head: { type: "string" }, live: { type: "boolean" }, "repo-id": { type: "string" }, ...SCOPE_OPTIONS, ...CHANGED_OPTION, ...BUDGET_OPTIONS },
      allowPositionals: true,
    });
    const [path, ...extra] = positionals;
    const budget = parseBudget(values);
    const scope = parseScope(values);
    const changed = parseChanged(values);
    const at = atRevision({ revision: values.head, live: values.live });
    if (path === undefined || extra.length > 0 || values.base === undefined || budget === undefined || scope === undefined || changed === undefined || at === undefined) return undefined;
    return { ...(await repositoryOf(deps, path, values["repo-id"])), base: values.base, ...(at.live ? { live: true as const } : { head: at.revision }), ...scope, ...changed, ...withBudget(budget) };
  } catch {
    return undefined;
  }
}

async function parseCallersRequest(args: readonly string[], deps: RepositoryNaming, budgetOptions: Partial<typeof BUDGET_OPTIONS> = BUDGET_OPTIONS): Promise<ImpactCallersRequest | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { revision: { type: "string" }, live: { type: "boolean" }, "repo-id": { type: "string" }, ...SCOPE_OPTIONS, ...budgetOptions },
      allowPositionals: true,
    }) as { values: { revision?: string; live?: boolean; "repo-id"?: string } & ScopeValues & BudgetValues; positionals: string[] };
    const [path, ...specs] = positionals;
    const budget = parseBudget(values);
    const targets = specs.map(parseTarget);
    const scope = parseScope(values);
    const at = atRevision(values);
    if (path === undefined || targets.length === 0 || budget === undefined || scope === undefined || at === undefined || targets.some((target) => target === undefined)) return undefined;
    return { ...(await repositoryOf(deps, path, values["repo-id"])), ...at, targets: targets as CallersTarget[], ...scope, ...withBudget(budget) };
  } catch {
    return undefined;
  }
}

async function parseOutlineRequest(args: readonly string[], deps: RepositoryNaming): Promise<OutlineRequest | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { revision: { type: "string" }, live: { type: "boolean" }, "repo-id": { type: "string" }, focus: { type: "string", multiple: true }, ...SCOPE_OPTIONS },
      allowPositionals: true,
    });
    const [path, ...files] = positionals;
    const scope = parseScope(values);
    const at = atRevision(values);
    const focus = (values.focus ?? []).map(parseSelector);
    if (path === undefined || (files.length === 0) === (focus.length === 0) || scope === undefined || at === undefined || focus.some((selector) => selector === undefined)) return undefined;
    const subject = focus.length === 0 ? { files } : { focus: focus as OutlineSelector[] };
    return { ...(await repositoryOf(deps, path, values["repo-id"])), ...at, ...subject, ...scope };
  } catch {
    return undefined;
  }
}

/** `<file>:<symbol>` or `<file>:<line>`: what follows the last colon is a line when it is digits only, since no name is. */
function parseSelector(spec: string): OutlineSelector | undefined {
  const colon = spec.lastIndexOf(":");
  const file = spec.slice(0, colon);
  const rest = spec.slice(colon + 1);
  if (colon <= 0 || rest === "") return undefined;
  if (!/^\d/.test(rest)) return { file, symbol: rest };
  const line = Number(rest);
  return /^[1-9]\d*$/.test(rest) && Number.isSafeInteger(line) ? { file, line } : undefined;
}

async function parseWorkspaceRequest(args: readonly string[], deps: RepositoryNaming): Promise<WorkspaceRequest | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { revision: { type: "string" }, "repo-id": { type: "string" }, offline: { type: "boolean" }, ...SCOPE_OPTIONS },
      allowPositionals: true,
    });
    const [path, ...extra] = positionals;
    const scope = parseScope(values);
    if (path === undefined || extra.length > 0 || scope === undefined) return undefined;
    const { repo, repoId } = await repositoryOf(deps, path, values["repo-id"]);
    return { repo: { path: repo, id: repoId, revision: values.revision ?? DEFAULT_REVISION }, ...scope, ...(values.offline === true ? { offline: true } : {}) };
  } catch {
    return undefined;
  }
}

function parseDecisionsRequest(args: readonly string[], deps: RepositoryNaming): Promise<DecisionsRequest | undefined> {
  return parseWorkspaceRequest(args, deps);
}

async function parseImportersRequest(args: readonly string[], deps: RepositoryNaming): Promise<ImpactImportersRequest | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { revision: { type: "string" }, live: { type: "boolean" }, "repo-id": { type: "string" }, ...SCOPE_OPTIONS },
      allowPositionals: true,
    });
    const [path, ...files] = positionals;
    const scope = parseScope(values);
    const at = atRevision(values);
    if (path === undefined || files.length === 0 || scope === undefined || at === undefined) return undefined;
    return { ...(await repositoryOf(deps, path, values["repo-id"])), ...at, files, ...scope };
  } catch {
    return undefined;
  }
}

const LINE_RANGE = /^([1-9]\d*)-([1-9]\d*)$/;

/** `<file>:<symbol>` or `<file>:<start>-<end>`: what follows the last colon starting with a digit is a range, since no name does. */
function parseTarget(spec: string): CallersTarget | undefined {
  const colon = spec.lastIndexOf(":");
  const file = spec.slice(0, colon);
  const rest = spec.slice(colon + 1);
  if (colon <= 0 || rest === "") return undefined;
  if (!/^\d/.test(rest)) return { file, symbol: rest };
  const range = LINE_RANGE.exec(rest);
  const [start, end] = [Number(range?.[1]), Number(range?.[2])];
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? { file, start, end } : undefined;
}
