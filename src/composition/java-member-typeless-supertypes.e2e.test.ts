import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import { composeCli } from "./compose.ts";

/**
 * A simple type name written below a supertype outside the repository could be a member type that supertype declares
 * (JLS 6.4.1, 8.5), so the strict reading leaves it unsettled. A platform type known to declare no member type
 * (`java.lang.Comparable`, `java.util.Comparator`) cannot, whether a class or an anonymous class implements it: a call on
 * a variable declared with an imported repository type below it steps into that type's method. Any other supertype outside
 * the repository keeps the name, and the call, unproven.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/p";
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>p</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/model/Item.java`]: [
    "package p.model;",
    "",
    "public class Item {",
    "    public boolean isMain() {",
    "        System.out.println(\"main\");",
    "        return true;",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/model/Tool.java`]: [
    "package p.model;",
    "",
    "public class Tool {",
    "    public static void make(String name) {",
    "        System.out.println(\"make\");",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Ranked.java`]: [
    "package p;",
    "",
    "import p.model.Tool;",
    "",
    "public class Ranked implements Comparable<Ranked> {",
    "    public int compareTo(Ranked other) {",
    "        return 0;",
    "    }",
    "",
    "    void build() {",
    "        Tool.make(\"x\");",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Entity.java`]: [
    "package p;",
    "",
    "public abstract class Entity<E> implements Comparable<E> {",
    "}",
  ].join("\n"),
  [`${JAVA}/Product.java`]: [
    "package p;",
    "",
    "import p.model.Item;",
    "",
    "public class Product extends Entity<Product> {",
    "    public int compareTo(Product other) {",
    "        return 0;",
    "    }",
    "",
    "    boolean pick(Item item) {",
    "        return item.isMain();",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Sorter.java`]: [
    "package p;",
    "",
    "import java.util.Comparator;",
    "import java.util.List;",
    "import org.example.Visitor;",
    "import p.model.Item;",
    "",
    "public class Sorter {",
    "    void sort(List<Item> items) {",
    "        items.sort(new Comparator<Item>() {",
    "            public int compare(Item left, Item right) {",
    "                return left.isMain() ? 1 : 0;",
    "            }",
    "        });",
    "    }",
    "",
    "    void visit(List<Item> items) {",
    "        items.forEach(new Visitor<Item>() {",
    "            public void accept(Item item) {",
    "                item.isMain();",
    "            }",
    "        });",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Handler.java`]: [
    "package p;",
    "",
    "import org.example.Base;",
    "import p.model.Item;",
    "",
    "public class Handler extends Base {",
    "    boolean pick(Item item) {",
    "        return item.isMain();",
    "    }",
    "}",
  ].join("\n"),
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-member-typeless-"));
  mkdirSync(join(workspace, "scratch"));
  repo = join(workspace, "repo");
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
});

after(() => rmSync(workspace, { recursive: true, force: true }));

/** The steps below the root, as `file:symbol@line`, and each cut as its reason and the place it starts at. */
async function trace(target: string): Promise<{ steps: readonly string[]; cuts: readonly string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, `${JAVA}/${target}`], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  const fact = JSON.parse(stdout.join("\n")) as { cuts?: readonly Cut[]; value: { steps: readonly { file: string; symbol: string; at?: { line: number } }[] } };
  return {
    steps: fact.value.steps.filter(({ at }) => at !== undefined).map(({ file, symbol, at }) => `${file.split("/").at(-1)}:${symbol}@${at!.line}`),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at[0]}`),
  };
}

test("an imported type below a class that inherits java.lang.Comparable is the type its import names", async () => {
  assert.deepEqual(await trace("Product.java:pick"), { steps: ["Item.java:isMain@11"], cuts: [] });
  assert.deepEqual(await trace("Ranked.java:build"), { steps: ["Tool.java:make@11"], cuts: [] });
});

test("an imported type inside an anonymous java.util.Comparator is the type its import names", async () => {
  assert.deepEqual(await trace("Sorter.java:compare"), { steps: ["Item.java:isMain@12"], cuts: [] });
});

test("below a supertype outside the repository that the platform does not describe, the call stays unproven", async () => {
  assert.deepEqual(await trace("Handler.java:pick"), { steps: [], cuts: [`receiver-unproven ${JAVA}/Handler.java:8 isMain`] });
  assert.deepEqual(await trace("Sorter.java:accept"), { steps: [], cuts: [`receiver-unproven ${JAVA}/Sorter.java:20 isMain`] });
});
