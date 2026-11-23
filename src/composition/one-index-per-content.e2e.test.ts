import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { composeCli, composeQueries } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const DIR = "src/main/java/shop/";
const UTIL = `${DIR}Util.java`;
const FILES = {
  [UTIL]: "package shop;\n\nclass Util {\n  static String fmt(String s) {\n    return s;\n  }\n}\n",
  [`${DIR}OrderService.java`]: 'package shop;\n\nclass OrderService {\n  String find() {\n    return Util.fmt("x");\n  }\n}\n',
};
const AUDIT = { [`${DIR}Audit.java`]: 'package shop;\n\nclass Audit {\n  String note() {\n    return Util.fmt("audit");\n  }\n}\n' };
const PLANTED = 'package shop;\n\nclass Planted {\n  String planted() {\n    return Util.fmt("planted");\n  }\n}\n';

let workspace: string;
let repo: string;
let scratchRoot: string;
let trustDirectory: string;
let indexCache: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-one-index-"));
  repo = join(workspace, "shop");
  scratchRoot = join(workspace, "scratch");
  trustDirectory = join(workspace, "config", "ye-ast");
  indexCache = join(workspace, "index-cache");
  mkdirSync(repo);
  mkdirSync(scratchRoot);
  git(repo, "init", "-q", "-b", "main");
  write(FILES);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  assert.equal(await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", "trusted", repo], { out: () => undefined, err: () => undefined }), EXIT_CODE.ok);
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

/** One composition, as one MCP process holds it, that counts the index lines by outcome. */
function session() {
  const lines: string[] = [];
  const queries = composeQueries({ scratchRoot, trustDirectory, indexCache, measure: (line) => lines.push(line) });
  const outcomes = (outcome: string): number => lines.map((line) => JSON.parse(line).ye_ast).filter((event) => event.event === "index" && event.outcome === outcome).length;
  const callers = async (at: { live: true } | { revision: string }, root = repo) => {
    const answer = await queries.impact.callers({ repo: root, repoId: "shop", targets: [{ file: UTIL, symbol: "fmt" }], ...at });
    if (!answer.ok || answer.value.status === "unknown") throw new assert.AssertionError({ message: JSON.stringify(answer) });
    return answer.value;
  };
  return { callers, built: () => outcomes("built"), adopted: () => outcomes("adopted"), synced: () => outcomes("synced") };
}

const kept = (): string[] => readdirSync(join(indexCache, "indexes")).filter((name) => !name.startsWith(".")).sort();

test("a live query and then a sha query of the same content build the index once, and an untrusted clone of that content reads the same store", async () => {
  const { callers, built, adopted } = session();

  const live = await callers({ live: true });
  const sha = await callers({ revision: "HEAD" });
  const clone = join(workspace, "clone");
  git(workspace, "clone", "-q", repo, clone);
  const untrusted = await callers({ revision: "HEAD" }, clone);

  assert.equal(built(), 1);
  assert.equal(adopted(), 1);
  assert.deepEqual(live.inputs.origin, { kind: "full" });
  assert.equal(untrusted.inputs.trust, "untrusted");
  assert.equal(canonicalJson(sha.value), canonicalJson(live.value));
  assert.equal(canonicalJson(untrusted.value), canonicalJson(sha.value));
});

test("a sha query and then a live query of the same content build the index once", async () => {
  const { callers, built, adopted } = session();

  const sha = await callers({ revision: "HEAD" });
  const live = await callers({ live: true });

  assert.equal(built(), 1);
  assert.equal(adopted(), 1);
  assert.deepEqual(live.inputs.origin, { kind: "full" });
  assert.equal(canonicalJson(live.value), canonicalJson(sha.value));
});

test("a sync-derived store is never published: the cache keeps no index of the synced content, and a sha query of it builds its own", async () => {
  const { callers, built, synced } = session();
  await callers({ live: true });
  const published = kept();
  write(AUDIT);

  const edited = await callers({ live: true });
  const afterSync = kept();
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "audit");
  const sha = await callers({ revision: "HEAD" });

  assert.equal(synced(), 1);
  assert.deepEqual(afterSync, published);
  assert.equal(built(), 2);
  assert.ok(canonicalJson(edited.value).includes("Audit.java"));
  assert.equal(canonicalJson(sha.value), canonicalJson(edited.value));
});

test("a first live build over an edited tree is kept by the edited content, so a sha query of HEAD builds its own and answers HEAD", async () => {
  const { callers, built } = session();
  write(AUDIT);

  const live = await callers({ live: true });
  const sha = await callers({ revision: "HEAD" });

  assert.equal(built(), 2);
  assert.ok(canonicalJson(live.value).includes("Audit.java"));
  assert.ok(!canonicalJson(sha.value).includes("Audit.java"));
});

test("an index tree holding a file the working tree does not is never published, so an untrusted sha query of that content builds its own and never reads the file", async () => {
  const { callers, built } = session();
  await callers({ live: true });
  const published = kept();
  const live = join(repo, ".ye-ast-graph", "live");
  const scope = readdirSync(live, { withFileTypes: true }).find((entry) => entry.isDirectory())!.name;
  const indexTree = join(live, scope, ".ye-ast-graph", "index-tree");
  assert.ok(existsSync(join(indexTree, UTIL)));
  writeFileSync(join(indexTree, DIR, "Planted.java"), PLANTED);
  rmSync(join(indexTree, ".ye-ast-graph"), { recursive: true, force: true });
  write(AUDIT);

  await callers({ live: true });
  const afterTamper = kept();
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "audit");
  const clone = join(workspace, "clone");
  git(workspace, "clone", "-q", repo, clone);
  const builtBefore = built();
  const untrusted = await callers({ revision: "HEAD" }, clone);

  assert.deepEqual(afterTamper, published, "the tampered tree reaches no kept index");
  assert.equal(built(), builtBefore + 1, "the untrusted query builds its own index");
  assert.equal(untrusted.status, "complete");
  assert.ok(canonicalJson(untrusted.value).includes("Audit.java"));
  assert.ok(!canonicalJson(untrusted.value).includes("Planted.java"));
});
