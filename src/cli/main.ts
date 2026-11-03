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
import { isTrustMode } from "../core/domain/shared/fact.ts";
import { FIXED_LAYER_DIRECTORY } from "../core/ports/fixed-layer-store.port.ts";
import type { Install, InstallOutcome, InstallRequest } from "../core/ports/install.port.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import { DEFAULT_REVISION, type Vcs } from "../core/ports/vcs.port.ts";
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
  install: Install;
  /** The command that starts this build of ye-ast; `init` appends `mcp <repo>` and prints it as the MCP registration. */
  mcpCommand: readonly string[];
  /** Applied to every string that leaves the process on stdout or stderr. */
  redaction: Redaction;
  /** The name a repository answers to; `--repo-id` overrides it. */
  repositoryName: Vcs["repositoryName"];
  /** Aborted when the process is asked to stop. */
  signal: AbortSignal;
}

const MEASURE_FLAG = "--measure";

const USAGE = [
  "usage: ye-ast --version | --help",
  "       ye-ast map [--revision <rev> | --live] [--repo-id <id>] [scope] <repo>",
  "       ye-ast impact --base <rev> [--head <rev> | --live] [--repo-id <id>] [scope] [budget] <repo>",
  "       ye-ast callers [--revision <rev> | --live] [--repo-id <id>] [scope] [budget] <repo> <file>:<symbol> | <file>:<start>-<end> ...",
  "       ye-ast importers [--revision <rev> | --live] [--repo-id <id>] [scope] <repo> <file> ...",
  "       ye-ast init --trust trusted|untrusted [--workspace <file>] [<repo>]   (declares the trust mode, writes the fixed layer under .ye-ast/, ignores ye-ast's folders locally, prints the MCP registration)",
  "       ye-ast serve   (the query protocol, JSON-RPC 2.0, one message per line on stdin/stdout)",
  "       ye-ast mcp [<repo>]   (stdio MCP server, read-only, bound to <repo> or the working directory)",
  "--repo-id: the name every fact carries; the directory name of the repository's main worktree when omitted, so every worktree of one repository answers the same name",
  "--live: reads the working tree of a repository declared trusted (ye-ast init --trust trusted) instead of a revision; the first run builds ye-ast's mirror of it, and a stale answer is reported on stderr and as a live sibling of the fact in the JSON",
  "scope: [--include <glob>]... [--exclude <glob>]...   (globs over repository-relative paths, on map, impact, callers and importers; without --include every path is included; --exclude wins)",
  "budget: [--depth <n>] [--hub-fan-in <n>] [--expansions <n>]   (positive integers; none has a default)",
  "workspace: --workspace <file>   (the workspace init persists as .ye-ast/workspace.json: { \"repos\": [{ \"path\", \"id\", \"revision\", \"remote\" }], \"gateways\": [{ \"prefix\", \"repo\" }] }; a relative repository path is stored as written and resolved against the installed repository, and a remote is the source of truth a trusted repository's queries refresh into ye-ast's own mirror)",
  "measure: --measure   (one JSON measurement line per query and per index build, on stderr; never on stdout)",
  "--type-root <dir>: the directory holding the dependency declarations a type layer reads, laid out like a node_modules tree; without it no type information answers and every fact is the one ye-ast gives today",
].join("\n");

type Query = () => Promise<Result<unknown, ImpactFault>>;

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
  if (command === "init") return runInit(args, io, deps);
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
function faultText(fault: ImpactFault, redaction: Redaction): string[] {
  const entries = fault.kind === "unknown-symbol" ? fault.entries.map((entry) => `  - ${entry.file}:${entry.symbol}: ${declarationText(entry)}`) : [];
  return [`ye-ast: ${fault.kind}: ${redaction.redact(fault.detail.trim())}`, ...entries.map((line) => redaction.redact(line))];
}

/** What a fault entry can be told to the caller: the declarations of the file that could have been asked instead. */
function declarationText(entry: { file: string; candidates: readonly string[] }): string {
  return entry.candidates.length === 0 ? `${entry.file} declares no symbol` : `declared in ${entry.file}: ${entry.candidates.join(", ")}`;
}

async function runInit(args: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  try {
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
      options: { base: { type: "string" }, head: { type: "string" }, live: { type: "boolean" }, "repo-id": { type: "string" }, ...SCOPE_OPTIONS, ...BUDGET_OPTIONS },
      allowPositionals: true,
    });
    const [path, ...extra] = positionals;
    const budget = parseBudget(values);
    const scope = parseScope(values);
    const at = atRevision({ revision: values.head, live: values.live });
    if (path === undefined || extra.length > 0 || values.base === undefined || budget === undefined || scope === undefined || at === undefined) return undefined;
    return { ...(await repositoryOf(deps, path, values["repo-id"])), base: values.base, ...(at.live ? { live: true as const } : { head: at.revision }), ...scope, ...withBudget(budget) };
  } catch {
    return undefined;
  }
}

async function parseCallersRequest(args: readonly string[], deps: RepositoryNaming): Promise<ImpactCallersRequest | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { revision: { type: "string" }, live: { type: "boolean" }, "repo-id": { type: "string" }, ...SCOPE_OPTIONS, ...BUDGET_OPTIONS },
      allowPositionals: true,
    });
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
