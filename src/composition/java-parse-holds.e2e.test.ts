import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Parser, type Tree } from "web-tree-sitter";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { EXIT_CODE } from "../cli/main.ts";
import { composeCli, composeQueries } from "./compose.ts";

const CALLER = "src/main/java/app/web/OrderController.java";
const SERVICE = "src/main/java/app/service/OrderService.java";
const STORE = "src/main/java/app/store/OrderStore.java";
const FILES: Record<string, string> = {
  [CALLER]: ["package app.web;", "", "import app.service.OrderService;", "", "public class OrderController {", "  private final OrderService service = new OrderService();", "  public int one() {", "    return service.find(1);", "  }", "}", ""].join("\n"),
  [SERVICE]: ["package app.service;", "", "import app.store.OrderStore;", "", "public class OrderService {", "  private final OrderStore store = new OrderStore();", "  public int find(int id) {", "    return store.load(id);", "  }", "}", ""].join("\n"),
  [STORE]: ["package app.store;", "", "public class OrderStore {", "  public int load(int id) {", "    return id;", "  }", "}", ""].join("\n"),
};
const CHANGED_STORE = FILES[STORE]!.replace("return id;", "return id + 1;");

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-java-parse-holds-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  const env = GIT_ENV;
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env });
  await writeFile(join(repo, STORE), CHANGED_STORE);
  execFileSync("git", ["commit", "-qam", "change the store"], { cwd: repo, env });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every native Java parse, by the source parsed, and the trees not freed yet. */
const native = { parses: new Map<string, number>(), alive: new Set<Tree>() };
const parse = Parser.prototype.parse;

beforeEach(() => {
  native.parses.clear();
  native.alive.clear();
  Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser["parse"]>) {
    const tree = parse.apply(this, args);
    const [source] = args;
    if (tree !== null && typeof source === "string") {
      native.parses.set(source, (native.parses.get(source) ?? 0) + 1);
      native.alive.add(tree);
      const free = tree.delete.bind(tree);
      tree.delete = () => {
        native.alive.delete(tree);
        free();
      };
    }
    return tree;
  };
});

afterEach(() => {
  Parser.prototype.parse = parse;
});

const trace = (queries: ReturnType<typeof composeQueries>, revision: string) => queries.trace.walk({ repo, repoId: "java-parse-holds", revision, targets: [{ file: CALLER, symbol: "OrderController.one" }] });

/** The fixture's sources by their text; the store as the head commit changed it is `<path>@HEAD`. */
const NAMES = new Map<string, string>([...Object.entries(FILES).map(([path, text]): [string, string] => [text, path]), [CHANGED_STORE, `${STORE}@HEAD`]]);
const parsedJava = (): Record<string, number> => Object.fromEntries([...native.parses].flatMap(([source, count]) => (NAMES.has(source) ? [[NAMES.get(source)!, count]] : [])));

test("a query parses each Java source of its snapshot once, however many readers read it, and every tree it does not leave resident is freed before it answers", async () => {
  const resident = await trace(composeQueries({ scratchRoot }), "HEAD");
  assert.ok(resident.ok, JSON.stringify(resident));
  assert.notEqual(resident.value.status, "unknown", JSON.stringify(resident.value));
  assert.deepEqual(parsedJava(), { [CALLER]: 1, [SERVICE]: 1, [`${STORE}@HEAD`]: 1 });
  assert.equal(native.alive.size, 3);

  native.parses.clear();
  native.alive.clear();
  const none = await trace(composeQueries({ scratchRoot, snapshotCacheBytes: 0 }), "HEAD");
  assert.equal(canonicalJson(none), canonicalJson(resident));
  assert.deepEqual(parsedJava(), { [CALLER]: 1, [SERVICE]: 1, [`${STORE}@HEAD`]: 1 });
  assert.equal(native.alive.size, 0);
});

test("after a commit changes one source, the next query of a composition parses only that source and answers as a cold composition does", async () => {
  const queries = composeQueries({ scratchRoot });
  assert.ok((await trace(queries, "HEAD~1")).ok);
  native.parses.clear();

  const warm = await trace(queries, "HEAD");

  assert.deepEqual(parsedJava(), { [`${STORE}@HEAD`]: 1 });
  assert.equal(canonicalJson(warm), canonicalJson(await trace(composeQueries({ scratchRoot }), "HEAD")));
});

/** A trusted clone of the fixture at its first commit, where an edit of the store's working tree is what the head commit changed. */
async function trustedClone(): Promise<{ live: string; trustDirectory: string }> {
  const live = join(root, `live-${randomUUID()}`);
  execFileSync("git", ["clone", "-q", repo, live], { env: GIT_ENV });
  execFileSync("git", ["checkout", "-q", "HEAD~1"], { cwd: live, env: GIT_ENV });
  const trustDirectory = join(root, `trust-${randomUUID()}`);
  assert.equal(await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", "trusted", live], { out: () => undefined, err: () => undefined }), EXIT_CODE.ok);
  return { live, trustDirectory };
}

for (const [family, ask] of [
  ["trace", (queries: ReturnType<typeof composeQueries>, live: string) => queries.trace.walk({ repo: live, repoId: "java-parse-holds-live", live: true, targets: [{ file: CALLER, symbol: "OrderController.one" }] })],
  ["map", (queries: ReturnType<typeof composeQueries>, live: string) => queries.entrypoints.map({ repo: live, repoId: "java-parse-holds-live", live: true })],
] as const) {
  test(`after an edit of the working tree, the next live ${family} parses only the edited source and answers as a cold composition does`, async () => {
    const { live, trustDirectory } = await trustedClone();
    const queries = composeQueries({ scratchRoot, trustDirectory });
    assert.ok((await ask(queries, live)).ok);
    await writeFile(join(live, STORE), CHANGED_STORE);
    native.parses.clear();

    const warm = await ask(queries, live);

    assert.deepEqual(parsedJava(), { [`${STORE}@HEAD`]: 1 });
    assert.equal(canonicalJson(warm), canonicalJson(await ask(composeQueries({ scratchRoot, trustDirectory }), live)));
  });
}

test("concurrent queries on one snapshot and on two share the tree of each source, parse it once, and answer as they do one at a time", async () => {
  const alone = [];
  for (const revision of ["HEAD", "HEAD", "HEAD~1"]) alone.push(canonicalJson(await trace(composeQueries({ scratchRoot }), revision)));
  const queries = composeQueries({ scratchRoot });
  native.parses.clear();
  native.alive.clear();

  const together = await Promise.all(["HEAD", "HEAD", "HEAD~1"].map((revision) => trace(queries, revision)));

  assert.deepEqual(together.map((answer) => canonicalJson(answer)), alone);
  assert.deepEqual(parsedJava(), { [CALLER]: 1, [SERVICE]: 1, [STORE]: 1, [`${STORE}@HEAD`]: 1 });
  assert.equal(native.alive.size, 4);
});

test("a query aborted while it parses keeps the trees it parsed whole resident, and the next query reuses them, parses no source twice and answers as a cold composition does", async () => {
  const queries = composeQueries({ scratchRoot });
  const aborting = new AbortController();
  const hooked = Parser.prototype.parse;
  Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser["parse"]>) {
    const tree = hooked.apply(this, args);
    aborting.abort();
    return tree;
  };
  const aborted = await queries.trace.walk({ repo, repoId: "java-parse-holds", revision: "HEAD", targets: [{ file: CALLER, symbol: "OrderController.one" }], signal: aborting.signal });
  Parser.prototype.parse = hooked;
  const parsedBefore = parsedJava();
  assert.ok(Object.keys(parsedBefore).length >= 1, JSON.stringify(aborted));

  const answer = await trace(queries, "HEAD");

  assert.deepEqual(parsedJava(), { [CALLER]: 1, [SERVICE]: 1, [`${STORE}@HEAD`]: 1 });
  assert.equal(canonicalJson(answer), canonicalJson(await trace(composeQueries({ scratchRoot }), "HEAD")));
});

test("a live map that keeps nothing resident frees every tree it parsed before it answers", async () => {
  const { live, trustDirectory } = await trustedClone();
  native.parses.clear();
  native.alive.clear();

  const answer = await composeQueries({ scratchRoot, trustDirectory, snapshotCacheBytes: 0 }).entrypoints.map({ repo: live, repoId: "java-parse-holds-live", live: true });

  assert.ok(answer.ok, JSON.stringify(answer));
  assert.ok(native.parses.size > 0);
  assert.equal(native.alive.size, 0);
});
