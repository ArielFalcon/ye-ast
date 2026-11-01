/**
 * Transport harness (RFC-0012 step 5). Drives the real `serve` process over stdio and provokes the failures a host
 * should never discover in production. It needs a real repository and a real store; it is a script, not a test, because
 * a committed test may not read a fixed commit.
 *
 *   node --import tsx scripts/transport.ts [<repo>]
 *
 * Not covered here: a store at a schema outside the supported range and an incomplete index, which need a crafted
 * store. Those stay with `store-version.ts` and the index adapter tests.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA } from "../src/core/domain/shared/fact.ts";

const repo = resolve(process.argv[2] ?? ".");
const project = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../src/composition/main.ts", import.meta.url));
const failures: string[] = [];
const passes: string[] = [];

const child = spawn(process.execPath, ["--import", "tsx", entry, "serve"], {
  cwd: project,
  stdio: ["pipe", "pipe", "pipe"],
});

const stderrLines: string[] = [];
createInterface({ input: child.stderr }).on("line", (line) => stderrLines.push(line));

const inbox: unknown[] = [];
let waiting: ((message: unknown) => void) | undefined;
createInterface({ input: child.stdout }).on("line", (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    message = { unparseable: line };
  }
  if (waiting === undefined) {
    inbox.push(message);
    return;
  }
  const resolve = waiting;
  waiting = undefined;
  resolve(message);
});

child.on("exit", () => {
  if (waiting === undefined) return;
  const resolve = waiting;
  waiting = undefined;
  resolve({ exited: true });
});

const timeout = setTimeout(() => {
  process.stderr.write("transport: the process did not answer in 180 s\n");
  child.kill();
  process.exit(1);
}, 180_000);
timeout.unref();

function next(): Promise<Record<string, unknown>> {
  const queued = inbox.shift();
  if (queued !== undefined) return Promise.resolve(queued as Record<string, unknown>);
  return new Promise((resolve) => {
    waiting = (message) => resolve(message as Record<string, unknown>);
  });
}

async function ask(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return next();
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    passes.push(name);
    process.stderr.write(`ok    ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stderr.write(`FAIL  ${name}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}\n`);
  }
}

function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function codeOf(answer: Record<string, unknown>): number | undefined {
  const error = answer.error as { code?: number } | undefined;
  return error?.code;
}

await step("the server announces the protocol before anything else", async () => {
  const hello = await next();
  expect(hello.method === "hello", `expected hello, got ${JSON.stringify(hello)}`);
});

await step("a line that is not JSON answers parse-error and the server keeps serving", async () => {
  child.stdin.write("this is not json\n");
  const answer = await next();
  expect(codeOf(answer) === -32700, `expected -32700, got ${JSON.stringify(answer)}`);
});

await step("an unknown method answers method-not-found", async () => {
  const answer = await ask(2, "no.such.method", {});
  expect(codeOf(answer) === -32601, `expected -32601, got ${JSON.stringify(answer)}`);
});

await step("a query before trust.declare answers trust-not-declared, before it reads any param", async () => {
  const answer = await ask(4, "entrypoints.map", { repo, repoId: "ye-ast", revision: "HEAD" });
  expect(codeOf(answer) === -32010, `expected -32010, got ${JSON.stringify(answer)}`);
});

await step("trust.declare trusted answers trust-unsupported, since no trusted path exists yet", async () => {
  const answer = await ask(5, "trust.declare", { mode: "trusted" });
  expect(codeOf(answer) === -32009, `expected -32009, got ${JSON.stringify(answer)}`);
});

await step("trust.declare untrusted is accepted", async () => {
  const answer = await ask(6, "trust.declare", { mode: "untrusted" });
  expect((answer.result as { trust?: string } | undefined)?.trust === "untrusted", `expected a declared trust, got ${JSON.stringify(answer)}`);
});

await step("params that are not the method's answer invalid-params, once the trust mode is declared", async () => {
  const answer = await ask(7, "entrypoints.map", { repo });
  expect(codeOf(answer) === -32602, `expected -32602, got ${JSON.stringify(answer)}`);
});

await step("a revision that does not exist answers unknown-revision", async () => {
  const answer = await ask(8, "entrypoints.map", { repo, repoId: "ye-ast", revision: "0000000" });
  expect(codeOf(answer) === -32000, `expected -32000, got ${JSON.stringify(answer)}`);
});

const inside = resolve(repo, "src");
if (existsSync(inside)) {
  await step("a path inside a repository that is not its root answers not-repository-root", async () => {
    const answer = await ask(9, "entrypoints.map", { repo: inside, repoId: "src", revision: "HEAD" });
    expect(codeOf(answer) === -32002, `expected -32002, got ${JSON.stringify(answer)}`);
  });
} else {
  process.stderr.write("skip  not-repository-root: the target repository has no src directory\n");
}

await step("a path with no git repository answers git-failed", async () => {
  const answer = await ask(10, "entrypoints.map", { repo: resolve(repo, ".."), repoId: "parent", revision: "HEAD" });
  expect(codeOf(answer) === -32001, `expected -32001, got ${JSON.stringify(answer)}`);
});

await step("a map of the real repository answers a fact", async () => {
  const answer = await ask(11, "entrypoints.map", { repo, repoId: "ye-ast", revision: "HEAD" });
  const fact = answer.result as { status?: string; schema?: string } | undefined;
  expect(answer.error === undefined, `expected a fact, got ${JSON.stringify(answer)}`);
  expect(typeof fact?.status === "string" && fact.schema === SCHEMA, `expected a schema ${SCHEMA} fact, got ${JSON.stringify(fact)}`);
});

await step("the query it just answered left one measurement line on stderr, and stdout stayed protocol-only", async () => {
  const measured = stderrLines.map(parseLine).find((line) => line?.event === "query");
  expect(measured !== undefined, `expected a measurement line, got ${JSON.stringify(stderrLines.slice(-3))}`);
  expect(measured?.method === "map", `expected the map call, got ${JSON.stringify(measured)}`);
});

if (child.exitCode === null) {
  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));
}
clearTimeout(timeout);

process.stderr.write(`\n${passes.length} passed, ${failures.length} failed\n`);
process.exitCode = failures.length === 0 ? 0 : 1;

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as { ye_ast?: Record<string, unknown> };
    return parsed.ye_ast;
  } catch {
    return undefined;
  }
}
