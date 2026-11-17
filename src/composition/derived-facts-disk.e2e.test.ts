import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["es2022"], strict: true, noEmit: true } }),
  "package.json": JSON.stringify({ name: "orders", dependencies: {} }),
  "src/order.ts": "export class Order {\n  place(): string {\n    return 'placed';\n  }\n}\n",
  "src/use.ts": "import { Order } from './order';\n\nexport function checkout(): string {\n  return new Order().place();\n}\n",
  "src/log.ts": "export function log(): void {\n  console.log('x');\n}\n",
};

let root: string;
let repo: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "ye-ast-derived-disk-"));
  repo = join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  mkdirSync(repo);
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

function cacheOf(): string {
  counter += 1;
  const directory = join(root, `cache-${counter}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

async function callersInNewProcess(options: { indexCache?: string; cacheDirectory?: string }): Promise<{ answer: string; diskHits: number; misses: number }> {
  const lines: string[] = [];
  const queries = composeQueries({ scratchRoot: join(root, "scratch"), measure: (line) => lines.push(line), ...options });
  const result = await queries.impact.callers({ repo, repoId: "orders", revision: "HEAD", targets: [{ file: "src/order.ts", symbol: "place" }] });
  assert.ok(result.ok, JSON.stringify(result));
  const facts = lines.map((line) => JSON.parse(line).ye_ast).filter((record) => record.event === "derived-facts");
  return { answer: JSON.stringify(result.value), diskHits: facts.reduce((sum, record) => sum + record.disk_hits, 0), misses: facts.reduce((sum, record) => sum + record.misses, 0) };
}

function storedEntries(cache: string): string[] {
  return readdirSync(join(cache, "derived-facts"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

test("a second process over the same snapshot and cache directory answers from the disk tier, byte for byte, and stores no other entry", async () => {
  mkdirSync(join(root, "scratch"), { recursive: true });
  const cache = cacheOf();
  const cold = await callersInNewProcess({ indexCache: cache });
  const stored = storedEntries(cache);

  const warm = await callersInNewProcess({ indexCache: cache });

  assert.equal(cold.diskHits, 0);
  assert.ok(stored.length > 0);
  assert.equal(warm.answer, cold.answer);
  assert.ok(warm.diskHits > 0);
  assert.ok(warm.misses < cold.misses);
  assert.deepEqual(storedEntries(cache).sort(), stored.sort());
});

test("an entry that does not verify is a miss: it is removed, derived again and the answer is the same", async () => {
  const cache = cacheOf();
  const cold = await callersInNewProcess({ indexCache: cache });
  const damaged = storedEntries(cache);
  for (const path of damaged) writeFileSync(path, `${readFileSync(path, "utf8")}tampered`);

  const after = await callersInNewProcess({ indexCache: cache });

  assert.equal(after.answer, cold.answer);
  assert.equal(after.diskHits, 0);
  assert.ok(storedEntries(cache).every((path) => !readFileSync(path, "utf8").endsWith("tampered")));
});

test("without the index cache directory nothing is stored, and a second process derives again", async () => {
  const unused = cacheOf();
  const first = await callersInNewProcess({ cacheDirectory: unused });
  const second = await callersInNewProcess({ cacheDirectory: unused });

  assert.deepEqual(readdirSync(unused), []);
  assert.equal(second.diskHits, 0);
  assert.equal(second.misses, first.misses);
});
