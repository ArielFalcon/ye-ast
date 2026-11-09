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

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } } });

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
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

async function importers(file: string, ...options: string[]): Promise<{ status: string; cuts?: Cut[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["importers", repo, ...options, file], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const reasons = (fact: { cuts?: Cut[] }): string[] => (fact.cuts ?? []).map(({ at, reason }) => `${at[0]} ${reason}`);

test("an unresolved TypeScript specifier cannot import a Java file, so the Java file's importers stay complete (ADR-0042 fixture 1)", async () => {
  commit({
    "src/main/java/shop/Order.java": "package shop;\n\nclass Order {}\n",
    "build/bundle.ts": `import { build } from "esbuild";\nexport const run = build;\n`,
  });

  const fact = await importers("src/main/java/shop/Order.java");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
});

test("a specifier the resolver's path mapping found no file for cannot import the asked file", async () => {
  commit({
    "tsconfig.json": TSCONFIG,
    "src/app/a.ts": "export const a = 1;\n",
    "src/app/auth.service.ts": `import { environment } from "@app/environments/environment";\nexport const auth = environment;\n`,
  });

  assert.equal((await importers("src/app/a.ts")).status, "complete");
});

test("a specifier no module configuration governs could be resolved to the asked file by a path mapping of the snapshot, so it stays in question (ADR-0042 fixture 2)", async () => {
  commit({ "web/tsconfig.json": TSCONFIG, "web/src/app/a.ts": "export const a = 1;\n", "scripts/seed.ts": `import { a } from "@app/a";\nexport const seed = a;\n` });

  const ungoverned = await importers("web/src/app/a.ts");

  assert.equal(ungoverned.status, "partial");
  assert.deepEqual(reasons(ungoverned), ["scripts/seed.ts specifier"]);
});

test("a relative specifier TypeScript may resolve to a file the engine's own lookup misses stays a cut of that file's importers", async () => {
  commit({
    "src/foo.ts": "export const foo = 1;\n",
    "src/a.ts": `import { foo } from "./foo.js";\nexport const a = foo;\n`,
    "src/bar.mts": "export const bar = 1;\n",
    "src/b.ts": `import { bar } from "./bar.mjs";\nexport const b = bar;\n`,
  });

  const foo = await importers("src/foo.ts");
  const bar = await importers("src/bar.mts");

  assert.equal(foo.status, "partial");
  assert.ok(reasons(foo).includes("src/a.ts specifier"), JSON.stringify(foo.cuts));
  assert.equal(bar.status, "partial");
  assert.ok(reasons(bar).includes("src/b.ts specifier"), JSON.stringify(bar.cuts));
});

test("a path mapping TypeScript cannot follow may still name a file a build replaces in, so the specifier stays a cut", async () => {
  commit({
    "tsconfig.json": TSCONFIG,
    "src/app/environments/environment.prod.ts": "export const environment = {};\n",
    "src/app/auth.service.ts": `import { environment } from "@app/environments/environment";\nexport const auth = environment;\n`,
  });

  const fact = await importers("src/app/environments/environment.prod.ts");

  assert.equal(fact.status, "partial");
  assert.deepEqual(reasons(fact), ["src/app/auth.service.ts specifier"]);
});

test("a configuration whose extends chain is not read proves no specifier names no file, for its paths or its rootDirs", async () => {
  commit({
    "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
    "config/base.json": JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@app/thing": ["shared/foo.ts"] }, rootDirs: ["../src", "../generated"] } }),
    "src/a.ts": `import "@app/thing";\nexport const a = 1;\n`,
    "src/b.ts": `import { thing } from "./thing";\nexport const b = thing;\n`,
    "shared/foo.ts": "export const foo = 1;\n",
    "generated/thing.ts": "export const thing = 1;\n",
  });

  const mapped = await importers("shared/foo.ts", "--exclude", "config/**");
  const rooted = await importers("generated/thing.ts", "--exclude", "config/**");

  assert.equal(mapped.status, "partial");
  assert.ok(reasons(mapped).includes("src/a.ts specifier"), JSON.stringify(mapped.cuts));
  assert.equal(rooted.status, "partial");
  assert.ok(reasons(rooted).includes("src/b.ts specifier"), JSON.stringify(rooted.cuts));
});

test("a non-literal dynamic import in the asked file's runtime keeps its importers partial (ADR-0042 fixture 3)", async () => {
  commit({
    "src/a.ts": "export const a = 1;\n",
    "src/loader.ts": "export async function load(name: string) { return import(name); }\n",
  });

  const fact = await importers("src/a.ts");

  assert.equal(fact.status, "partial");
  assert.deepEqual(reasons(fact), ["src/loader.ts dynamic-load"]);
});
