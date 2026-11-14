import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * A TypeScript module with a syntax error stands in a re-export chain. Where every error lies in a statement that is no
 * module statement and writes no module keyword, its module statements are read; otherwise it stays a module whose
 * statements are not read.
 */
const SOURCES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/m.ts": "export const X = 1;\nexport function f(): number { return X; }\n",
  "src/barrel.ts": 'export * from "./m";\nexport const broken = (;\n',
  "src/relay.ts": 'import { X } from "./m";\n\nexport { X as Renamed };\nexport const bad = (;\n',
  "src/lazy.ts": 'export * from "./m";\nexport const load = () => import("./m";\n',
  "src/open.ts": 'export * from "./m";\nfunction g() {\n',
  "src/tail.ts": 'export * from "./m";\nexport const tail = 1 +\n',
  "src/joined.ts": 'const a = 1)export * from "./m";\n',
  "src/merged.ts": 'export * from "./m";\n<<<<<<< ours\nexport const a = 1;\n=======\nexport * from "./n";\n>>>>>>> theirs\nexport const b = 2;\n',
  "src/k.ts": "export const K = 1;\n",
  "src/k-reader.ts": 'import { K } from "./k";\n\nexport function before(): number {\n  return K;\n}\nexport const oops = (;\n',
  "src/own.ts": "export const O = 1;\nexport function useO(): number {\n  return O;\n}\nexport const oops = (;\n",
  "src/user.ts": 'import * as b from "./barrel";\nimport { f } from "./barrel";\nimport * as r from "./relay";\nimport * as t from "./tail";\n\nexport function viaNamespace(): number {\n  return b.X;\n}\n\nexport function viaName(): number {\n  return f();\n}\n\nexport function viaRelay(): number {\n  return r.Renamed;\n}\n\nexport function viaTail(): number {\n  return t.X;\n}\n',
};

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
let repo: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-written-uses-unparsed-"));
  scratchRoot = join(root, "scratch");
  repo = join(root, "repo");
  await mkdir(scratchRoot);
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  for (const [path, text] of Object.entries(SOURCES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env: ENV });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const dependents = (value: ImpactValue) => value.symbols.filter(({ depth }) => depth > 0).map(({ file, symbol, via }) => ({ file, symbol, basis: via?.basis, lines: via?.lines ?? [] }));

test("a declaration read through the namespace of a module whose syntax error spares its module statements is a dependent, also where that module's tokens are not read, and only the file whose tokens are not read cuts it", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "fixture", revision: "HEAD", targets: [{ file: "src/m.ts", symbol: "X" }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));

  assert.equal(result.value.status, "partial");
  assert.deepEqual(result.value.cuts.map(({ reason, at }) => ({ reason, at })), [{ reason: "hidden-caller", at: ["src/m.ts::X", "src/relay.ts:1 X"] }]);
  assert.deepEqual(dependents(result.value.value), [
    { file: "src/m.ts", symbol: "f", basis: "reference", lines: [2] },
    { file: "src/user.ts", symbol: "viaNamespace", basis: "reference", lines: [7] },
    { file: "src/user.ts", symbol: "viaRelay", basis: "reference", lines: [15] },
    { file: "src/user.ts", symbol: "viaTail", basis: "reference", lines: [19] },
    { file: "src/user.ts", symbol: "viaName", basis: "call", lines: [11] },
  ]);
});

test("a module whose syntax error lies in a statement that writes a module keyword, at the start of a module statement, or outside every statement (a conflict marker), keeps its module statements unread", async () => {
  const result = await composeQueries({ scratchRoot }).impact.importers({ repo, repoId: "fixture", revision: "HEAD", files: ["src/barrel.ts", "src/joined.ts", "src/lazy.ts", "src/merged.ts", "src/open.ts", "src/tail.ts"] });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));

  assert.deepEqual(result.value.cuts.map(({ reason, at }) => ({ reason, at })), [
    { reason: "module-unread", at: ["src/joined.ts"] },
    { reason: "module-unread", at: ["src/lazy.ts"] },
    { reason: "module-unread", at: ["src/merged.ts"] },
    { reason: "module-unread", at: ["src/open.ts"] },
  ]);
});

test("a file whose tokens are not read cuts the answer of each declaration it may write, its own or one it imports by name, at the file", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "fixture", revision: "HEAD", targets: [{ file: "src/k.ts", symbol: "K" }, { file: "src/own.ts", symbol: "O" }] });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));

  assert.deepEqual(dependents(result.value.value), [{ file: "src/k-reader.ts", symbol: "before", basis: "import", lines: [] }]);
  assert.deepEqual(result.value.cuts.map(({ reason, at }) => ({ reason, at })), [
    { reason: "hidden-caller", at: ["src/k-reader.ts::before", "src/k-reader.ts:1 before"] },
    { reason: "hidden-caller", at: ["src/k.ts::K", "src/k-reader.ts:1 K"] },
    { reason: "hidden-caller", at: ["src/own.ts::O", "src/own.ts:1 O"] },
  ]);
});
