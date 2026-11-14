import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * A Java class that reads a field or calls a method a static import brings from a repository type depends on that type,
 * unless a closer declaration of the name hides the import.
 */
const JAVA = "src/main/java/fx";
const STORE = `${JAVA}/store/Store.java`;
const SOURCES: Record<string, string> = {
  "pom.xml": "<project/>\n",
  [STORE]: "package fx.store;\n\npublic class Store {\n  public static final String CACHE = \"cache\";\n\n  public static String helper() {\n    return CACHE;\n  }\n}\n",
  [`${JAVA}/use/StaticImport.java`]: "package fx.use;\n\nimport static fx.store.Store.CACHE;\n\npublic class StaticImport {\n  public String read() {\n    return CACHE;\n  }\n}\n",
  [`${JAVA}/use/OnDemandCall.java`]: "package fx.use;\n\nimport static fx.store.Store.*;\n\npublic class OnDemandCall {\n  public String call() {\n    return helper();\n  }\n}\n",
  [`${JAVA}/use/Shadowed.java`]: "package fx.use;\n\nimport static fx.store.Store.CACHE;\n\npublic class Shadowed {\n  public String read(String CACHE) {\n    return CACHE;\n  }\n}\n",
};
const CHANGE = { [STORE]: SOURCES[STORE]!.replace("public class Store", "public final class Store") };
const USERS = ["StaticImport", "OnDemandCall"].map((name) => `${JAVA}/use/${name}.java:${name}`);

const THREADED = `${JAVA}/use/Threaded.java`;
const UNSETTLED_SOURCES: Record<string, string> = {
  "pom.xml": SOURCES["pom.xml"]!,
  [STORE]: SOURCES[STORE]!,
  [THREADED]: "package fx.use;\n\nimport static fx.store.Store.CACHE;\n\npublic class Threaded extends Thread {\n  public String read() {\n    return CACHE;\n  }\n}\n",
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
  root = await mkdtemp(join(tmpdir(), "ye-ast-static-import-types-"));
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

type Answer = { status: string; symbols: string[]; lines: Map<string, readonly number[]> };

function answerOf(result: Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>): Answer {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  const symbols = value.symbols.map(({ file, symbol }) => `${file}:${symbol}`);
  return { status: result.value.status, symbols: symbols.toSorted(), lines: new Map(value.symbols.map((entry, index) => [symbols[index]!, entry.via?.lines ?? []])) };
}

test("callers of a Java type list the classes that read its field or call its method through a static import, at the line that does, and not one whose parameter hides the import", async () => {
  const queries = composeQueries({ scratchRoot });
  const answer = answerOf(await queries.impact.callers({ repo, repoId: "static-import-java", revision: "HEAD~1", targets: [{ file: STORE, symbol: "Store" }] }));

  assert.equal(answer.status, "complete");
  for (const user of USERS) assert.deepEqual(answer.lines.get(user), [7], JSON.stringify(answer.symbols));
  assert.ok(!answer.symbols.some((symbol) => symbol.includes("Shadowed")), JSON.stringify(answer.symbols));
});

test("the impact of a change to a Java type reaches the classes that use it through a static import", async () => {
  const queries = composeQueries({ scratchRoot });
  const answer = answerOf(await queries.impact.ofChange({ repo, repoId: "static-import-java", base: "HEAD~1", head: "HEAD" }));

  assert.equal(answer.status, "complete");
  for (const user of USERS) assert.ok(answer.symbols.includes(user), JSON.stringify(answer.symbols));
  assert.ok(!answer.symbols.some((symbol) => symbol.includes("Shadowed")), JSON.stringify(answer.symbols));
});

test("callers of a Java type are cut at a statically imported name a field of a supertype outside the sources may hide", async () => {
  const queries = composeQueries({ scratchRoot });
  const result = await queries.impact.callers({ repo: unsettled, repoId: "static-import-java-unsettled", revision: "HEAD", targets: [{ file: STORE, symbol: "Store" }] });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));
  const anchor = `${STORE}::Store`;
  const places = result.value.cuts.filter((cut) => cut.reason === "name-only" && cut.reach.kind === "callers-of" && cut.reach.declarations.includes(anchor)).flatMap((cut) => cut.at.filter((at) => !at.endsWith(".java")));
  assert.deepEqual(places, [`${THREADED}:7 fx.store.Store`]);
  assert.ok(!result.value.value.symbols.some(({ file }) => file === THREADED), JSON.stringify(result.value.value.symbols));
});
