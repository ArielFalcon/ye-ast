import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { AnswerFolder } from "../core/ports/answer-files.port.ts";
import { composeCli } from "./compose.ts";
import { processHost } from "./process-host.ts";

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["es2022"], strict: true, noEmit: true } }),
  "package.json": JSON.stringify({ name: "orders", dependencies: {} }),
  "src/order.ts": "export class Order {\n  place(): string {\n    return 'placed';\n  }\n}\n",
  "src/use.ts": "import { Order } from './order';\n\nexport function checkout(): string {\n  return new Order().place();\n}\n",
};

let root: string;
let repo: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "ye-ast-cache-flag-"));
  repo = join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  mkdirSync(repo);
  mkdirSync(join(root, "scratch"));
  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;

function privateDirectory(): string {
  counter += 1;
  const directory = join(root, `cache-${counter}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

async function callers(options: Parameters<typeof composeCli>[0], flags: string[]): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(root, "scratch"), ...options })(["callers", repo, "--revision", "HEAD", ...flags, "src/order.ts:place"], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  return { code, stdout, stderr };
}

test("the cache flag puts the index cache and the derived facts of a command in its directory, which it creates, and leaves the environment's directory untouched", async () => {
  const fromEnvironment = privateDirectory();
  const named = join(root, "named", "store");

  const answered = await callers({ indexCache: fromEnvironment, cacheDirectory: fromEnvironment }, ["--cache", named]);

  assert.equal(answered.code, EXIT_CODE.ok, answered.stderr.join("\n"));
  assert.ok(readdirSync(join(named, "indexes")).length > 0);
  assert.ok(readdirSync(join(named, "derived-facts")).length > 0);
  assert.deepEqual(readdirSync(fromEnvironment), []);
});

test("without the cache flag the environment's directory keeps the caches and the answer is the same bytes", async () => {
  const fromEnvironment = privateDirectory();
  const named = privateDirectory();

  const plain = await callers({ indexCache: fromEnvironment, cacheDirectory: fromEnvironment }, []);
  const flagged = await callers({ indexCache: fromEnvironment, cacheDirectory: fromEnvironment }, [`--cache=${named}`]);

  assert.equal(plain.code, EXIT_CODE.ok, plain.stderr.join("\n"));
  assert.ok(readdirSync(join(fromEnvironment, "indexes")).length > 0);
  assert.ok(readdirSync(join(fromEnvironment, "derived-facts")).length > 0);
  assert.deepEqual(flagged.stdout, plain.stdout);
  assert.ok(readdirSync(join(named, "indexes")).length > 0);
});

test("a host asked for a cache directory keeps queries and answer files in it and never in the one it was built with", async () => {
  const fromEnvironment = privateDirectory();
  const named = privateDirectory();
  const host = processHost({ signal: new AbortController().signal, indexCache: fromEnvironment }).withCache(named);
  const folder: AnswerFolder = { tool: "callers", inputs: { n: 1 }, files: { "answer.json": "{}", "summary.txt": "s", "details.txt": "d" } };

  const result = await host.queries().impact.callers({ repo, repoId: "orders", revision: "HEAD", targets: [{ file: "src/order.ts", symbol: "place" }] });
  const kept = await host.answerFiles!.keep(folder);

  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(kept!.startsWith(join(named, "answers")));
  assert.ok(readdirSync(join(named, "indexes")).length > 0);
  assert.ok(readdirSync(join(named, "derived-facts")).length > 0);
  assert.deepEqual(readdirSync(fromEnvironment), []);
});

test("a cache directory that is open to others or a symbolic link is refused as a usage error before anything runs or is written", async () => {
  const open = join(root, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);

  const refused = await callers({}, ["--cache", open]);

  assert.equal(refused.code, EXIT_CODE.usage);
  assert.deepEqual(refused.stdout, []);
  assert.equal(refused.stderr.length, 1);
  assert.equal(existsSync(join(open, "indexes")), false);
});
