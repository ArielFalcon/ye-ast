import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Parser, type Tree } from "web-tree-sitter";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { composeQueries } from "./compose.ts";

const CALLER = "src/main/java/app/web/OrderController.java";
const SERVICE = "src/main/java/app/service/OrderService.java";
const STORE = "src/main/java/app/store/OrderStore.java";
const FILES: Record<string, string> = {
  [CALLER]: ["package app.web;", "", "import app.service.OrderService;", "", "public class OrderController {", "  private final OrderService service = new OrderService();", "  public int one() {", "    return service.find(1);", "  }", "}", ""].join("\n"),
  [SERVICE]: ["package app.service;", "", "import app.store.OrderStore;", "", "public class OrderService {", "  private final OrderStore store = new OrderStore();", "  public int find(int id) {", "    return store.load(id);", "  }", "}", ""].join("\n"),
  [STORE]: ["package app.store;", "", "public class OrderStore {", "  public int load(int id) {", "    return id;", "  }", "}", ""].join("\n"),
};
const CHANGED_STORE = FILES[STORE]!.replace("return id;", "return id + 1;");

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-java-parse-holds-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
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

test("a query parses each Java source of its snapshot once, however many readers read it, and frees every tree before it answers", async () => {
  const result = await trace(composeQueries({ scratchRoot }), "HEAD");
  assert.ok(result.ok, JSON.stringify(result));
  assert.notEqual(result.value.status, "unknown", JSON.stringify(result.value));

  assert.deepEqual(parsedJava(), { [CALLER]: 1, [SERVICE]: 1, [`${STORE}@HEAD`]: 1 });
  assert.equal(native.alive.size, 0);
});

test("concurrent queries on one snapshot and on two parse their own trees and free all of them, answering as they do one at a time", async () => {
  const alone = [];
  for (const revision of ["HEAD", "HEAD", "HEAD~1"]) alone.push(canonicalJson(await trace(composeQueries({ scratchRoot }), revision)));
  const queries = composeQueries({ scratchRoot });
  native.parses.clear();

  const together = await Promise.all(["HEAD", "HEAD", "HEAD~1"].map((revision) => trace(queries, revision)));

  assert.deepEqual(together.map((answer) => canonicalJson(answer)), alone);
  assert.deepEqual(parsedJava(), { [CALLER]: 3, [SERVICE]: 3, [STORE]: 1, [`${STORE}@HEAD`]: 2 });
  assert.equal(native.alive.size, 0);
});
