import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * A Java expression that names a repository type by its package-qualified name (a static field read, a static call, a
 * method reference, a nested type's constant) depends on that type, as the same name written where a type stands does.
 */
const JAVA = "src/main/java/fx";
const STORE = `${JAVA}/store/Store.java`;
const SOURCES: Record<string, string> = {
  "pom.xml": "<project/>\n",
  [STORE]: "package fx.store;\n\npublic class Store {\n  public static final String CACHE = \"cache\";\n\n  public static String helper() {\n    return CACHE;\n  }\n\n  public static class Inner {\n    public static final String X = \"x\";\n  }\n}\n",
  [`${JAVA}/use/FieldRead.java`]: "package fx.use;\n\npublic class FieldRead {\n  public String read() {\n    return fx.store.Store.CACHE;\n  }\n}\n",
  [`${JAVA}/use/StaticCall.java`]: "package fx.use;\n\npublic class StaticCall {\n  public String call() {\n    return fx.store.Store.helper();\n  }\n}\n",
  [`${JAVA}/use/MethodReference.java`]: "package fx.use;\n\nimport java.util.function.Supplier;\n\npublic class MethodReference {\n  public Supplier<String> ref() {\n    return fx.store.Store::helper;\n  }\n}\n",
  [`${JAVA}/use/NestedRead.java`]: "package fx.use;\n\npublic class NestedRead {\n  public String read() {\n    return fx.store.Store.Inner.X;\n  }\n}\n",
  [`${JAVA}/use/Holder.java`]: "package fx.use;\n\npublic class Holder {\n  public Holder store;\n  public Holder Store;\n  public String CACHE;\n}\n",
  [`${JAVA}/use/ParameterShadow.java`]: "package fx.use;\n\npublic class ParameterShadow {\n  public String read(Holder fx) {\n    return fx.store.Store.CACHE;\n  }\n}\n",
};
const CHANGE = { [STORE]: SOURCES[STORE]!.replace("public class Store", "public final class Store") };
const READERS = ["FieldRead", "StaticCall", "MethodReference"].map((name) => `${JAVA}/use/${name}.java:${name}`);

const UNSETTLED = `${JAVA}/use/Threaded.java`;
const ON_DEMAND = `${JAVA}/use/OnDemand.java`;
const UNSETTLED_SOURCES: Record<string, string> = {
  "pom.xml": SOURCES["pom.xml"]!,
  [STORE]: SOURCES[STORE]!,
  [UNSETTLED]: "package fx.use;\n\npublic class Threaded extends Thread {\n  public String read() {\n    return fx.store.Store.CACHE;\n  }\n}\n",
  [ON_DEMAND]: "package fx.use;\n\nimport java.util.*;\n\npublic class OnDemand {\n  private fx.store.Store store;\n}\n",
};

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
let repo: string;
let unsettled: string;

async function commit(files: Record<string, string>, message: string, at = repo): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(at, path)), { recursive: true });
    await writeFile(join(at, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: at, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: at, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-qualified-expression-types-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  repo = join(root, "java");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(SOURCES, "fixture");
  await commit(CHANGE, "change");
  unsettled = join(root, "unsettled");
  await mkdir(unsettled);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: unsettled, env: ENV });
  await commit(UNSETTLED_SOURCES, "fixture", unsettled);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

type Answer = { status: string; symbols: string[] };

function answerOf(result: Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>): Answer {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  return { status: result.value.status, symbols: value.symbols.map(({ file, symbol }) => `${file}:${symbol}`).toSorted() };
}

test("callers of a Java type list the expressions that name it by its package-qualified name, and not a variable that obscures the package", async () => {
  const queries = composeQueries({ scratchRoot });
  const store = answerOf(await queries.impact.callers({ repo, repoId: "qualified-java", revision: "HEAD~1", targets: [{ file: STORE, symbol: "Store" }] }));
  const inner = answerOf(await queries.impact.callers({ repo, repoId: "qualified-java", revision: "HEAD~1", targets: [{ file: STORE, symbol: "Inner" }] }));

  assert.equal(store.status, "complete");
  for (const reader of READERS) assert.ok(store.symbols.includes(reader), JSON.stringify(store.symbols));
  assert.ok(!store.symbols.some((symbol) => symbol.includes("ParameterShadow")), JSON.stringify(store.symbols));
  assert.equal(inner.status, "complete");
  assert.ok(inner.symbols.includes(`${JAVA}/use/NestedRead.java:NestedRead`), JSON.stringify(inner.symbols));
});

test("the impact of a change to a Java type reaches the expressions that name it by its package-qualified name", async () => {
  const queries = composeQueries({ scratchRoot });
  const answer = answerOf(await queries.impact.ofChange({ repo, repoId: "qualified-java", base: "HEAD~1", head: "HEAD" }));

  assert.equal(answer.status, "complete");
  assert.ok(answer.symbols.includes(`${JAVA}/use/FieldRead.java:FieldRead`), JSON.stringify(answer.symbols));
  assert.ok(!answer.symbols.some((symbol) => symbol.includes("ParameterShadow")), JSON.stringify(answer.symbols));
});

test("callers of a Java type are cut at a package-qualified expression whose first segment a field of a supertype outside the sources may obscure, as at a type an on-demand import leaves open", async () => {
  const queries = composeQueries({ scratchRoot });
  const result = await queries.impact.callers({ repo: unsettled, repoId: "qualified-java-unsettled", revision: "HEAD", targets: [{ file: STORE, symbol: "Store" }] });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));
  const anchor = `${STORE}::Store`;
  const places = result.value.cuts.filter((cut) => cut.reach.kind === "callers-of" && cut.reach.declarations.includes(anchor)).flatMap((cut) => cut.at.filter((at) => !at.endsWith(".java") && at !== anchor));
  assert.deepEqual(places.toSorted(), [`${ON_DEMAND}:6 fx.store.Store`, `${UNSETTLED}:5 fx.store.Store`]);
  assert.ok(!result.value.value.symbols.some(({ file }) => file === UNSETTLED), JSON.stringify(result.value.value.symbols));
});
