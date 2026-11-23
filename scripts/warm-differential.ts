/**
 * The warm differential (RFC-0040 §4, L1). One long-lived MCP process per repository replays first-parent commits
 * through the live mirror and then single-file edits, each applied and reverted, plus the special steps: a commit
 * that does not change the tree, an `importers` query (synthesized) after a template edit the sync leaves unparsed, a
 * declared build output installed at the same path, a sync committed by another process, and a change of the trust
 * record. A second long-lived process on an untrusted clone asks the same commits as sha queries. At every step the gate's queries of the repository run in
 * the long-lived process and in a cold oracle (a new process with a new cache directory, so new memory, a new
 * derived-fact store and a new index cache; it shares only the clone and the trust record), and their answers must be
 * byte-equal: the reply text and the answer file. Every warm query of a step runs before its oracle starts, so the
 * oracle's launch is never charged to a warm query. The long-lived process's RSS is recorded after each step.
 *
 *   node --import tsx scripts/warm-differential.ts --corpus <manifest> --repo <group>/<repo>... --out <dir>
 *     [--commits <n>] [--build-output <group>/<repo>=<flag>:<dir>]... [--fail-fast] [--engine <checkout>] [--daemon]
 *
 * `--build-output` declares `<flag>` (`--node-modules` or `--jdk`) at a path absent until the install step copies
 * `<dir>` there. `--daemon` sends the long-lived processes through the run's own daemon (ADR-0157), stopped at the end;
 * the oracles stay in process. Writes `<out>/differential-report.json` and `.md`; exits 1 on any difference.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cloneAt, declareTrust, firstParentCommits, git, namedSourceFiles, privateDirectory } from "./latency-clones.ts";
import { atSnapshot, corpusRepositories, toolCallOf, type CorpusRepository, type Snapshot, type ToolCall } from "./latency-queries.ts";
import { isolatedEnvironment, startMcp, stopDaemon, type McpLaunch, type McpSession } from "./latency-session.ts";
import { slope } from "./latency-stats.ts";
import { addedFile, bodyEdit, componentSelector, signatureEdit, templateEdit, unparsable } from "./warm-differential-edits.ts";

const USAGE = "usage: node --import tsx scripts/warm-differential.ts --corpus <manifest> --repo <group>/<repo>... --out <dir> [--commits <n>] [--build-output <group>/<repo>=<flag>:<dir>]... [--fail-fast] [--engine <checkout>] [--daemon]";

interface Options {
  corpus: string;
  repos: string[];
  out: string;
  commits: number;
  buildOutputs: Map<string, { flag: string; source: string }>;
  failFast: boolean;
  engine: string;
  /** The long-lived processes answer through the run's own daemon (ADR-0157); the oracles always in process. */
  daemon: boolean;
}

/** One answer as both processes gave it, normalized: the reply text and the answer file, cache paths replaced. */
interface Answer {
  text: string;
  file: string | null;
  wallMs: number;
}

interface QueryComparison {
  query: string;
  equal: boolean;
  warm: Answer;
  oracle: Answer;
}

interface StepResult {
  repo: string;
  process: "live" | "sha";
  step: string;
  skipped?: string;
  rssBytes: number | null;
  comparisons: QueryComparison[];
}

class Difference extends Error {}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string" },
      repo: { type: "string", multiple: true },
      out: { type: "string" },
      commits: { type: "string", default: "3" },
      "build-output": { type: "string", multiple: true, default: [] },
      "fail-fast": { type: "boolean", default: false },
      daemon: { type: "boolean", default: false },
      engine: { type: "string", default: resolve(import.meta.dirname, "..") },
    },
  });
  const commits = Number(values.commits);
  const buildOutputs = new Map<string, { flag: string; source: string }>();
  for (const spec of values["build-output"]) {
    const match = /^([^=]+)=(--node-modules|--jdk):(.+)$/u.exec(spec);
    if (match === null) usage();
    buildOutputs.set(match[1]!, { flag: match[2]!, source: resolve(match[3]!) });
  }
  if (values.corpus === undefined || values.repo === undefined || values.out === undefined || !Number.isInteger(commits) || commits < 1) usage();
  return { corpus: resolve(values.corpus), repos: values.repo, out: resolve(values.out), commits, buildOutputs, failFast: values["fail-fast"], engine: resolve(values.engine), daemon: values.daemon };
}

function usage(): never {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

/**
 * Every occurrence of the cache directory, under each spelling the process may print, and the answer-file path line. A
 * live fact's `origin` (a sync or a full build, ADR-0015) and the result identity derived from it are replaced too: which
 * process built the store a fact read depends on timing; every other byte must be equal.
 */
function normalized(text: string, cache: string): string {
  const spellings = [...new Set([cache, realpathSync(cache)])].sort((a, b) => b.length - a.length);
  return spellings
    .reduce((out, spelling) => out.split(spelling).join("<cache>"), text)
    .replace(/^answer files: \S+/gmu, "answer files: <path>")
    .replace(/"origin":\{"kind":"(?:sync|full)"(?:,"base":"[0-9a-f]+")?\}/gu, '"origin":<origin>')
    .replace(/mcp-r1:[0-9a-f]+/gu, "mcp-r1:<identity>");
}

/** The answer file the call just wrote or reused: the newest `answer.json` of the tool, touched at or after `since`. */
function answerFile(cache: string, tool: string, since: number): string | null {
  const directory = join(cache, "answers", tool.replace(/^ye_ast_/u, ""));
  let newest: { path: string; mtime: number } | undefined;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(directory, entry, "answer.json");
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime >= since - 5 && (newest === undefined || mtime > newest.mtime)) newest = { path, mtime };
    } catch {
      continue;
    }
  }
  return newest === undefined ? null : readFileSync(newest.path, "utf8");
}

async function ask(session: McpSession, cache: string, call: ToolCall, snapshot: Snapshot): Promise<Answer & { rssBytes: number | null }> {
  const since = Date.now();
  const outcome = await session.call(call.tool, atSnapshot(call, snapshot));
  const file = outcome.isError ? null : answerFile(cache, call.tool, since);
  const query = outcome.records.filter((record) => record.event === "query").at(-1);
  return { text: normalized(outcome.text, cache), file: file === null ? null : normalized(file, cache), wallMs: outcome.wallMs, rssBytes: typeof query?.rss_bytes === "number" ? query.rss_bytes : null };
}

interface Run {
  options: Options;
  repo: CorpusRepository;
  scratch: string;
  env: NodeJS.ProcessEnv;
  calls: { id: string; call: ToolCall }[];
  results: StepResult[];
  oracles: number;
}

interface Warm {
  session: McpSession;
  launch: McpLaunch;
}

/**
 * Runs `queries` at one state in the long-lived process and in a new cold oracle, and records whether each answer is
 * equal. By default every warm query runs before the oracle starts, so the oracle's launch is never charged to a warm
 * query. `oracle-first` lets the oracle sync the shared mirror first, so the warm process must find a store generation
 * another process committed.
 */
async function compareStep(run: Run, warm: Warm, side: StepResult["process"], step: string, queries: readonly { id: string; call: ToolCall; snapshot: Snapshot }[], order: "warm-first" | "oracle-first" = "warm-first"): Promise<void> {
  const oracleCache = privateDirectory(join(run.scratch, "oracles", String(++run.oracles)));
  let oracle: McpSession | undefined;
  const comparisons: QueryComparison[] = [];
  let rssBytes: number | null = null;
  const askOracle = async () => {
    const started = performance.now();
    oracle = await startMcp({ ...warm.launch, cache: oracleCache, env: { ...warm.launch.env, YE_AST_DAEMON: "off" } });
    const answers = [];
    for (const { call, snapshot } of queries) answers.push(await ask(oracle, oracleCache, call, snapshot));
    log(run, `${step}: oracle launched and answered in ${Math.round(performance.now() - started)} ms`);
    return answers;
  };
  const askWarm = async () => {
    const answers = [];
    for (const { call, snapshot } of queries) answers.push(await ask(warm.session, warm.launch.cache, call, snapshot));
    return answers;
  };
  try {
    const oracleFirst = order === "oracle-first" ? await askOracle() : undefined;
    const warmAnswers = await askWarm();
    const oracleAnswers = oracleFirst ?? (await askOracle());
    for (const [index, { id }] of queries.entries()) {
      const warmAnswer = warmAnswers[index]!;
      const oracleAnswer = oracleAnswers[index]!;
      rssBytes = warmAnswer.rssBytes ?? rssBytes;
      const equal = warmAnswer.text === oracleAnswer.text && warmAnswer.file === oracleAnswer.file;
      comparisons.push({ query: id, equal, warm: warmAnswer, oracle: oracleAnswer });
      log(run, `${step} ${id}: ${equal ? "equal" : "DIFFERS"} (warm ${warmAnswer.wallMs} ms, oracle ${oracleAnswer.wallMs} ms)`);
    }
  } finally {
    await oracle?.close();
    rmSync(oracleCache, { recursive: true, force: true });
  }
  run.results.push({ repo: run.repo.name, process: side, step, rssBytes, comparisons });
  if (run.options.failFast && comparisons.some((comparison) => !comparison.equal)) throw new Difference(`${run.repo.name} ${step}`);
}

function log(run: Run, line: string): void {
  process.stderr.write(`differential ${run.repo.name}: ${line}\n`);
}

function skip(run: Run, side: StepResult["process"], step: string, reason: string): void {
  run.results.push({ repo: run.repo.name, process: side, step, skipped: reason, rssBytes: null, comparisons: [] });
  log(run, `${step}: skipped, ${reason}`);
}

async function liveReplay(run: Run, shas: readonly string[]): Promise<void> {
  const { options, repo, env } = run;
  const clone = cloneAt(repo.path, shas[0]!, join(run.scratch, "trusted", "repo"), env);
  const cache = privateDirectory(join(run.scratch, "warm-live"));
  declareTrust(options.engine, clone, "trusted", cache, env);
  const output = options.buildOutputs.get(repo.name);
  const declared = join(run.scratch, "build-output");
  const launch: McpLaunch = { engine: options.engine, repo: clone, cache, env, ...(output === undefined ? {} : { flags: [output.flag, declared] }) };
  const session = await startMcp(launch);
  const warm: Warm = { session, launch };
  const live: Snapshot = { kind: "live" };
  const liveQueries = run.calls.map(({ id, call }) => ({ id, call, snapshot: live }));
  const step = (name: string) => compareStep(run, warm, "live", name, liveQueries);
  try {
    for (const [index, sha] of shas.entries()) {
      if (index > 0) git(clone, ["checkout", "--quiet", "--detach", sha], env);
      await step(`commit ${sha.slice(0, 12)}`);
    }
    const targets = namedSourceFiles(run.calls.map(({ call }) => call));
    if (targets.length === 0) skip(run, "live", "edits", "no query targets a Java or TypeScript file");
    for (const target of targets) await editSteps(run, clone, target, (name) => step(`${name} (${target})`));
    if (targets[0] !== undefined) await foreignSyncSteps(run, clone, warm, targets[0], liveQueries);
    git(clone, ["commit", "--quiet", "--allow-empty", "-m", "ye-ast differential: no tree change"], env);
    await step("commit without a tree change");
    await synthesizedStep(run, clone, warm);
    if (output === undefined) {
      skip(run, "live", "build output installed", "no --build-output for this repository");
    } else {
      cpSync(output.source, declared, { recursive: true });
      await step("build output installed");
    }
    const head = git(clone, ["rev-parse", "HEAD"], env);
    const base = git(clone, ["rev-parse", "HEAD^"], env);
    const both = [...liveQueries, ...run.calls.map(({ id, call }) => ({ id: `${id}@sha`, call, snapshot: { kind: "revision" as const, sha: head, base } }))];
    await compareStep(run, warm, "live", "trust trusted, sha queries", both);
    declareTrust(options.engine, clone, "untrusted", cache, env);
    await compareStep(run, warm, "live", "trust changed to untrusted", both);
    declareTrust(options.engine, clone, "trusted", cache, env);
    await compareStep(run, warm, "live", "trust changed back to trusted", both);
  } finally {
    await session.close();
  }
}

/** Each single-file edit of `target`, applied and then reverted, with a step after each. */
async function editSteps(run: Run, clone: string, target: string, step: (name: string) => Promise<void>): Promise<void> {
  const file = (path: string) => join(clone, path);
  const original = readFileSync(file(target), "utf8");
  const applied = async (name: string, text: string | undefined) => {
    if (text === undefined) return skip(run, "live", `${name} (${target})`, "the file has no line this edit changes");
    writeFileSync(file(target), text);
    await step(`${name} applied`);
    writeFileSync(file(target), original);
    await step(`${name} reverted`);
  };
  await applied("body edit", bodyEdit(target, original));
  await applied("signature edit", signatureEdit(target, original));
  const added = addedFile(target, original);
  writeFileSync(file(added.path), added.text);
  await step("new file added");
  rmSync(file(added.path));
  await step("new file removed");
  const sibling = siblingOf(clone, target, run.env);
  if (sibling === undefined) {
    skip(run, "live", `deletion and rename (${target})`, "no other source file with its extension");
  } else {
    const kept = readFileSync(file(sibling), "utf8");
    rmSync(file(sibling));
    await step("deletion applied");
    writeFileSync(file(sibling), kept);
    await step("deletion reverted");
    const renamed = sibling.replace(/(\.[a-z]+)$/u, "Renamed$1");
    renameSync(file(sibling), file(renamed));
    await step("rename applied");
    renameSync(file(renamed), file(sibling));
    await step("rename reverted");
  }
  writeFileSync(file(target), unparsable(original));
  await step("stops parsing");
  writeFileSync(file(target), original);
  await step("parses again");
}

/**
 * Another process syncs first (RFC-0040 §5, the worker and image traps): a file is added and the oracle answers before
 * the warm process, so the warm process finds a store generation it did not commit and must reload its image and reopen
 * its sync worker; the removal is then synced by the warm process again.
 */
async function foreignSyncSteps(run: Run, clone: string, warm: Warm, target: string, queries: readonly { id: string; call: ToolCall; snapshot: Snapshot }[]): Promise<void> {
  const added = addedFile(target, readFileSync(join(clone, target), "utf8"));
  writeFileSync(join(clone, added.path), added.text);
  await compareStep(run, warm, "live", `foreign sync: new file added, the oracle syncs first (${target})`, queries, "oracle-first");
  rmSync(join(clone, added.path));
  await compareStep(run, warm, "live", `foreign sync: new file removed, the warm process syncs (${target})`, queries);
}

/** Another source file in the target's directory, else anywhere, with the same extension. */
function siblingOf(clone: string, target: string, env: NodeJS.ProcessEnv): string | undefined {
  const extension = target.slice(target.lastIndexOf("."));
  const tracked = git(clone, ["ls-files"], env).split("\n").filter((path) => path.endsWith(extension) && path !== target);
  return tracked.find((path) => dirname(path) === dirname(target)) ?? tracked[0];
}

/**
 * A template edit that renders another component, which the sync leaves unparsed. Another query syncs first, so the
 * `importers` of the rendered component (a synthesized query) then finds the store synced at the same `stateId` and
 * must rebuild it; on the revert it runs first.
 */
async function synthesizedStep(run: Run, clone: string, warm: Warm): Promise<void> {
  const name = "synthesized importers after an unparsed edit";
  const tracked = git(clone, ["ls-files"], run.env).split("\n");
  const components = tracked.filter((path) => path.endsWith(".ts")).flatMap((path) => {
    const selector = componentSelector(readFileSync(join(clone, path), "utf8"));
    return selector === undefined ? [] : [{ path, selector }];
  });
  const template = tracked.find((path) => path.endsWith(".html") && components.some((component) => component.path === path.replace(/\.html$/u, ".ts")));
  const rendered = components.find((component) => component.path !== template?.replace(/\.html$/u, ".ts"));
  if (template === undefined || rendered === undefined) return skip(run, "live", name, "no Angular component template and another component to render");
  const live = { kind: "live" as const };
  const importers = { id: `importers ${rendered.path}`, call: { tool: "ye_ast_importers", family: "importers", args: { files: [rendered.path] } }, snapshot: live };
  const others = run.calls.filter(({ call }) => call.family !== "importers").map(({ id, call }) => ({ id, call, snapshot: live }));
  const original = readFileSync(join(clone, template), "utf8");
  writeFileSync(join(clone, template), templateEdit(original, rendered.selector));
  await compareStep(run, warm, "live", "template edited, importers after a sync", [...others, importers]);
  writeFileSync(join(clone, template), original);
  await compareStep(run, warm, "live", "template reverted, importers first", [importers, ...others]);
}

async function shaReplay(run: Run, shas: readonly string[]): Promise<void> {
  const clone = cloneAt(run.repo.path, shas.at(-1)!, join(run.scratch, "untrusted", "repo"), run.env);
  const cache = privateDirectory(join(run.scratch, "warm-sha"));
  const launch: McpLaunch = { engine: run.options.engine, repo: clone, cache, env: run.env };
  const session = await startMcp(launch);
  try {
    for (const [index, sha] of shas.entries()) {
      const base = index === 0 ? git(clone, ["rev-parse", `${sha}^`], run.env) : shas[index - 1]!;
      await compareStep(run, { session, launch }, "sha", `sha ${sha.slice(0, 12)}`, run.calls.map(({ id, call }) => ({ id, call, snapshot: { kind: "revision", sha, base } })));
    }
  } finally {
    await session.close();
  }
}

async function differential(options: Options, repo: CorpusRepository, results: StepResult[], unsupported: string[]): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "ye-ast-warm-differential-"));
  const home = join(scratch, "home");
  for (const directory of ["cache", "config", "tmp"]) mkdirSync(join(home, directory), { recursive: true });
  const env = isolatedEnvironment(home, options.daemon);
  const calls = repo.queries.flatMap((query) => {
    const call = toolCallOf(query.argv);
    if ("tool" in call) return [{ id: query.id, call }];
    unsupported.push(`${repo.name}/${query.id}: ${call.unsupported}`);
    return [];
  });
  const run: Run = { options, repo, scratch, env, calls, results, oracles: 0 };
  log(run, `scratch ${scratch}`);
  const shas = firstParentCommits(repo.path, repo.sha, options.commits + 1, [], env);
  try {
    await shaReplay(run, shas);
    await liveReplay(run, shas);
  } finally {
    if (options.daemon) log(run, `daemon stopped, RSS before stop ${Math.round(((await stopDaemon(options.engine, env)) ?? 0) / 1048576)} MB`);
    log(run, `done; remove ${scratch} when the report is read`);
  }
}

function markdown(results: readonly StepResult[], unsupported: readonly string[], engine: string, slopes: Record<string, number | null>): string {
  const rows = results.map((result) => {
    const differing = result.comparisons.filter((comparison) => !comparison.equal).map((comparison) => comparison.query);
    const verdict = result.skipped !== undefined ? `skipped: ${result.skipped}` : differing.length === 0 ? `equal (${result.comparisons.length})` : `DIFFERS: ${differing.join(", ")}`;
    return `| ${result.repo} | ${result.process} | ${result.step} | ${verdict} | ${result.rssBytes === null ? "–" : Math.round(result.rssBytes / 1048576)} |`;
  });
  return [
    `# Warm differential, engine ${engine.slice(0, 12)}`,
    "",
    "| repo | process | step | answers | RSS MB |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...Object.entries(slopes).map(([key, value]) => `RSS slope ${key}: ${value === null ? "–" : `${Math.round(value / 1024)} KiB/step`}`),
    "",
    ...(unsupported.length === 0 ? [] : ["Queries the MCP cannot ask per call:", ...unsupported.map((line) => `- ${line}`), ""]),
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions();
  const repos = corpusRepositories(options.corpus, options.repos);
  const results: StepResult[] = [];
  const unsupported: string[] = [];
  let stopped: string | undefined;
  try {
    for (const repo of repos) await differential(options, repo, results, unsupported);
  } catch (error) {
    if (!(error instanceof Difference)) throw error;
    stopped = error.message;
  }
  const engine = git(options.engine, ["rev-parse", "HEAD"], process.env);
  const slopes = Object.fromEntries(
    [...new Set(results.map((result) => `${result.repo} ${result.process}`))].map((key) => [key, slope(results.filter((result) => `${result.repo} ${result.process}` === key && result.rssBytes !== null).map((result) => result.rssBytes!))]),
  );
  const differing = results.flatMap((result) => result.comparisons.filter((comparison) => !comparison.equal).map((comparison) => ({ repo: result.repo, step: result.step, ...comparison })));
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, "differential-report.json"), `${JSON.stringify({ schema: 1, engine, node: process.version, options: { ...options, buildOutputs: [...options.buildOutputs] }, stopped: stopped ?? null, slopes, differing, results, unsupported }, null, 1)}\n`);
  writeFileSync(join(options.out, "differential-report.md"), markdown(results, unsupported, engine, slopes));
  process.stdout.write(`report: ${join(options.out, "differential-report.md")}\n`);
  process.stdout.write(`Warm-Differential: ${differing.length === 0 ? "pass" : "fail"} engine=${engine.slice(0, 12)} steps=${results.length} differing=${differing.length}${stopped === undefined ? "" : ` stopped-at="${stopped}"`}\n`);
  process.exitCode = differing.length === 0 ? 0 : 1;
}

if (import.meta.main) await main();
