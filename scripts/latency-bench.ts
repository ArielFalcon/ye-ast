/**
 * The latency bench (RFC-0040 phase 0, L0). Drives the real stdio MCP (`ye-ast mcp <clone> --cache <dir>`) on
 * disposable clones of corpus repositories and reports, per repository, scenario and family, the wall time p50/p75/p95,
 * the stage lines, the SQL statement counts, the cache counters and the RSS, with the RSS slope over a session of
 * edits. The repositories come from the corpus manifest of the gate; nothing is written to them.
 *
 *   node --import tsx scripts/latency-bench.ts --corpus <manifest> --repo <group>/<repo>... --out <dir>
 *     [--scenarios <name>,...] [--repetitions <n>] [--edits <n>] [--revisions <n>] [--engine <checkout>]
 *   node --import tsx scripts/latency-bench.ts --quick --corpus <manifest> --repo <group>/<repo> --out <dir> [--engine <checkout>]
 *
 * Scenarios: `unchanged` (interleaved rounds of every family on a warm live process), `edit-idle` (an edit, 2 s idle,
 * then the call), `edit-now` (an edit, then the call at once), `new-process` (the first call of a new process over the
 * warm disk cache), `three-servers` (three processes on one clone ask at once), `revision` (a first-parent sha sequence
 * on an untrusted clone, first and repeated call per sha) and `rss-slope` (`--edits` edits, each followed by the next
 * family's call). Every live scenario first runs one round that warms the process (`first-round`). `--quick` asks
 * `callers` and `outline` of one repository, unchanged and after an edit, 5 times each: the check of an integration
 * batch, against the same cells of a full run. Writes
 * `<out>/latency-report.json` and `<out>/latency-report.md`; exits 1 when a call wrote no query line.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cloneAt, declareTrust, firstParentCommits, git, namedFiles, namedSourceFile, privateDirectory } from "./latency-clones.ts";
import { atSnapshot, corpusRepositories, toolCallOf, type CorpusRepository, type Snapshot, type ToolCall } from "./latency-queries.ts";
import { isolatedEnvironment, startMcp, type McpSession } from "./latency-session.ts";
import { cellSummary, cellTable, sampleOf, slope, type CallSample, type CellSummary } from "./latency-stats.ts";

const USAGE = "usage: node --import tsx scripts/latency-bench.ts --corpus <manifest> --repo <group>/<repo>... --out <dir> [--scenarios <name>,...] [--repetitions <n>] [--edits <n>] [--revisions <n>] [--engine <checkout>] | --quick --corpus <manifest> --repo <group>/<repo> --out <dir> [--engine <checkout>]";
const FAMILIES = ["callers", "trace", "impact", "outline", "importers", "entrypoints", "workspace"] as const;
const QUICK = { families: ["callers", "outline"], scenarios: ["unchanged", "edit-now"], repetitions: 5 } as const;
const SCENARIOS = ["unchanged", "edit-idle", "edit-now", "new-process", "three-servers", "revision", "rss-slope"] as const;
const IDLE_MS = 2_000;

type Scenario = (typeof SCENARIOS)[number];

interface Options {
  corpus: string;
  repos: string[];
  out: string;
  scenarios: Set<Scenario>;
  families: readonly string[];
  repetitions: number;
  edits: number;
  revisions: number;
  engine: string;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string" },
      repo: { type: "string", multiple: true },
      out: { type: "string" },
      scenarios: { type: "string", default: SCENARIOS.join(",") },
      repetitions: { type: "string", default: "5" },
      edits: { type: "string", default: "200" },
      revisions: { type: "string", default: "3" },
      engine: { type: "string", default: resolve(import.meta.dirname, "..") },
      quick: { type: "boolean", default: false },
    },
  });
  if (values.quick && (values.repo?.length !== 1 || process.argv.some((argument) => /^--(scenarios|repetitions|edits|revisions)\b/u.test(argument)))) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const scenarios = values.quick ? [...QUICK.scenarios] : values.scenarios.split(",");
  const counts = [values.repetitions, values.edits, values.revisions].map(Number);
  if (values.corpus === undefined || values.repo === undefined || values.out === undefined || !scenarios.every((name) => (SCENARIOS as readonly string[]).includes(name)) || !counts.every((count) => Number.isInteger(count) && count >= 1)) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  return { corpus: resolve(values.corpus), repos: values.repo, out: resolve(values.out), scenarios: new Set(scenarios as Scenario[]), families: values.quick ? QUICK.families : FAMILIES, repetitions: values.quick ? QUICK.repetitions : counts[0]!, edits: counts[1]!, revisions: counts[2]!, engine: resolve(values.engine) };
}

/** The call of each bench family: the repository's first gate query of that family, or the family with no argument when it needs none. */
function familyCalls(repo: CorpusRepository, families: readonly string[]): ToolCall[] {
  return families.flatMap((family) => {
    for (const query of repo.queries) {
      const call = toolCallOf(query.argv);
      if ("tool" in call && call.family === family) return [call];
    }
    if (family === "entrypoints") return [{ tool: "ye_ast_entrypoints", family, args: {} }];
    if (family === "workspace") return [{ tool: "ye_ast_workspace", family, args: {} }];
    process.stderr.write(`bench: ${repo.name} has no ${family} query; the family is skipped\n`);
    return [];
  });
}

/** The file the edit scenarios append to: the first file a call targets, else the first Java or TypeScript file tracked. */
function editFile(clone: string, calls: readonly ToolCall[], env: NodeJS.ProcessEnv): string {
  const named = namedSourceFile(calls);
  if (named !== undefined) return named;
  const tracked = git(clone, ["ls-files"], env).split("\n").find((path) => /\.(java|ts)$/u.test(path));
  if (tracked === undefined) throw new Error(`${clone}: no Java or TypeScript file to edit`);
  return tracked;
}

class Recorder {
  readonly samples = new Map<string, { repo: string; scenario: string; family: string; samples: CallSample[] }>();
  readonly extras: Record<string, unknown>[] = [];
  missingQueryLines = 0;

  add(repo: string, scenario: string, family: string, sample: CallSample): void {
    const key = [repo, scenario, family].join("\0");
    const cell = this.samples.get(key) ?? { repo, scenario, family, samples: [] };
    cell.samples.push(sample);
    this.samples.set(key, cell);
    if (sample.outcome === "no-query-line") this.missingQueryLines += 1;
  }

  cells(): CellSummary[] {
    return [...this.samples.values()].map((cell) => cellSummary(cell.repo, cell.scenario, cell.family, cell.samples));
  }

  /** Every sample of a repository's live scenarios after the first round, the "equal mix" of RFC-0040 §6. */
  mix(repo: string): CellSummary {
    const pooled = [...this.samples.values()].filter((cell) => cell.repo === repo && ["unchanged", "edit-idle", "edit-now"].includes(cell.scenario)).flatMap((cell) => cell.samples);
    return cellSummary(repo, "equal-mix", "all", pooled);
  }
}

async function measuredCall(session: McpSession, call: ToolCall, snapshot: Snapshot): Promise<CallSample> {
  const outcome = await session.call(call.tool, atSnapshot(call, snapshot));
  const sample = sampleOf(outcome.wallMs, outcome.records);
  if (outcome.isError && sample.outcome === "ok") sample.outcome = "tool-error";
  return sample;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function benchRepository(options: Options, repo: CorpusRepository, recorder: Recorder): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "ye-ast-latency-bench-"));
  const home = join(scratch, "home");
  for (const directory of ["cache", "config", "tmp"]) mkdirSync(join(home, directory), { recursive: true });
  const env = isolatedEnvironment(home);
  const cache = privateDirectory(join(scratch, "cache"));
  const calls = familyCalls(repo, options.families);
  const live: Snapshot = { kind: "live" };
  const log = (line: string) => process.stderr.write(`bench ${repo.name}: ${line}\n`);
  log(`scratch ${scratch}`);
  const wants = (scenario: Scenario) => options.scenarios.has(scenario);

  const liveScenarios = SCENARIOS.filter((scenario) => scenario !== "revision" && wants(scenario));
  if (liveScenarios.length > 0) {
    const clone = cloneAt(repo.path, repo.sha, join(scratch, "trusted", "repo"), env);
    declareTrust(options.engine, clone, "trusted", cache, env);
    const file = editFile(clone, calls, env);
    const original = readFileSync(join(clone, file), "utf8");
    let edits = 0;
    const edit = () => writeFileSync(join(clone, file), `${original}\n// ye-ast bench edit ${++edits}\n`);
    const launch = { engine: options.engine, repo: clone, cache, env };
    let session = await startMcp(launch);
    const round = async (scenario: string, before?: () => Promise<void> | void) => {
      for (const call of calls) {
        await before?.();
        recorder.add(repo.name, scenario, call.family, await measuredCall(session, call, live));
      }
    };
    log("first-round");
    await round("first-round");
    if (wants("unchanged")) {
      log("unchanged");
      for (let r = 0; r < options.repetitions; r += 1) await round("unchanged");
    }
    if (wants("edit-idle")) {
      log("edit-idle");
      for (let r = 0; r < options.repetitions; r += 1) await round("edit-idle", async () => { edit(); await sleep(IDLE_MS); });
    }
    if (wants("edit-now")) {
      log("edit-now");
      for (let r = 0; r < options.repetitions; r += 1) await round("edit-now", edit);
    }
    if (wants("new-process")) {
      log("new-process");
      for (let r = 0; r < options.repetitions; r += 1) {
        for (const call of calls) {
          await session.close();
          session = await startMcp(launch);
          recorder.add(repo.name, "new-process", call.family, await measuredCall(session, call, live));
        }
      }
    }
    if (wants("three-servers")) {
      log("three-servers");
      const others = [await startMcp(launch), await startMcp(launch)];
      for (const other of others) for (const call of calls) await measuredCall(other, call, live);
      const servers = [session, ...others];
      for (let r = 0; r < options.repetitions; r += 1) {
        for (const call of calls) {
          const started = performance.now();
          const samples = await Promise.all(servers.map((server) => measuredCall(server, call, live)));
          const roundMs = Math.round(performance.now() - started);
          for (const sample of samples) recorder.add(repo.name, "three-servers", call.family, sample);
          recorder.extras.push({ repo: repo.name, scenario: "three-servers", family: call.family, roundMs, callsMs: samples.map((sample) => sample.wallMs) });
        }
      }
      for (const other of others) await other.close();
    }
    if (wants("rss-slope")) {
      log(`rss-slope over ${options.edits} edits`);
      const rss: number[] = [];
      for (let index = 0; index < options.edits; index += 1) {
        edit();
        const call = calls[index % calls.length]!;
        const sample = await measuredCall(session, call, live);
        recorder.add(repo.name, "rss-slope", call.family, sample);
        if (sample.rssBytes !== null) rss.push(sample.rssBytes);
      }
      recorder.extras.push({ repo: repo.name, scenario: "rss-slope", edits: options.edits, rssFirstBytes: rss[0] ?? null, rssLastBytes: rss.at(-1) ?? null, rssMaxBytes: rss.length === 0 ? null : Math.max(...rss), slopeBytesPerEdit: slope(rss), rssBytes: rss });
    }
    await session.close();
    writeFileSync(join(clone, file), original);
  }

  if (wants("revision")) {
    log("revision");
    const clone = cloneAt(repo.path, repo.sha, join(scratch, "untrusted", "repo"), env);
    const shas = firstParentCommits(clone, repo.sha, options.revisions + 1, namedFiles(calls), env);
    const session = await startMcp({ engine: options.engine, repo: clone, cache, env });
    for (const [index, sha] of shas.entries()) {
      const base = index === 0 ? git(clone, ["rev-parse", `${sha}^`], env) : shas[index - 1]!;
      for (const call of calls) {
        recorder.add(repo.name, "revision-first", call.family, await measuredCall(session, call, { kind: "revision", sha, base }));
        recorder.add(repo.name, "revision-repeat", call.family, await measuredCall(session, call, { kind: "revision", sha, base }));
      }
    }
    await session.close();
  }
  log(`done; remove ${scratch} when the report is read`);
}

/** Writes the report of what the run measured so far: a repository that fails later never loses the earlier ones. */
function writeReport(options: Options, repos: readonly CorpusRepository[], recorder: Recorder, started: string, failures: readonly string[]): void {
  const cells = recorder.cells();
  const mixes = repos.map((repo) => recorder.mix(repo.name)).filter((mix) => mix.n > 0);
  const engineCommit = git(options.engine, ["rev-parse", "HEAD"], process.env);
  const report = { schema: 1, started, finished: new Date().toISOString(), engine: engineCommit, node: process.version, options: { ...options, scenarios: [...options.scenarios] }, cells, mixes, extras: recorder.extras, missingQueryLines: recorder.missingQueryLines, failures };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, "latency-report.json"), `${JSON.stringify(report, null, 1)}\n`);
  const extras = recorder.extras.filter((extra) => extra.scenario === "rss-slope").map((extra) => `| ${extra.repo} | ${extra.edits} | ${Math.round(Number(extra.rssFirstBytes) / 1048576)} | ${Math.round(Number(extra.rssLastBytes) / 1048576)} | ${Math.round(Number(extra.rssMaxBytes) / 1048576)} | ${Math.round(Number(extra.slopeBytesPerEdit) / 1024)} |`);
  const markdown = [
    `# Latency bench, engine ${engineCommit.slice(0, 12)}, ${started}`,
    "",
    cellTable([...cells, ...mixes]),
    "",
    "| repo | edits | RSS first MB | RSS last MB | RSS max MB | slope KiB/edit |",
    "| --- | --- | --- | --- | --- | --- |",
    ...extras,
    "",
    `missing query lines: ${recorder.missingQueryLines}`,
    ...failures.map((failure) => `failed: ${failure}`),
    "",
  ].join("\n");
  writeFileSync(join(options.out, "latency-report.md"), markdown);
}

async function main(): Promise<void> {
  const options = parseOptions();
  const repos = corpusRepositories(options.corpus, options.repos);
  const recorder = new Recorder();
  const started = new Date().toISOString();
  const failures: string[] = [];
  for (const repo of repos) {
    try {
      await benchRepository(options, repo, recorder);
    } catch (error) {
      failures.push(`${repo.name}: ${error instanceof Error ? error.message : String(error)}`);
      process.stderr.write(`bench ${repo.name}: failed: ${failures.at(-1)}\n`);
    }
    writeReport(options, repos, recorder, started, failures);
  }
  process.stdout.write(`report: ${join(options.out, "latency-report.md")}\n`);
  process.exitCode = recorder.missingQueryLines === 0 && failures.length === 0 ? 0 : 1;
}

if (import.meta.main) await main();
