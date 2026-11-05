import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { EXIT_CODE } from "../cli/main.ts";
import { METHOD } from "../protocol/protocol.ts";
import { connectQueryClient, QueryError } from "../protocol/query-client.ts";
import { composeCli } from "./compose.ts";
import { createTrustRecords } from "../core/adapters/fs/trust-record.adapter.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
class OrderController {
  @GetMapping("/{id}")
  String one() {
    return "x";
  }
}
`;

const MAIN = join(import.meta.dirname, "main.ts");
const TSX = import.meta.resolve("tsx");

let workspace: string;
let repo: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop-service");
  mkdirSync(join(workspace, "cache"));
  mkdirSync(join(workspace, "scratch"));
  mkdirSync(join(repo, dirname("src/main/java/shop/OrderController.java")), { recursive: true });
  writeFileSync(join(repo, "src/main/java/shop/OrderController.java"), CONTROLLER);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) {
    execFileSync("git", args, { cwd: repo, env: GIT_ENV });
  }
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const serveEnv = (): NodeJS.ProcessEnv => ({ ...GIT_ENV, XDG_CACHE_HOME: join(workspace, "cache") });

test("`serve` answers entrypoints.map with the fact `ye-ast map` prints, and writes nothing but protocol lines to stdout", async () => {
  const child = spawn(process.execPath, ["--import", TSX, MAIN, "serve"], { env: serveEnv(), stdio: ["pipe", "pipe", "pipe"] });
  try {
    const stdout: string[] = [];
    const toClient = new PassThrough();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stdout.pipe(toClient);
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    const client = await connectQueryClient({ input: toClient, output: child.stdin, trust: "untrusted" });

    const fact = await client.request(METHOD.entrypointsMap, { repo, repoId: "shop-service", revision: "HEAD" });
    await assert.rejects(client.request(METHOD.entrypointsMap, { repo, repoId: "shop-service", revision: "no-such-revision" }), (error: unknown) => error instanceof QueryError && error.kind === "unknown-revision");
    child.stdin.end();

    assert.equal(await exited, EXIT_CODE.ok);
    const printed: string[] = [];
    const code = await composeCli({ scratchRoot: join(workspace, "scratch") })(["map", "--repo-id", "shop-service", repo], { out: (line) => printed.push(line), err: () => {} });
    assert.equal(code, EXIT_CODE.ok);
    assert.deepEqual(fact, JSON.parse(printed.join("\n")));
    const lines = stdout.join("").split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 4);
    for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  } finally {
    child.kill();
  }
});

test("`serve` takes no arguments: a usage error on stderr, the usage exit code and nothing on stdout", () => {
  const result = spawnSync(process.execPath, ["--import", TSX, MAIN, "serve", "extra"], { env: serveEnv(), encoding: "utf8" });

  assert.equal(result.status, EXIT_CODE.usage);
  assert.equal(result.stdout, "");
  assert.notEqual(result.stderr, "");
});


test("default serve refuses live workspace reads even with a trusted user record", { timeout: 15000 }, async (context) => {
  const config = join(workspace, "config");
  const records = createTrustRecords(join(config, "ye-ast"));
  assert.equal((await records.write(repo, "trusted")).ok, true);
  assert.deepEqual(await records.read(repo), { ok: true, value: "trusted" });
  const child = spawn(process.execPath, ["--import", TSX, MAIN, "serve"], { env: { ...serveEnv(), XDG_CONFIG_HOME: config, TMPDIR: join(workspace, "scratch") }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const abort = () => { child.kill(); };
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  child.stderr.resume();
  let exited = false;
  void closed.then(() => { exited = true; });
  try {
    const client = await connectQueryClient({ input: child.stdout, output: child.stdin, trust: "untrusted" });
    await assert.rejects(client.request(METHOD.declareTrust, { mode: "trusted" }), (error: unknown) => error instanceof QueryError && error.kind === "trust-unsupported");
    await assert.rejects(client.request(METHOD.workspaceOutwardNames, { repo: { path: repo, id: "shop", live: true } }), (error: unknown) => error instanceof QueryError && error.kind === "live-requires-trusted");
    child.stdin.end();
    assert.equal(await closed, EXIT_CODE.ok);
    assert.equal(existsSync(join(repo, ".ye-ast-graph")), false);
    assert.deepEqual(await readdir(join(workspace, "cache")), []);
    const scratch = join(workspace, "scratch");
    const entries = await readdir(scratch);
    assert.ok(entries.every((name) => /^tsx-\d+$/.test(name)));
    const contents = await readdir(scratch, { recursive: true });
    assert.ok(contents.every((name) => !name.endsWith(".lock")));
  } finally {
    context.signal.removeEventListener("abort", abort);
    child.stdin.end();
    if (!exited) child.kill();
    await closed;
  }
});
