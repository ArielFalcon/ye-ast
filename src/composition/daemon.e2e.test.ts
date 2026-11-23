import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { isAlive } from "../daemon/daemon-lock.ts";
import { runSupervisor } from "../daemon/supervisor.ts";
import { composeCli, composeQueries } from "./compose.ts";
import { daemonProducer, processDaemonLink } from "./daemon.ts";
import { daemonBackedQueries, mcpConfiguration } from "./daemon-queries.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

const FILES: Readonly<Record<string, string>> = {
  "src/main/java/shop/OrderController.java": `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class OrderController {
  private final OrderService service;

  OrderController(OrderService service) { this.service = service; }

  @GetMapping("/orders")
  String all() {
    return service.find();
  }
}
`,
  "src/main/java/shop/OrderService.java": "package shop;\n\nclass OrderService {\n  String find() {\n    return \"x\";\n  }\n}\n",
  "web/api.ts": "export function load(): string {\n  return fetchAll();\n}\n\nfunction fetchAll(): string {\n  return 'all';\n}\n",
  "web/page.ts": "import { load } from './api';\n\nexport const page = load();\n",
};

let workspace: string;
let repo: string;
let indexCache: string;
let trustDirectory: string;
const stop = new AbortController();
let served: Promise<unknown>;
const workers: number[] = [];
let link: ReturnType<typeof processDaemonLink>;
/** The temporary directory the real CLI process gets, so its runtime directory is this test's daemon's. */
let processTmp: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(files: Readonly<Record<string, string>>, message: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-daemon-"));
  repo = join(workspace, "shop");
  indexCache = join(workspace, "cache");
  trustDirectory = join(workspace, "config");
  processTmp = join(workspace, "tmp");
  const runtime = join(processTmp, `ye-ast-${process.getuid!()}`);
  mkdirSync(repo);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  git("init", "-q", "-b", "main");
  commit(FILES, "base");
  commit({ "web/api.ts": FILES["web/api.ts"]!.replace("'all'", "'every'") }, "change");
  served = runSupervisor({
    directory: runtime,
    version: daemonProducer(),
    idleMs: 60_000,
    pid: process.pid,
    isAlive,
    signal: stop.signal,
    spawnWorker: () => {
      const child = fork(join(import.meta.dirname, "daemon-worker.ts"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      workers.push(child.pid!);
      return child;
    },
  });
  link = processDaemonLink(runtime, process.getuid!());
  const installed = await composeCli({ indexCache, cacheDirectory: indexCache, trustDirectory })(["init", "--trust", "trusted", repo], { out: () => undefined, err: () => undefined });
  assert.equal(installed, EXIT_CODE.ok);
});

after(async () => {
  stop.abort();
  await served;
  for (const pid of workers) for (let tries = 0; isAlive(pid) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(workspace, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
  served: string[];
}

async function cli(argv: readonly string[], options: { daemon: boolean; trustDirectory?: string }): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const served: string[] = [];
  const measure = (line: string): void => {
    const record = (JSON.parse(line) as { ye_ast: { event: string; served?: string } }).ye_ast;
    if (record.event === "query") served.push(record.served ?? "process");
  };
  const code = await composeCli({ indexCache, cacheDirectory: indexCache, trustDirectory: options.trustDirectory ?? trustDirectory, measure, ...(options.daemon && { daemon: link }) })(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n"), served };
}

test("every CLI query family answers the same bytes through the daemon as in process, and the daemon answered", async () => {
  const commands: string[][] = [
    ["map", repo],
    ["map", "--live", repo],
    ["callers", repo, "web/api.ts:load"],
    ["callers", "--live", repo, "web/api.ts:load"],
    ["importers", repo, "web/api.ts"],
    ["outline", repo, "web/api.ts"],
    ["outline", "--live", repo, "web/api.ts"],
    ["trace", repo, "src/main/java/shop/OrderController.java:OrderController.all"],
    ["impact", "--base", "HEAD~1", repo],
    ["impact", "--base", "HEAD~1", "--live", repo],
    ["workspace", repo],
    ["decisions", repo],
    ["contract-consequences", "--base", "HEAD~1", repo],
    ["callers", repo, "web/api.ts:missing"],
  ];
  for (const argv of commands) {
    const inProcess = await cli(argv, { daemon: false });
    const throughDaemon = await cli(argv, { daemon: true });
    assert.deepEqual({ ...throughDaemon, served: [] }, { ...inProcess, served: [] }, argv.join(" "));
    assert.deepEqual(inProcess.served, ["process"], argv.join(" "));
    assert.deepEqual(throughDaemon.served, ["daemon"], argv.join(" "));
  }
});

test("a real CLI process answers through the daemon and exits once answered, though its connection stays open", async () => {
  const main = join(import.meta.dirname, "main.ts");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: processTmp, XDG_CACHE_HOME: join(workspace, "xdg-cache"), XDG_CONFIG_HOME: join(workspace, "xdg-config") };
  delete env.XDG_RUNTIME_DIR;
  delete env.YE_AST_DAEMON;
  const run = (extra: NodeJS.ProcessEnv) =>
    new Promise<{ out: string; err: string }>((resolve, reject) =>
      execFile(process.execPath, [...process.execArgv, main, "map", "--measure", repo], { env: { ...env, ...extra }, timeout: 30_000 }, (error, out, err) => (error ? reject(error) : resolve({ out, err }))),
    );
  const daemon = await run({});
  const inProcess = await run({ YE_AST_DAEMON: "off" });
  assert.equal(daemon.out, inProcess.out);
  assert.match(daemon.err, /"served":"daemon"/);
  assert.doesNotMatch(inProcess.err, /"served"/);
});

test("a client's trust never reaches another client's request: each configuration is answered by its own worker", async () => {
  const untrustedConfig = join(workspace, "other-config");
  const argv = ["callers", "--live", repo, "web/api.ts:load"];
  const trusted = await cli(argv, { daemon: true });
  const untrusted = await cli(argv, { daemon: true, trustDirectory: untrustedConfig });
  assert.equal(trusted.code, EXIT_CODE.ok);
  assert.equal(untrusted.code, EXIT_CODE.queryFailed);
  assert.match(untrusted.err, /live-requires-trusted/);
  assert.deepEqual([trusted.served, untrusted.served], [["daemon"], ["daemon"]]);
  assert.deepEqual(await cli(argv, { daemon: false, trustDirectory: untrustedConfig }), { ...untrusted, served: ["process"] });
});

test("init asks the daemon to prime the MCP configuration, and the MCP's first query is then answered by that same worker", async () => {
  const spawned = workers.length;
  const installed = await composeCli({ indexCache, cacheDirectory: indexCache, trustDirectory, daemon: link })(["init", "--trust", "trusted", repo], { out: () => undefined, err: () => undefined });
  assert.equal(installed, EXIT_CODE.ok);
  assert.equal(workers.length, spawned + 1);
  const lines: string[] = [];
  const mcp = daemonBackedQueries(composeQueries({ indexCache, trustDirectory }), {
    link,
    startsDaemon: true,
    measure: (line) => lines.push(line),
    report: () => undefined,
    configuration: () => mcpConfiguration({ indexCache, trustDirectory }),
  });
  const answer = await mcp.entrypoints.map({ repo, repoId: "shop", live: true });
  assert.equal(answer.ok, true);
  assert.equal(workers.length, spawned + 1);
  assert.ok(lines.some((line) => line.includes('"served":"daemon"')));

  const primes = (): number => lines.filter((line) => line.includes('"event":"prime"')).length;
  assert.equal(await mcp.warmLive(repo, undefined, "shop"), null);
  const once = primes();
  assert.equal(await mcp.warmLive(repo, undefined, "shop"), null);
  assert.equal(primes(), once);
});
