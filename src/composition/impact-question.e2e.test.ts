import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import { composeCli } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });

let workspace: string;
let repo: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop");
  mkdirSync(repo);
  mkdirSync(join(workspace, "scratch"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function commit(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "change"], { cwd: repo, env: GIT_ENV });
}

async function ask(...args: string[]): Promise<{ status: string; cuts?: Cut[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })([args[0]!, repo, ...args.slice(1)], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const specifiers = (fact: { cuts?: Cut[] }): string[] => (fact.cuts ?? []).filter(({ reason }) => reason === "specifier").map(({ at }) => at[0]!);

test("impact drops a specifier no path of the snapshot could be the target of, since it is no edge into a walked module, and keeps one a build could replace in", async () => {
  commit({
    "tsconfig.json": TSCONFIG,
    "src/a.ts": "export function a() { return 1; }\n",
    "src/b.ts": `import { a } from "./a";\nexport function b() { return a(); }\n`,
    "src/map.ts": `import type { Feature } from "geojson";\nexport type F = Feature;\n`,
    "src/environments/environment.prod.ts": "export const environment = {};\n",
    "src/auth.ts": `import { environment } from "@/environments/environment";\nexport const auth = environment;\n`,
  });
  commit({ "src/a.ts": "export function a() { return 2; }\n" });

  const fact = await ask("impact", "--base", "HEAD~1");

  assert.equal(fact.status, "partial");
  assert.deepEqual(specifiers(fact), ["module:base:src/auth.ts", "module:head:src/auth.ts"]);
});

test("callers of a Java method are not cut by a computed dynamic import in TypeScript, which cannot load it", async () => {
  commit({
    "src/main/java/shop/Order.java": "package shop;\n\nclass Order {\n  void save() {}\n  void run() { save(); }\n}\n",
    "web/loader.ts": "export async function load(name: string) { return import(name); }\n",
    "web/a.ts": "export function a() { return 1; }\n",
  });

  assert.equal((await ask("callers", "src/main/java/shop/Order.java:Order.save")).status, "complete");
  const typescript = await ask("callers", "web/a.ts:a");
  assert.deepEqual((typescript.cuts ?? []).filter(({ reason }) => reason === "dynamic-load").map(({ at }) => at[0]), ["web/loader.ts"]);
});
