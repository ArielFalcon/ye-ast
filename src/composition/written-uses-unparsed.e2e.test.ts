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

/**
 * Modules whose statements are not read stand in the chains of re-exports of declarations: each writes the specifier of
 * its declaration's module as a string, except the one outside the chain of `Q`.
 */
const UNREAD_CHAINS: Record<string, string> = {
  "package.json": SOURCES["package.json"]!,
  "tsconfig.json": SOURCES["tsconfig.json"]!,
  "src/s.ts": "export const S = 1;\n",
  "src/s-barrel.ts": 'export * from "./s";\nexport const load = () => import("./s";\n',
  "src/s-reader.ts": 'import * as sb from "./s-barrel";\n\nexport function viaStar(): number {\n  return sb.S;\n}\n',
  "src/t.ts": "export const T = 1;\n",
  "src/t-middle.ts": 'export * from "./t";\nexport const load = () => import("./t";\n',
  "src/t-outer.ts": 'export * from "./t-middle";\n',
  "src/t-reader.ts": 'import * as to from "./t-outer";\n\nexport function viaOuter(): number {\n  return to.T;\n}\n',
  "src/t-name-reader.ts": 'import { T } from "./t-outer";\n\nexport function viaOuterName(): number {\n  return T;\n}\n',
  "src/t-alias.ts": 'export { T as Alias } from "./t";\nexport const load = () => import("./t";\n',
  "src/t-relay.ts": 'import { Alias } from "./t-alias";\n\nexport { Alias as Relayed };\n',
  "src/t-relay-reader.ts": 'import { Relayed } from "./t-relay";\n\nexport function viaRelayed(): number {\n  return Relayed;\n}\n',
  "src/n.ts": "export const N = 1;\n",
  "src/n-barrel.ts": 'export { N } from "./n";\nexport const load = () => import("./n";\n',
  "src/n-reader.ts": 'import { N } from "./n-barrel";\n\nexport function viaN(): number {\n  return N;\n}\n',
  "src/d.ts": "export default function D(): number {\n  return 2;\n}\n",
  "src/d-barrel.ts": 'export { default } from "./d";\nexport const load = () => import("./d";\n',
  "src/d-reader.ts": 'import Renamed from "./d-barrel";\n\nexport function viaDefault(): number {\n  return Renamed();\n}\n',
  "src/d-outer.ts": 'export { default as Outer } from "./d-barrel";\nexport const Other = 1;\n',
  "src/d-other-reader.ts": 'import { Other } from "./d-outer";\n\nexport function viaOther(): number {\n  return Other;\n}\n',
  "src/d-outer-reader.ts": 'import { Outer } from "./d-outer";\n\nexport function viaOuterDefault(): number {\n  return Outer();\n}\n',
  "src/i.ts": "export const I = 1;\n",
  "src/i-relay.ts": 'import { I } from "./i";\nexport { I };\nexport const load = () => import("./i";\n',
  "src/i-reader.ts": 'import * as ir from "./i-relay";\n\nexport function viaRelay(): number {\n  return ir.I;\n}\n',
  "src/q.ts": "export const Q = 1;\n",
  "src/q-barrel.ts": 'export * from "./q";\n',
  "src/q-reader.ts": 'import * as qb from "./q-barrel";\n\nexport function viaQ(): number {\n  return qb.Q;\n}\n',
  "src/z.ts": "export const Z = 1;\n",
  "src/z-barrel.ts": 'export * from "./z";\nexport const load = () => import("./z";\n',
  "src/z-reader.ts": 'import * as zb from "./z-barrel";\n\nexport const viaZ = zb.Z;\n',
};

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
let repo: string;
let chains: string;

async function commit(at: string, sources: Record<string, string>): Promise<void> {
  await mkdir(at);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: at, env: ENV });
  for (const [path, text] of Object.entries(sources)) {
    await mkdir(dirname(join(at, path)), { recursive: true });
    await writeFile(join(at, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: at, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: at, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-written-uses-unparsed-"));
  scratchRoot = join(root, "scratch");
  repo = join(root, "repo");
  chains = join(root, "chains");
  await mkdir(scratchRoot);
  await commit(repo, SOURCES);
  await commit(chains, UNREAD_CHAINS);
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

const cutsOf = async (file: string, symbol: string) => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo: chains, repoId: "fixture", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return { status: result.value.status, cuts: (result.value.status === "partial" ? result.value.cuts : []).map(({ reason, at }) => ({ reason, at })), dependents: dependents(result.value.value).map(({ file, symbol }) => `${file}:${symbol}`) };
};

test("a namespace of a module whose statements are not read, or of a module re-exporting from it, is cut at its read when a string that module writes leads to the declaration's module", async () => {
  assert.deepEqual(await cutsOf("src/s.ts", "S"), { status: "partial", cuts: [{ reason: "hidden-caller", at: ["src/s.ts::S", "src/s-reader.ts:4 sb"] }], dependents: [] });
  assert.deepEqual(await cutsOf("src/t.ts", "T"), {
    status: "partial",
    cuts: [
      { reason: "hidden-caller", at: ["src/t-alias.ts::load", "src/t-alias.ts:1 load"] },
      { reason: "hidden-caller", at: ["src/t.ts::T", "src/t-reader.ts:4 to", "src/t-relay-reader.ts:4 Relayed"] },
    ],
    dependents: ["src/t-name-reader.ts:viaOuterName"],
  });
});

test("a name imported from a module whose statements are not read, or from a module re-exporting it, is cut at its read when a string that module writes leads to the declaration's module", async () => {
  assert.deepEqual(await cutsOf("src/d.ts", "D"), { status: "partial", cuts: [{ reason: "hidden-caller", at: ["src/d.ts::D", "src/d-outer-reader.ts:4 Outer", "src/d-reader.ts:4 Renamed"] }], dependents: [] });
});

test("a read through a module whose statements are not read gains no second mark where the answer already lists or cuts the place", async () => {
  assert.deepEqual(await cutsOf("src/n.ts", "N"), { status: "partial", cuts: [{ reason: "hidden-caller", at: ["src/n-barrel.ts::load", "src/n-barrel.ts:1 load"] }], dependents: ["src/n-reader.ts:viaN"] });
  assert.deepEqual(await cutsOf("src/i.ts", "I"), { status: "partial", cuts: [{ reason: "hidden-caller", at: ["src/i-relay.ts::load", "src/i-reader.ts:4 ir", "src/i-relay.ts:1 load"] }], dependents: ["src/i-relay.ts:load"] });
});

test("a module whose statements are not read and whose strings lead to no module of the declaration's chain marks nothing", async () => {
  assert.deepEqual(await cutsOf("src/q.ts", "Q"), { status: "complete", cuts: [], dependents: ["src/q-reader.ts:viaQ"] });
});
