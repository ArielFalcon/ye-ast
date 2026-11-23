/**
 * One real stdio MCP server (`ye-ast mcp <repo> --cache <dir>`) driven the way a host drives it, for the latency bench
 * and the warm differential. Each call returns its reply text, its wall time and the measurement lines the server wrote
 * to stderr while it ran (RFC-0012), plus the SQL counters of `latency-sql-counters.ts`, which is preloaded into it.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { PID_FILE, runtimeDirectory } from "../src/daemon/runtime-directory.ts";

const PROTOCOL_VERSION = "2025-06-18";
const SQL_COUNTERS = join(import.meta.dirname, "latency-sql-counters.ts");
/** How long a reply may take before the call counts as hung; a cold index build on a large repository takes seconds. */
const CALL_TIMEOUT_MS = 600_000;
/** How long the query line may trail the reply: stderr and stdout are separate pipes. */
const QUERY_LINE_GRACE_MS = 2_000;

/** One parsed measurement line: the `ye_ast` record of the server, or the `ye_ast_bench` record of the SQL counters. */
export type MeasurementRecord = Record<string, unknown> & { event: string };

export interface CallOutcome {
  wallMs: number;
  /** The text of every content block, joined; on a protocol error, the error as JSON. */
  text: string;
  isError: boolean;
  records: MeasurementRecord[];
  /** Plain stderr lines the call produced, such as a stale notice. */
  notices: string[];
}

export interface McpLaunch {
  /** The engine checkout whose `src/composition/main.ts` runs. */
  engine: string;
  repo: string;
  cache: string;
  env: NodeJS.ProcessEnv;
  /** Flags after the repository, such as `--jdk <path>`. */
  flags?: readonly string[];
}

export interface McpSession {
  readonly pid: number;
  call(tool: string, args: Record<string, unknown>): Promise<CallOutcome>;
  /** Settles on the first measurement line written from now on that `match` accepts, or `undefined` once the server exits or `timeoutMs` passed. */
  next(match: (record: MeasurementRecord) => boolean, timeoutMs: number): Promise<MeasurementRecord | undefined>;
  close(): Promise<void>;
}

/**
 * The environment of a run-owned user: its own home, cache, configuration and temporary directory (so its own daemon
 * runtime directory, ADR-0157), no telemetry, a stable locale. The daemon is off unless `daemon` is set.
 */
export function isolatedEnvironment(home: string, daemon = false): NodeJS.ProcessEnv {
  return {
    ...(daemon ? {} : { YE_AST_DAEMON: "off" }),
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    TMPDIR: join(home, "tmp"),
    LC_ALL: "C",
    DO_NOT_TRACK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "bench",
    GIT_AUTHOR_EMAIL: "bench@localhost",
    GIT_COMMITTER_NAME: "bench",
    GIT_COMMITTER_EMAIL: "bench@localhost",
  };
}

/**
 * Stops the daemon a run's processes started in the run's own runtime directory, once every session closed, and answers
 * the resident set of its supervisor and workers just before; `null` when none runs there.
 */
export async function stopDaemon(env: NodeJS.ProcessEnv): Promise<number | null> {
  const directory = runtimeDirectory({ env, platform: process.platform, uid: process.getuid?.(), tmpdir: env.TMPDIR ?? "" });
  let pid: number;
  try {
    pid = (JSON.parse(readFileSync(join(directory!, PID_FILE), "utf8")) as { pid: number }).pid;
  } catch {
    return null;
  }
  const children = (): number[] => {
    try {
      return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  const processes = [pid, ...children()];
  const rssKb = execFileSync("ps", ["-o", "rss=", "-p", processes.join(",")], { encoding: "utf8" }).trim().split("\n").reduce((sum, line) => sum + Number(line.trim() || 0), 0);
  process.kill(pid, "SIGTERM");
  for (let tries = 0; tries < 200; tries += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return rssKb * 1024;
}

/** The engine's own `cli` package script, so a run launches the engine the way that revision declares. */
export function engineCommand(engine: string): string[] {
  const manifest = JSON.parse(readFileSync(join(engine, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const [program, ...rest] = (manifest.scripts?.cli ?? "").split(/\s+/u).filter((token) => token !== "");
  if (program !== "node" || rest.length === 0) throw new Error(`${engine}: package.json declares no node cli script`);
  return rest.map((token) => (token.endsWith(".ts") ? join(engine, token) : token));
}

/** Parses one stderr line into a measurement record, or `undefined` when it is a plain line. */
function measurementOf(line: string): MeasurementRecord | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as { ye_ast?: MeasurementRecord; ye_ast_bench?: MeasurementRecord };
    return parsed.ye_ast ?? parsed.ye_ast_bench;
  } catch {
    return undefined;
  }
}

export async function startMcp(launch: McpLaunch): Promise<McpSession> {
  const command = engineCommand(launch.engine);
  const entry = command.findIndex((token) => token.endsWith(".ts"));
  const nodeOptions = [...command.slice(0, entry), "--import", SQL_COUNTERS];
  const child = spawn(process.execPath, [...nodeOptions, ...command.slice(entry), "mcp", launch.repo, ...(launch.flags ?? []), "--cache", launch.cache], {
    cwd: launch.engine,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return session(child);
}

function session(child: ChildProcess): Promise<McpSession> {
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let records: MeasurementRecord[] = [];
  let notices: string[] = [];
  let queryLines = 0;
  let exited = false;
  let nextId = 1;
  let awaited: { match: (record: MeasurementRecord) => boolean; settle: (record: MeasurementRecord | undefined) => void }[] = [];
  const stderrTail: string[] = [];

  createInterface({ input: child.stderr! }).on("line", (line) => {
    const record = measurementOf(line);
    if (record === undefined) {
      notices.push(line);
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
      return;
    }
    records.push(record);
    if (record.event === "query") queryLines += 1;
    const waiting = awaited;
    awaited = waiting.filter((waiter) => !waiter.match(record));
    for (const waiter of waiting) if (!awaited.includes(waiter)) waiter.settle(record);
  });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    pending.get(id)?.(message);
    pending.delete(id);
  });
  child.on("exit", () => {
    exited = true;
    for (const waiter of awaited.splice(0)) waiter.settle(undefined);
    for (const [id, resolve] of pending) resolve({ id, error: { code: -1, message: `server exited: ${stderrTail.join(" | ")}` } });
    pending.clear();
  });

  const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++;
    if (exited) return Promise.resolve({ id, error: { code: -1, message: `server exited: ${stderrTail.join(" | ")}` } });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ id, error: { code: -2, message: `no reply in ${CALL_TIMEOUT_MS} ms` } });
      }, CALL_TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const waitForQueryLine = async (seen: number): Promise<void> => {
    const deadline = performance.now() + QUERY_LINE_GRACE_MS;
    while (queryLines <= seen && performance.now() < deadline && !exited) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  return (async () => {
    const hello = await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ye-ast-latency", version: "1" } });
    if (hello.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(hello.error)}`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    records = [];
    notices = [];
    return {
      pid: child.pid ?? -1,
      async call(tool, args) {
        records = [];
        notices = [];
        const seen = queryLines;
        const started = performance.now();
        const reply = await request("tools/call", { name: tool, arguments: args });
        const wallMs = Math.round(performance.now() - started);
        await waitForQueryLine(seen);
        const result = reply.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
        const text = result === undefined ? JSON.stringify(reply.error) : (result.content ?? []).map((part) => part.text ?? "").join("\n");
        const outcome = { wallMs, text, isError: result === undefined || result.isError === true, records, notices };
        records = [];
        notices = [];
        return outcome;
      },
      next(match, timeoutMs) {
        if (exited) return Promise.resolve(undefined);
        return new Promise((settle) => {
          const timer = setTimeout(() => {
            awaited = awaited.filter((waiter) => waiter !== entry);
            settle(undefined);
          }, timeoutMs);
          const entry = { match, settle: (record: MeasurementRecord | undefined) => { clearTimeout(timer); settle(record); } };
          awaited.push(entry);
        });
      },
      async close() {
        if (exited) return;
        const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.stdin!.end();
        const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await gone;
        clearTimeout(killer);
      },
    };
  })();
}
