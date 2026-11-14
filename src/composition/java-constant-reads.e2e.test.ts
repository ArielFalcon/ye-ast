import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * The declarations that read a Java constant in other files depend on it, wherever the sources prove the read (ADR-0083):
 * qualified by its type or package, through a static import, inherited, through a typed receiver, in a lambda, an
 * annotation's argument or a `case` label. A local or a parameter of the name hides it, and a read the sources cannot
 * settle is a cut.
 */
const JAVA = "src/main/java/fx";
const STORE = `${JAVA}/store/Store.java`;
const use = (name: string, body: string, imports = "import fx.store.Store;\n\n") => `package fx.use;\n\n${imports}public class ${name} {\n${body}}\n`;
const SOURCES: Record<string, string> = {
  "pom.xml": "<project/>\n",
  [STORE]: "package fx.store;\n\npublic class Store {\n  public static final String CACHE = \"cache\";\n  private static final int LIMIT = 3;\n  public long count;\n\n  public static String helper() {\n    return CACHE;\n  }\n\n  public int own() {\n    return LIMIT;\n  }\n}\n",
  [`${JAVA}/use/Qualified.java`]: use("Qualified", "  public String read() {\n    return Store.CACHE;\n  }\n"),
  [`${JAVA}/use/Packaged.java`]: use("Packaged", "  public String read() {\n    return fx.store.Store.CACHE;\n  }\n", ""),
  [`${JAVA}/use/Single.java`]: use("Single", "  public String read() {\n    return CACHE;\n  }\n", "import static fx.store.Store.CACHE;\n\n"),
  [`${JAVA}/use/OnDemand.java`]: use("OnDemand", "  public String read() {\n    return CACHE;\n  }\n", "import static fx.store.Store.*;\n\n"),
  [`${JAVA}/use/Inherit.java`]: "package fx.use;\n\nimport fx.store.Store;\n\npublic class Inherit extends Store {\n  public long count() {\n    return count;\n  }\n\n  public String read() {\n    return CACHE;\n  }\n}\n",
  [`${JAVA}/use/Typed.java`]: use("Typed", "  public String read(Store other) {\n    return other.CACHE;\n  }\n"),
  [`${JAVA}/use/Lambda.java`]: use("Lambda", "  public java.util.function.Supplier<String> read() {\n    return () -> Store.CACHE;\n  }\n"),
  [`${JAVA}/use/Annot.java`]: use("Annot", "  @SuppressWarnings(Store.CACHE)\n  public void read() {\n  }\n"),
  [`${JAVA}/use/Case.java`]: use("Case", "  public int read(String s) {\n    switch (s) {\n      case Store.CACHE: return 1;\n      default: return 0;\n    }\n  }\n"),
  [`${JAVA}/use/Shadow.java`]: use("Shadow", "  public String param(String CACHE) {\n    return CACHE;\n  }\n\n  public String local() {\n    String CACHE = \"local\";\n    return CACHE;\n  }\n", "import static fx.store.Store.CACHE;\n\n"),
  [`${JAVA}/use/Init.java`]: use("Init", "  public static final String KEY = Store.CACHE;\n"),
  [`${JAVA}/use/UseInit.java`]: use("UseInit", "  public String read() {\n    return Init.KEY;\n  }\n", ""),
};
const READERS = ["Qualified", "Packaged", "Single", "OnDemand", "Inherit", "Typed", "Lambda", "Annot", "Case"];
const CHANGE = { [STORE]: SOURCES[STORE]!.replace("\"cache\"", "\"store\"") };

const UNSETTLED = `${JAVA}/use/Unsettled.java`;
const INFERRED = `${JAVA}/use/Inferred.java`;
const UNSETTLED_SOURCES: Record<string, string> = {
  "pom.xml": SOURCES["pom.xml"]!,
  [STORE]: SOURCES[STORE]!,
  [UNSETTLED]: "package fx.use;\n\nimport static fx.store.Store.CACHE;\n\npublic class Unsettled extends org.lib.Base {\n  public String read() {\n    return CACHE;\n  }\n}\n",
  [INFERRED]: use("Inferred", "  public String read() {\n    var other = make();\n    return other.CACHE;\n  }\n\n  private static Store make() {\n    return null;\n  }\n"),
};

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
let repo: string;
let unsettled: string;

async function commit(files: Record<string, string>, message: string, at: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(at, path)), { recursive: true });
    await writeFile(join(at, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: at, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: at, env: ENV });
}

async function repository(name: string): Promise<string> {
  const at = join(root, name);
  await mkdir(at);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: at, env: ENV });
  return at;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-constant-reads-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  repo = await repository("java");
  await commit(SOURCES, "fixture", repo);
  await commit(CHANGE, "change", repo);
  unsettled = await repository("unsettled");
  await commit(UNSETTLED_SOURCES, "fixture", unsettled);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

type Answer = { status: string; symbols: string[]; lines: Map<string, readonly number[]>; cuts: readonly { reason: string; at: readonly string[] }[] };

function answerOf(result: Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>): Answer {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  const symbols = value.symbols.map(({ file, symbol }) => `${file}:${symbol}`);
  return { status: result.value.status, symbols: symbols.toSorted(), lines: new Map(value.symbols.map((entry, index) => [symbols[index]!, entry.via?.lines ?? []])), cuts: result.value.status === "partial" ? result.value.cuts : [] };
}

const callers = async (at: string, symbol: string) => answerOf(await composeQueries({ scratchRoot }).impact.callers({ repo: at, repoId: at === repo ? "constant-reads" : "constant-reads-unsettled", revision: "HEAD", targets: [{ file: STORE, symbol }] }));

test("a constant read in other files lists each declaration that reads it, at its line, and no shadowing local or parameter", async () => {
  const answer = await callers(repo, "CACHE");
  assert.equal(answer.status, "complete", JSON.stringify(answer.cuts));
  for (const name of READERS) assert.ok(answer.symbols.includes(`${JAVA}/use/${name}.java:read`), `${name}: ${answer.symbols.join(", ")}`);
  assert.ok(answer.symbols.includes(`${JAVA}/use/Init.java:KEY`), answer.symbols.join(", "));
  assert.ok(!answer.symbols.some((symbol) => symbol.startsWith(`${JAVA}/use/Shadow.java`)), answer.symbols.join(", "));
  assert.ok(!answer.symbols.includes(`${JAVA}/use/Inherit.java:count`), answer.symbols.join(", "));
  assert.deepEqual([answer.lines.get(`${JAVA}/use/Inherit.java:read`), answer.lines.get(`${JAVA}/use/Annot.java:read`), answer.lines.get(`${JAVA}/use/Case.java:read`)], [[11], [6], [8]]);
});

test("a private constant is read only in its own file, and its type still expands only into its subtypes", async () => {
  const answer = await callers(repo, "LIMIT");
  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.symbols.filter((symbol) => !symbol.startsWith(STORE)), [`${JAVA}/use/Inherit.java:Inherit`]);
  assert.ok(answer.symbols.includes(`${STORE}:own`));
});

test("a change to a constant's value reaches its readers and what depends on them", async () => {
  const { symbols } = answerOf(await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "constant-reads", base: "HEAD~1", head: "HEAD" }));
  for (const name of READERS) assert.ok(symbols.includes(`${JAVA}/use/${name}.java:read`), `${name}: ${symbols.join(", ")}`);
  assert.ok(symbols.includes(`${JAVA}/use/UseInit.java:read`), symbols.join(", "));
});

test("a type an annotation's argument names by its simple name is among the type's callers", async () => {
  const answer = await callers(repo, "Store");
  assert.ok(answer.symbols.includes(`${JAVA}/use/Annot.java:Annot`), answer.symbols.join(", "));
});

test("a read the sources cannot settle, behind a supertype outside them or through a receiver whose type they do not state, is a name-only cut, never a dropped or a guessed dependent", async () => {
  const answer = await callers(unsettled, "CACHE");
  assert.equal(answer.status, "partial");
  assert.ok(!answer.symbols.some((symbol) => symbol.startsWith(UNSETTLED) || symbol.startsWith(INFERRED)), answer.symbols.join(", "));
  const places = answer.cuts.filter((cut) => cut.reason === "name-only").flatMap((cut) => cut.at.filter((at) => !at.endsWith(".java")));
  assert.deepEqual(places.toSorted(), [`${INFERRED}:8 CACHE`, `${UNSETTLED}:7 CACHE`]);
});
