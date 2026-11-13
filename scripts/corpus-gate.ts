/**
 * The corpus gate (ADR-0039). Runs the queries a corpus manifest declares through the CLI of a base and a candidate
 * engine revision, each from its own clean worktree over fresh clones of the corpus, compares every answer, and fails
 * when a difference is not one the change declared with `--expect`. The report carries the cut ledger of each side and
 * their difference (RFC-0031), and the value ledger: the entries the facts hold by collection, with the entries gained,
 * lost and changed; and the occurrence oracle: the lines that write a target's name, classed by what each answer says
 * about them, with the unaccounted ones listed as leads and those of the classes it sets apart in a second file. It
 * fails the run only for a reason declared with `--expect-cuts` that did not move as declared. A pass is recorded where
 * the `.githooks` reference hook looks for it. Nothing is written to the corpus repositories.
 *
 *   node --import tsx scripts/corpus-gate.ts --corpus <manifest> [--base <rev>] [--candidate <rev>]
 *     [--expect none | --expect <family>:<+|-|±>]... [--expect-cuts <reason>:<+|-|±>]... [--engine <repo>] [--out <dir>]
 *     [--concurrency <n>]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { type Answer, type AnswerComparison, type Expectation, ExpectationError, type Violation, compareAnswers, parseExpectations, violations } from "./corpus-gate-diff.ts";
import { type CutExpectation, type CutLedger, CutLedgerError, type CutViolation, type LedgerDifference, type LedgerValues, cutLedger, cutViolations, ledgerDifference, parseCutExpectations } from "./corpus-gate-ledger.ts";
import { type ClassCounts, type Lead, type OccurrenceDifferenceRow, type OccurrenceKey, type OccurrenceLedger, OCCURRENCE_CLASSES, type RelationsAt, SET_APART_CLASSES, type SnapshotRelations, type WrittenAt, type WrittenLine, leadsText, occurrenceDifference, occurrenceLedger, occurrenceSnapshots, setApartText } from "./corpus-gate-occurrences.ts";
import { createJavaImportsReader } from "../src/core/adapters/spring/java-imports.adapter.ts";
import { withJavaSources } from "../src/core/adapters/spring/java-project.ts";
import { createJavaParser } from "../src/core/adapters/tree-sitter/java-parser.adapter.ts";
import { createAngularDeclarationReader } from "../src/core/adapters/typescript/angular-declarations.adapter.ts";
import { createModuleDependenciesReader } from "../src/core/adapters/typescript/module-dependencies.adapter.ts";
import { isJavaSource } from "../src/core/domain/languages/java.ts";
import { isModuleConfigFile, isPackageManifest, isTypeScriptFile } from "../src/core/domain/languages/typescript.ts";
import type { SourceFile } from "../src/core/ports/entrypoint-extractor.port.ts";
import { type ValueDifference, type ValueKey, type ValueLedger, valueDifference, valueLedger } from "./corpus-gate-values.ts";

export const EXIT = { pass: 0, fail: 1, usage: 2, fault: 3 } as const;

const USAGE = "usage: node --import tsx scripts/corpus-gate.ts --corpus <manifest> [--base <rev>] [--candidate <rev>] [--expect none | --expect <family>:<+|-|±>]... [--expect-cuts <reason>:<+|-|±>]... [--engine <repo>] [--out <dir>] [--concurrency <n>]";
/** Repositories are disjoint across groups; queries within one group share an index and run after its init. */
const DEFAULT_CONCURRENCY = 3;
const REPO_PLACEHOLDER = /\{repo:([^}]+)\}/gu;
/** In a trusted query, the workspace `init` declared, with each member at the absolute path of its clone. */
const WORKSPACE_PLACEHOLDER = "{workspace}";
const RUNNER_DIGEST = createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex");

export type GateFaultCode = "invalid-manifest" | "missing-revision" | "dependencies-differ" | "no-dependencies" | "no-cli-script" | "busy" | "git-failed" | "unknown-repository" | CutLedgerError["code"];

class UsageError extends Error {}

export class GateFault extends Error {
  constructor(readonly code: GateFaultCode, readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const ManifestSchema = z.strictObject({
  groups: z
    .array(
      z.strictObject({
        id: Id,
        repos: z.array(z.strictObject({ id: Id, path: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/u) })).min(1),
        /** What `init --trust trusted` installs on clones of their own: at `launch`, with `--workspace` naming the members when there are any. */
        workspace: z.strictObject({ launch: Id, members: z.array(Id), gateways: z.array(z.unknown()).optional() }).optional(),
        /**
         * `trusted` queries run on the workspace's clones, every other one on clones no trust was ever declared for; only a
         * trusted query of a workspace with members may name `{workspace}`.
         */
        /** `candidateArgs` follow the command on the candidate side only: an option the base does not know yet. */
        queries: z.array(z.strictObject({ id: Id, family: Id, trusted: z.boolean().optional(), argv: z.array(z.string()).min(1), candidateArgs: z.array(z.string()).min(1).optional() })).min(1),
      }),
    )
    .min(1),
});
type Manifest = z.infer<typeof ManifestSchema>;
type Group = Manifest["groups"][number];

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Revision {
  label: "base" | "candidate";
  rev: string;
  commit: string;
  tree: string;
}

interface SideResult {
  answers: Answer[];
  directory: string;
  cached: boolean;
  wallMs: number | null;
}

interface Context {
  engineRoot: string;
  store: string;
  scratch: string;
  manifest: Manifest;
  manifestDirectory: string;
  manifestDigest: string;
  io: Io;
}

/** Where a pass for the change from `baseTree` to `candidateTree` is recorded; the reference hook reads the same path. */
export function passMarkerPath(gitCommonDirectory: string, baseTree: string, candidateTree: string): string {
  return join(gitCommonDirectory, "corpus-gate", "passed", `${baseTree}-${candidateTree}`);
}

/**
 * The scratch root of a store's runs: a fixed path, so answers kept from an earlier run were produced under the same
 * paths as a new run's, whatever the engine prints or redacts of them. The lock makes the path exclusive.
 */
export function scratchDirectory(store: string): string {
  return join(tmpdir(), `ye-ast-corpus-gate-${sha256(store).slice(0, 16)}`);
}

export async function runGate(args: readonly string[], io: Io): Promise<number> {
  let options: ReturnType<typeof parseOptions>;
  try {
    options = parseOptions(args);
  } catch (error) {
    io.err(error instanceof ExpectationError ? `corpus-gate: ${error.message}` : USAGE);
    return EXIT.usage;
  }
  try {
    return await gate(options, io);
  } catch (error) {
    if (!(error instanceof GateFault)) throw error;
    io.err(`corpus-gate: ${error.message}`);
    return EXIT.fault;
  }
}

function parseOptions(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      corpus: { type: "string" },
      base: { type: "string", default: "main" },
      candidate: { type: "string", default: "HEAD" },
      expect: { type: "string", multiple: true, default: ["none"] },
      "expect-cuts": { type: "string", multiple: true, default: [] },
      engine: { type: "string", default: resolve(import.meta.dirname, "..") },
      out: { type: "string" },
      concurrency: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.corpus === undefined || positionals.length > 0) throw new UsageError(USAGE);
  const concurrency = Number(values.concurrency ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError(USAGE);
  return { ...values, concurrency, corpus: resolve(values.corpus), engine: resolve(values.engine), expectations: parseExpectations(values.expect), cutExpectations: parseCutExpectations(values["expect-cuts"]) };
}

async function gate(options: ReturnType<typeof parseOptions>, io: Io): Promise<number> {
  const { manifest, digest } = readManifest(options.corpus);
  const engineRoot = git(options.engine, ["rev-parse", "--show-toplevel"]);
  const commonDirectory = realpathSync(resolve(engineRoot, git(engineRoot, ["rev-parse", "--git-common-dir"])));
  const store = join(commonDirectory, "corpus-gate");
  const base = revision(engineRoot, "base", options.base);
  const candidate = revision(engineRoot, "candidate", options.candidate);
  for (const side of [base, candidate]) checkDependencies(engineRoot, side);
  checkCorpusRevisions(manifest, dirname(options.corpus));

  const release = acquireLock(store);
  try {
    const scratch = scratchDirectory(store);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const context: Context = { engineRoot, store, scratch, manifest, manifestDirectory: dirname(options.corpus), manifestDigest: digest, io };
    try {
      const baseResult = await runSide(context, base, options.concurrency);
      const candidateResult = await runSide(context, candidate, options.concurrency);
      return await report(context, options, commonDirectory, [base, baseResult], [candidate, candidateResult]);
    } finally {
      git(engineRoot, ["worktree", "prune"]);
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}

function readManifest(file: string): { manifest: Manifest; digest: string } {
  const bytes = readFileSync(file);
  let parsed: ReturnType<typeof ManifestSchema.safeParse>;
  try {
    parsed = ManifestSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new GateFault("invalid-manifest", (error as Error).message);
  }
  if (!parsed.success) throw new GateFault("invalid-manifest", z.prettifyError(parsed.error));
  const manifest = parsed.data;
  duplicates("group", manifest.groups.map((group) => group.id));
  for (const group of manifest.groups) {
    const repos = new Set(group.repos.map((repo) => repo.id));
    duplicates(`repository of ${group.id}`, group.repos.map((repo) => repo.id));
    duplicates(`query of ${group.id}`, group.queries.map((query) => query.id));
    const workspace = group.workspace;
    if (workspace !== undefined) {
      for (const id of [workspace.launch, ...workspace.members]) if (!repos.has(id)) throw new GateFault("invalid-manifest", `${group.id}: workspace names ${id}, not a repository of the group`);
      if (workspace.members.includes(workspace.launch)) throw new GateFault("invalid-manifest", `${group.id}: the launch repository is a member of its own workspace`);
    }
    for (const query of group.queries) {
      if (query.trusted === true && workspace === undefined) throw new GateFault("invalid-manifest", `${group.id}/${query.id}: trusted without a workspace`);
      if (query.argv.includes(WORKSPACE_PLACEHOLDER) && (query.trusted !== true || workspace === undefined || workspace.members.length === 0)) throw new GateFault("invalid-manifest", `${group.id}/${query.id}: ${WORKSPACE_PLACEHOLDER} outside a trusted query of a workspace with members`);
      for (const [, id] of query.argv.join(" ").matchAll(REPO_PLACEHOLDER)) if (!repos.has(id as string)) throw new GateFault("invalid-manifest", `${group.id}/${query.id}: no repository ${id}`);
    }
  }
  return { manifest, digest: sha256(bytes) };
}

function duplicates(what: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new GateFault("invalid-manifest", `${what} ${id} declared twice`);
    seen.add(id);
  }
}

function revision(engineRoot: string, label: Revision["label"], rev: string): Revision {
  const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: engineRoot, encoding: "utf8" });
  if (resolved.status !== 0) throw new GateFault("missing-revision", `${label} ${rev}`);
  const commit = resolved.stdout.trim();
  return { label, rev, commit, tree: git(engineRoot, ["rev-parse", `${commit}^{tree}`]) };
}

/** Both engines run on the dependencies installed beside the engine repository, so their lockfile must be the one installed. */
function checkDependencies(engineRoot: string, side: Revision): void {
  if (!existsSync(join(engineRoot, "node_modules"))) throw new GateFault("no-dependencies", join(engineRoot, "node_modules"));
  const committed = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${side.commit}:package-lock.json`], { cwd: engineRoot, encoding: "utf8" });
  const committedBlob = committed.status === 0 ? committed.stdout.trim() : null;
  const installedFile = join(engineRoot, "package-lock.json");
  const installedBlob = existsSync(installedFile) ? git(engineRoot, ["hash-object", installedFile]) : null;
  if (committedBlob !== installedBlob) throw new GateFault("dependencies-differ", `${side.label} ${side.rev}: package-lock.json differs from the installed one`);
}

function checkCorpusRevisions(manifest: Manifest, manifestDirectory: string): void {
  for (const group of manifest.groups) {
    for (const repo of group.repos) {
      const source = resolve(manifestDirectory, repo.path);
      const found = spawnSync("git", ["cat-file", "-e", `${repo.sha}^{commit}`], { cwd: source, encoding: "utf8" });
      if (found.status !== 0) throw new GateFault("missing-revision", `${group.id}/${repo.id} ${repo.sha}`);
    }
  }
}

function acquireLock(store: string): () => void {
  mkdirSync(store, { recursive: true });
  const path = join(store, "lock");
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new GateFault("busy", `${path} is held by process ${readFileSync(path, "utf8").trim()}; remove it if that process is gone`);
  }
  writeSync(descriptor, `${process.pid}\n`);
  closeSync(descriptor);
  return () => unlinkSync(path);
}

/**
 * The answers of one engine revision: from the store when this revision already answered this manifest on this Node
 * with this runner. Every side runs in the same directory, so both engines see the same paths.
 */
async function runSide(context: Context, side: Revision, concurrency: number): Promise<SideResult> {
  const withCandidateArgs = side.label === "candidate" && context.manifest.groups.some((group) => group.queries.some((query) => query.candidateArgs !== undefined));
  const key = sha256(JSON.stringify({ engine: side.commit, manifest: context.manifestDigest, node: process.version, runner: RUNNER_DIGEST, ...(withCandidateArgs ? { candidateArgs: true } : {}) })).slice(0, 32);
  const directory = join(context.store, "answers", key);
  if (existsSync(join(directory, "answers.json"))) {
    context.io.err(`${side.label} ${side.commit.slice(0, 12)}: answers reused from ${directory}`);
    return { answers: JSON.parse(readFileSync(join(directory, "answers.json"), "utf8")) as Answer[], directory, cached: true, wallMs: null };
  }
  const sideDirectory = join(context.scratch, "side");
  const engine = join(sideDirectory, "engine");
  git(context.engineRoot, ["worktree", "add", "--quiet", "--detach", engine, side.commit]);
  try {
    symlinkSync(realpathSync(join(context.engineRoot, "node_modules")), join(engine, "node_modules"));
    const started = Date.now();
    const { answers, timings } = await runQueries(context, side, sideDirectory, engine, concurrency);
    const wallMs = Date.now() - started;
    const partial = `${directory}.partial-${process.pid}`;
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "answers.json"), `${JSON.stringify(answers, null, 1)}\n`);
    writeFileSync(join(partial, "timings.json"), `${JSON.stringify({ wallMs, queries: timings }, null, 1)}\n`);
    renameSync(partial, directory);
    return { answers, directory, cached: false, wallMs };
  } finally {
    git(context.engineRoot, ["worktree", "remove", "--force", engine]);
    rmSync(sideDirectory, { recursive: true, force: true });
  }
}

/** Runs at most `limit` groups at a time, returns manifest order, and starts no new group after failure. */
export async function runGroups<T, R>(groups: readonly T[], limit: number, work: (group: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(groups.length);
  let next = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(limit, groups.length) }, async () => {
    while (failure === undefined) {
      const index = next++;
      if (index >= groups.length) return;
      try {
        results[index] = await work(groups[index]!);
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}

async function runQueries(context: Context, side: Revision, sideDirectory: string, engine: string, concurrency: number) {
  const home = join(sideDirectory, "home");
  const temporary = join(sideDirectory, "tmp");
  for (const directory of [home, temporary]) mkdirSync(directory, { recursive: true });
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    TMPDIR: temporary,
    LC_ALL: "C",
    DO_NOT_TRACK: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const command = cliCommand(engine);
  const roots = [realpathSync(sideDirectory), sideDirectory].sort((a, b) => b.length - a.length);
  const normalize = (text: string) => roots.reduce((normalized, root) => normalized.split(root).join("<side>"), text);
  const runGroup = async (group: Group) => {
    const answers: Answer[] = [];
    const timings: { id: string; wallMs: number }[] = [];
    const execute = (id: string, family: string, declaredArgv: readonly string[], argv: readonly string[]): Promise<void> => {
      const started = Date.now();
      return new Promise((done) => {
        const child = spawn(process.execPath, [...command, ...argv], { cwd: engine, env: environment, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (exit: number | null, out: string, err: string): void => {
          if (settled) return;
          settled = true;
          const wallMs = Date.now() - started;
          answers.push({ id, family, argv: declaredArgv, exit, stdout: parsedJson(normalize(out)), stderr: normalize(err) });
          timings.push({ id, wallMs });
          context.io.err(`${side.label} ${id} exit=${exit} ${wallMs} ms`);
          done();
        };
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", (error) => finish(null, stdout, `${stderr}${error.message}`));
        child.on("close", (exit) => finish(exit, stdout, stderr));
      });
    };

    const untrusted = cloneGroup(context, group, join(sideDirectory, "untrusted", group.id), environment);
    const trusted = group.workspace === undefined ? null : cloneGroup(context, group, join(sideDirectory, "trusted", group.id), environment);
    let queryWorkspace: string | undefined;
    if (group.workspace !== undefined && trusted !== null) {
      const declared = ["init", "--trust", "trusted"];
      const argv = [...declared];
      if (group.workspace.members.length > 0) {
        const workspaceFile = join(sideDirectory, "work", `${group.id}.workspace.json`);
        mkdirSync(dirname(workspaceFile), { recursive: true });
        const members = group.workspace.members.map((id) => ({ path: `../${id}`, id }));
        writeFileSync(workspaceFile, `${JSON.stringify({ repos: members, gateways: group.workspace.gateways ?? [] }, null, 2)}\n`);
        declared.push("--workspace", WORKSPACE_PLACEHOLDER);
        argv.push("--workspace", workspaceFile);
        queryWorkspace = join(sideDirectory, "work", `${group.id}.query-workspace.json`);
        const cloned = group.workspace.members.map((id) => ({ path: trusted.get(id) as string, id }));
        writeFileSync(queryWorkspace, `${JSON.stringify({ repos: cloned, gateways: group.workspace.gateways ?? [] }, null, 2)}\n`);
      }
      await execute(`${group.id}/init`, "init", [...declared, `{repo:${group.workspace.launch}}`], [...argv, trusted.get(group.workspace.launch) as string]);
    }
    for (const query of group.queries) {
      const clones = query.trusted === true ? (trusted as Map<string, string>) : untrusted;
      const sideArgv = side.label === "candidate" && query.candidateArgs !== undefined ? [...query.argv.slice(0, 1), ...query.candidateArgs, ...query.argv.slice(1)] : query.argv;
      const argv = sideArgv.map((argument) => (argument === WORKSPACE_PLACEHOLDER ? (queryWorkspace as string) : argument.replace(REPO_PLACEHOLDER, (_, id: string) => clones.get(id) as string)));
      await execute(`${group.id}/${query.id}`, query.family, query.argv, argv);
    }
    return { answers, timings };
  };

  const groups = await runGroups(context.manifest.groups, concurrency, runGroup);
  return { answers: groups.flatMap((group) => group.answers), timings: groups.flatMap((group) => group.timings) };
}

/** Fresh clones of a group's repositories at their pinned commits; `--shared` writes nothing to the source repository. */
function cloneGroup(context: Context, group: Group, directory: string, environment: NodeJS.ProcessEnv): Map<string, string> {
  mkdirSync(directory, { recursive: true });
  const clones = new Map<string, string>();
  for (const repo of group.repos) {
    const destination = join(directory, repo.id);
    git(directory, ["clone", "--quiet", "--shared", "--no-checkout", resolve(context.manifestDirectory, repo.path), destination], environment);
    git(destination, ["checkout", "--quiet", "--detach", repo.sha], environment);
    clones.set(repo.id, destination);
  }
  return clones;
}

/** The engine's own `cli` package script, so the gate launches each revision the way that revision declares. */
function cliCommand(engine: string): string[] {
  const packageJson = JSON.parse(readFileSync(join(engine, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const [program, ...rest] = (packageJson.scripts?.cli ?? "").split(/\s+/u).filter((token) => token !== "");
  if (program !== "node" || rest.length === 0) throw new GateFault("no-cli-script", join(engine, "package.json"));
  return rest;
}

async function report(context: Context, options: ReturnType<typeof parseOptions>, commonDirectory: string, [base, baseResult]: [Revision, SideResult], [candidate, candidateResult]: [Revision, SideResult]): Promise<number> {
  const candidateById = new Map(candidateResult.answers.map((answer) => [answer.id, answer]));
  const comparisons = baseResult.answers.map((answer) => compareAnswers(answer, candidateById.get(answer.id) as Answer));
  const found = violations(comparisons, options.expectations);
  const ledgers = { base: sideLedger(baseResult), candidate: sideLedger(candidateResult) };
  const foundCuts = cutViolations(ledgers.base, ledgers.candidate, options.cutExpectations);
  const verdict = found.length === 0 && foundCuts.length === 0 ? "pass" : "fail";
  const writtenAt = corpusWrittenAt(context);
  const relationsAt = await corpusRelations(context, [...baseResult.answers, ...candidateResult.answers]);
  const occurrences = { base: occurrenceLedger(baseResult.answers, writtenAt, relationsAt), candidate: occurrenceLedger(candidateResult.answers, writtenAt, relationsAt) };
  const out = options.out ?? join(context.store, "reports", `${base.tree}-${candidate.tree}`);
  const differing = comparisons.filter((comparison) => !comparison.identical);
  const sideSummary = (side: Revision, result: SideResult): SideSummary => ({ rev: side.rev, commit: side.commit, tree: side.tree, cached: result.cached, wallMs: result.wallMs, answers: result.directory });
  const body: ReportBody = {
    schema: 1,
    verdict,
    base: sideSummary(base, baseResult),
    candidate: sideSummary(candidate, candidateResult),
    manifest: { digest: context.manifestDigest },
    node: process.version,
    expectations: options.expectations,
    counts: { answers: comparisons.length, identical: comparisons.length - differing.length, differing: differing.length },
    violations: found,
    families: familySummaries(comparisons),
    differing,
    cutExpectations: options.cutExpectations,
    cutViolations: foundCuts,
    ledger: { ...ledgers, difference: ledgerDifference(ledgers.base, ledgers.candidate) },
    values: { base: valueLedger(baseResult.answers), candidate: valueLedger(candidateResult.answers), difference: valueDifference(baseResult.answers, candidateResult.answers) },
    occurrences: {
      rows: occurrenceRows(occurrences.base, occurrences.candidate),
      base: { answers: occurrences.base.answers, unaccounted: occurrences.base.unaccounted },
      candidate: { answers: occurrences.candidate.answers, unaccounted: occurrences.candidate.unaccounted },
      difference: { rows: occurrenceDifference(occurrences.base, occurrences.candidate) },
      leads: join(out, LEADS_FILE),
      setApart: join(out, SET_APART_FILE),
    },
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, LEADS_FILE), leadsText(occurrences.candidate));
  writeFileSync(join(out, SET_APART_FILE), setApartText(occurrences.candidate));
  const reportJson = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(join(out, "report.json"), reportJson);
  writeFileSync(join(out, "report.md"), readable(body));
  const marker = passMarkerPath(commonDirectory, base.tree, candidate.tree);
  if (verdict === "pass") {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `${sha256(Buffer.from(reportJson))}\n`);
  } else {
    rmSync(marker, { force: true });
  }
  const expect = options.expectations.length === 0 ? "none" : options.expectations.map((expectation) => `${expectation.family}:${expectation.direction}`).join(",");
  context.io.out(`report: ${join(out, "report.md")}`);
  const expectCuts = options.cutExpectations.length === 0 ? "" : ` expect-cuts=${options.cutExpectations.map(cutExpectationText).join(",")}`;
  context.io.out(`Corpus-Gate: ${verdict} base=${base.commit.slice(0, 12)} candidate-tree=${candidate.tree.slice(0, 12)} answers=${comparisons.length} differing=${differing.length} expect=${expect} manifest=${context.manifestDigest.slice(0, 12)}${expectCuts}`);
  return verdict === "pass" ? EXIT.pass : EXIT.fail;
}

/** Both sides' class counts per family and language; a key one side lacks counts zero there. */
function occurrenceRows(base: OccurrenceLedger, candidate: OccurrenceLedger): OccurrenceRow[] {
  const rows = new Map<string, OccurrenceRow>();
  const empty = () => Object.fromEntries(OCCURRENCE_CLASSES.map((name) => [name, 0])) as ClassCounts;
  for (const [side, ledger] of [["base", base], ["candidate", candidate]] as const) {
    for (const { family, language, counts } of ledger.rows) {
      const key = `${family}\0${language}`;
      const row = rows.get(key) ?? { family, language, base: empty(), candidate: empty() };
      rows.set(key, row);
      row[side] = counts;
    }
  }
  return [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

/** The corpus repository the manifest names for an answer's group, as a path. */
function corpusSource(context: Context, answer: Answer, repo: string): string {
  const group = context.manifest.groups.find((candidate) => candidate.id === answer.id.slice(0, answer.id.indexOf("/")));
  const entry = group?.repos.find((candidate) => candidate.id === repo);
  if (entry === undefined) throw new GateFault("unknown-repository", `${answer.id}: ${repo}`);
  return resolve(context.manifestDirectory, entry.path);
}

/**
 * What the engine's own readers relate at each snapshot an answer names: its TypeScript module statements (resolved
 * through the snapshot's own configuration), its Java imports and packages, and the templates its Angular components
 * name. The sources are read from the corpus repository's commit, once per repository and commit, and the readers are
 * the runner's, the same for both sides.
 */
async function corpusRelations(context: Context, answers: readonly Answer[]): Promise<RelationsAt> {
  const read = new Map<string, SnapshotRelations>();
  const keyOf = (answer: Answer, repo: string, commit: string) => [corpusSource(context, answer, repo), commit].join("\0");
  let parser: Awaited<ReturnType<typeof createJavaParser>> | undefined;
  for (const { answer, repo, commit } of occurrenceSnapshots(answers)) {
    const key = keyOf(answer, repo, commit);
    if (read.has(key)) continue;
    const { listing, sources } = snapshotSources(corpusSource(context, answer, repo), commit, (path) => isTypeScriptFile(path) || isJavaSource(path) || isModuleConfigFile(path) || isPackageManifest(path));
    const typescript = sources.filter(({ path }) => !isJavaSource(path));
    const java = sources.filter(({ path }) => isJavaSource(path));
    const modules = await createModuleDependenciesReader().extract(typescript, { listing });
    const javaParser = java.length === 0 ? undefined : (parser ??= await createJavaParser());
    const imports = javaParser === undefined ? { dependencies: [], unread: [] } : await createJavaImportsReader(javaParser).extract(java);
    const packages = new Map(javaParser === undefined ? [] : withJavaSources(javaParser, (parse) => parse(java).files.map((file): [string, string] => [file.path, file.packageName])));
    const untraversed = (modules.untraversed ?? []).map((reference) => ({ file: reference.file, line: reference.line, endLine: reference.endLine ?? reference.line, specifier: reference.specifier ?? "", kind: "import" as const, form: reference.form, target: reference.target ?? { kind: "unresolved" as const, reason: reference.form } }));
    const texts = new Map(sources.map(({ path, content }) => [path, content]));
    read.set(key, {
      dependencies: [...modules.dependencies, ...untraversed, ...imports.dependencies],
      unread: new Set([...modules.unread, ...imports.unread].map(({ file }) => file)),
      packages,
      components: await createAngularDeclarationReader().read(typescript),
      textOf: (file) => texts.get(file),
    });
  }
  return (answer, repo, commit) => read.get(keyOf(answer, repo, commit)) as SnapshotRelations;
}

/** Every path of a commit's tree, and the files `select` keeps with their contents, read through one `git cat-file --batch`. */
function snapshotSources(source: string, commit: string, select: (path: string) => boolean): { listing: string[]; sources: SourceFile[] } {
  const listing = git(source, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", commit]).split("\0").filter((path) => path !== "");
  const paths = listing.filter(select);
  if (paths.length === 0) return { listing, sources: [] };
  const result = spawnSync("git", ["cat-file", "--batch"], { cwd: source, input: paths.map((path) => `${commit}:${path}\n`).join(""), maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new GateFault("git-failed", `git cat-file --batch: ${result.stderr.toString().trim()}`);
  const output = result.stdout;
  const files: SourceFile[] = [];
  let offset = 0;
  for (const path of paths) {
    const header = output.subarray(offset, output.indexOf(10, offset)).toString();
    const [, type, size] = header.split(" ");
    const start = offset + header.length + 1;
    if (type !== "blob") {
      offset = start;
      continue;
    }
    files.push({ path, content: output.subarray(start, start + Number(size)).toString("utf8") });
    offset = start + Number(size) + 1;
  }
  return { listing, sources: files };
}

/**
 * The lines of a corpus repository's commit that write a name as a word, read from the repository the manifest names
 * for the answer's group, never from a clone's working tree; one read per repository, commit and name.
 */
function corpusWrittenAt(context: Context): WrittenAt {
  const read = new Map<string, readonly WrittenLine[]>();
  return (answer, repo, commit, name) => {
    const source = corpusSource(context, answer, repo);
    const key = [source, commit, name].join("\0");
    const known = read.get(key);
    if (known !== undefined) return known;
    const lines = gitGrep(source, commit, name);
    read.set(key, lines);
    return lines;
  };
}

/** `git grep` over a commit's tree: text files only, the name as a whole word, every path from the repository's top. */
function gitGrep(source: string, commit: string, name: string): WrittenLine[] {
  const args = ["grep", "-I", "-n", "-w", "-F", "-z", "--full-name", "-e", name, commit, "--", ":(top)"];
  const result = spawnSync("git", args, { cwd: source, encoding: "utf8", maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status === 1 && result.stderr === "") return [];
  if (result.status !== 0) throw new GateFault("git-failed", `git ${args.join(" ")}: ${result.stderr.trim()}`);
  const prefix = `${commit}:`;
  return result.stdout.split("\n").filter((record) => record !== "").map((record) => {
    const [path, line, ...text] = record.split("\0");
    return { file: (path as string).slice(prefix.length), line: Number(line), text: text.join("\0") };
  });
}

/** A side's cut ledger; a cut reason outside the facts contract is a fault of the run, raised before any report is written. */
function sideLedger(result: SideResult): CutLedger {
  try {
    return cutLedger(result.answers);
  } catch (error) {
    if (error instanceof CutLedgerError) throw new GateFault(error.code, `${result.directory}: ${error.detail}`);
    throw error;
  }
}

function cutExpectationText(expectation: CutExpectation): string {
  return `${expectation.reason}:${expectation.direction}`;
}

function familySummaries(comparisons: readonly AnswerComparison[]) {
  const families = new Map<string, { answers: number; differing: number; added: number; removed: number; changed: number; counters: Map<string, { base: number; candidate: number }> }>();
  for (const comparison of comparisons) {
    const family = families.get(comparison.family) ?? { answers: 0, differing: 0, added: 0, removed: 0, changed: 0, counters: new Map() };
    families.set(comparison.family, family);
    family.answers += 1;
    if (comparison.identical) continue;
    family.differing += 1;
    family.added += comparison.added;
    family.removed += comparison.removed;
    family.changed += comparison.changed;
    for (const counter of comparison.counters) {
      const total = family.counters.get(counter.path) ?? { base: 0, candidate: 0 };
      family.counters.set(counter.path, { base: total.base + (counter.base ?? 0), candidate: total.candidate + (counter.candidate ?? 0) });
    }
  }
  return [...families.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([family, summary]) => ({ family, ...summary, counters: [...summary.counters.entries()].map(([path, total]) => ({ path, ...total })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }));
}

interface SideSummary {
  rev: string;
  commit: string;
  tree: string;
  cached: boolean;
  wallMs: number | null;
  answers: string;
}

interface OccurrenceRow extends OccurrenceKey {
  base: ClassCounts;
  candidate: ClassCounts;
}

const LEADS_FILE = "occurrence-leads.tsv";
const SET_APART_FILE = "occurrence-set-apart.tsv";

interface ReportBody {
  schema: 1;
  verdict: "pass" | "fail";
  base: SideSummary;
  candidate: SideSummary;
  manifest: { digest: string };
  node: string;
  expectations: readonly Expectation[];
  counts: { answers: number; identical: number; differing: number };
  violations: readonly Violation[];
  families: ReturnType<typeof familySummaries>;
  differing: readonly AnswerComparison[];
  cutExpectations: readonly CutExpectation[];
  cutViolations: readonly CutViolation[];
  ledger: { base: CutLedger; candidate: CutLedger; difference: LedgerDifference };
  values: { base: ValueLedger; candidate: ValueLedger; difference: ValueDifference };
  occurrences: {
    rows: OccurrenceRow[];
    base: { answers: number; unaccounted: Lead[] };
    candidate: { answers: number; unaccounted: Lead[] };
    difference: { rows: OccurrenceDifferenceRow[] };
    leads: string;
    setApart: string;
  };
}

function readable(body: ReportBody): string {
  const run = (side: SideSummary) => `${side.commit.slice(0, 12)} (${side.cached ? "reused" : `${Math.round((side.wallMs ?? 0) / 1000)} s`})`;
  const lines = [
    `# Corpus gate: ${body.verdict}`,
    "",
    `Base ${run(body.base)}, candidate ${run(body.candidate)}. Answers ${body.counts.answers}, identical ${body.counts.identical}, differing ${body.counts.differing}. Expected: ${body.expectations.length === 0 ? "none" : body.expectations.map((expectation) => `${expectation.family}:${expectation.direction}`).join(", ")}. Expected cuts: ${body.cutExpectations.length === 0 ? "none" : body.cutExpectations.map(cutExpectationText).join(", ")}.`,
    "",
    `Ledgers: cuts ${body.ledger.difference.totals.base} → ${body.ledger.difference.totals.candidate}; entries ${body.values.base.entries} → ${body.values.candidate.entries}, gained ${body.values.difference.totals.gained}, lost ${body.values.difference.totals.lost}, changed ${body.values.difference.totals.changed}; unaccounted occurrences ${body.occurrences.base.unaccounted.length} → ${body.occurrences.candidate.unaccounted.length}.`,
    "",
    "| Family | Answers | Differing | Added | Removed | Changed |",
    "|---|---|---|---|---|---|",
    ...body.families.map((family) => `| ${family.family} | ${family.answers} | ${family.differing} | ${family.added} | ${family.removed} | ${family.changed} |`),
  ];
  if (body.violations.length + body.cutViolations.length > 0) {
    lines.push("", "## Violations", "", ...body.violations.map((violation) => `- ${violation.answer} (${violation.family}): ${violation.rule}`));
    lines.push(...body.cutViolations.map((violation) => `- cuts ${violation.reason} (${violation.direction}): ${violation.rule}, ${violation.base} → ${violation.candidate}`));
  }
  lines.push(...readableLedger(body.ledger), ...readableValues(body.values), ...readableOccurrences(body.occurrences));
  for (const comparison of body.differing) {
    lines.push("", `## ${comparison.id} (${comparison.family})`, "", `exit ${comparison.base.exit} → ${comparison.candidate.exit}, status ${comparison.base.status} → ${comparison.candidate.status}, +${comparison.added} −${comparison.removed} ~${comparison.changed}`);
    lines.push(...comparison.counters.map((counter) => `- ${counter.path}: ${counter.base} → ${counter.candidate}`));
    lines.push(...comparison.examples.map((difference) => `- ${difference.kind} ${difference.path}${"base" in difference ? ` ${JSON.stringify(difference.base)}` : ""}${"candidate" in difference ? ` → ${JSON.stringify(difference.candidate)}` : ""}`));
  }
  return `${lines.join("\n")}\n`;
}

function readableLedger(ledger: ReportBody["ledger"]): string[] {
  const statuses = (counts: { complete: number; partial: number; unknown: number } | undefined) => (counts === undefined ? "—" : `${counts.complete}/${counts.partial}/${counts.unknown}`);
  const values = (row: LedgerValues | null) => (row === null ? "—" : `${row.cuts}${row.per100Steps === undefined ? "" : ` (${row.per100Steps ?? "—"}/100 steps)`}`);
  const keyCells = (row: { family: string; language: string; kind: string; reason: string; subReason?: string }) => `| ${row.family} | ${row.language} | ${row.kind} | ${row.reason} | ${row.subReason ?? ""} |`;
  const table = ["| Family | Language | Kind | Reason | Sub-reason | Base | Candidate |", "|---|---|---|---|---|---|---|"];
  const families = [...new Set([...ledger.base.families, ...ledger.candidate.families].map((summary) => summary.family))].sort();
  const answersOf = (side: CutLedger, family: string) => side.families.find((summary) => summary.family === family)?.answers;
  const baseRows = new Map(ledger.base.rows.map((row) => [keyCells(row), row]));
  const candidateRows = new Map(ledger.candidate.rows.map((row) => [keyCells(row), row]));
  const allRows = [...new Set([...baseRows.keys(), ...candidateRows.keys()])].sort();
  return [
    "", "## Cut ledger", "",
    "Answers complete/partial/unknown, base → candidate.", "",
    "| Family | Base | Candidate |", "|---|---|---|",
    ...families.map((family) => `| ${family} | ${statuses(answersOf(ledger.base, family))} | ${statuses(answersOf(ledger.candidate, family))} |`),
    "", "### Rows", "", ...table,
    ...allRows.map((cells) => `${cells} ${values(baseRows.get(cells) ?? null)} | ${values(candidateRows.get(cells) ?? null)} |`),
    "", `### Difference: cuts ${ledger.difference.totals.base} → ${ledger.difference.totals.candidate}`, "", ...table,
    ...ledger.difference.rows.map((row) => `${keyCells(row)} ${values(row.base)} | ${values(row.candidate)} |`),
  ];
}

function readableValues(values: ReportBody["values"]): string[] {
  const keyCells = (row: ValueKey) => `| ${row.family} | ${row.language} | ${row.collection} |`;
  const baseRows = new Map(values.base.rows.map((row) => [keyCells(row), row.entries]));
  const candidateRows = new Map(values.candidate.rows.map((row) => [keyCells(row), row.entries]));
  const allRows = [...new Set([...baseRows.keys(), ...candidateRows.keys()])].sort();
  return [
    "", "## Value ledger", "",
    "Entries the facts hold, by collection: an array reached through object keys alone from the fact's value or from an entry of another collection (`files/importers`), so no family's shape is assumed; an array of numbers inside an entry is part of that entry. An entry's language is the one of the shallowest `file` it states. An answer that exited non-zero or printed no fact with a value holds none.", "",
    "| Family | Language | Collection | Base | Candidate |", "|---|---|---|---|---|",
    ...allRows.map((cells) => `${cells} ${baseRows.get(cells) ?? "—"} | ${candidateRows.get(cells) ?? "—"} |`),
    "", `### Difference: entries gained ${values.difference.totals.gained}, lost ${values.difference.totals.lost}, changed ${values.difference.totals.changed}`, "",
    "An entry is identified by its place (the file, path, symbol or name it states, with its kind, line and the call that reached it), or by its whole content when it states none, and a nested entry together with the entry that holds it; entries sharing an identity are paired in order. Gained and lost are identities one side alone holds, changed one both hold with different content; the three are never netted.", "",
    "| Family | Language | Collection | Gained | Lost | Changed |", "|---|---|---|---|---|---|",
    ...values.difference.rows.map((row) => `${keyCells(row)} ${row.gained} | ${row.lost} | ${row.changed} |`),
  ];
}

function readableOccurrences(occurrences: ReportBody["occurrences"]): string[] {
  const place = (lead: Lead) => `- ${lead.answer} ${lead.target}: ${lead.file}:${lead.line} ${lead.text}`;
  return [
    "", "## Occurrence oracle", "",
    `For each answer of \`callers\` and \`impact\`, every line of its snapshot that writes the name of a seed as a word in a file of the seed's own runtime, read from git at the snapshot's commit (${occurrences.base.answers} answers on the base, ${occurrences.candidate.answers} on the candidate), classed by the first rule that holds. A line is \`target\` inside the seed's own lines; \`listed\` inside a declaration or at a place the answer lists, in the template of a component it lists or seeds, or on an import statement or a decorator line of a listed declaration's file; \`unnamed-markup\` in a markup file no component names as its template; \`cut\` at a place a cut names or in a file a cut's reach covers; \`cut-by-reach\` under a cut whose \`callers-of\` reach lists the seed; \`out-of-scope\` in a path or language the declared scope leaves out; \`test-source\` in a test, whose edges are not callers; \`text\` when the line writes the name only inside comments and string literals; \`cannot-name\` in a file that neither is the seed's, imports its module (through aliases and barrels) nor, in Java, shares its package, imports its type or package or writes its qualified name; and \`unaccounted\` otherwise. The oracle resolves no reference: \`unaccounted\` is an upper bound of the silent omissions and each of its lines is a lead to audit. A homonym in a file that can name the seed gives unaccounted lines that are correct; a member reached through a receiver whose type the file never imports is \`cannot-name\`; a dependent that does not write the name is not seen. Other families state no declaration as a target and contribute nothing.`, "",
    `The candidate's unaccounted lines are in ${occurrences.leads}, and its lines of the classes set apart (${SET_APART_CLASSES.map((name) => `\`${name}\``).join(", ")}) in ${occurrences.setApart}.`, "",
    `| Family | Language | Side | ${OCCURRENCE_CLASSES.join(" | ")} |`, `|---|---|---|${OCCURRENCE_CLASSES.map(() => "---|").join("")}`,
    ...occurrences.rows.flatMap((row) => (["base", "candidate"] as const).map((side) => `| ${row.family} | ${row.language} | ${side} | ${OCCURRENCE_CLASSES.map((name) => row[side][name]).join(" | ")} |`)),
    ...occurrences.difference.rows.flatMap((row) => {
      const moved = row.candidate - row.base;
      return [
        "", `### ${row.family} ${row.language}: unaccounted ${row.base} → ${row.candidate} (${moved === 0 ? "unchanged" : moved < 0 ? `down ${-moved}` : `up ${moved}`}), ${row.left.length} left, ${row.entered.length} entered`,
        ...(row.left.length === 0 ? [] : ["", "Left:", ...row.left.map(place)]),
        ...(row.entered.length === 0 ? [] : ["", "Entered:", ...row.entered.map(place)]),
      ];
    }),
  ];
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" }): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new GateFault("git-failed", `git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.main) {
  process.exitCode = await runGate(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
