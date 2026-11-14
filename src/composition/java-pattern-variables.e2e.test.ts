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
 * A Java variable a pattern, a resource, an enhanced `for`, a typed lambda parameter or a `catch` declares is the typed
 * local it is, within the scope the language gives it (JLS 6.3, 6.3.1): it hides a field of its name there, and a call on
 * it runs the method of the type it writes. Where the reading cannot settle the scope or the type (`var`, a multi-catch,
 * a pattern variable after a statement whose completion it does not decide), the call is unproven.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/p";
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>p</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/Store.java`]: [
    "package p;",
    "public class Store implements AutoCloseable {",
    "    void save() { System.out.println(\"store\"); }",
    "    boolean ready() { System.out.println(\"ready\"); return true; }",
    "    public void close() { System.out.println(\"close\"); }",
    "}",
  ].join("\n"),
  [`${JAVA}/Other.java`]: [
    "package p;",
    "public class Other {",
    "    void save() { System.out.println(\"other\"); }",
    "    boolean ready() { System.out.println(\"other ready\"); return true; }",
    "}",
  ].join("\n"),
  [`${JAVA}/Box.java`]: [
    "package p;",
    "public record Box(Store content) {",
    "}",
  ].join("\n"),
  [`${JAVA}/Wrap.java`]: [
    "package p;",
    "public record Wrap(Box box) {",
    "}",
  ].join("\n"),
  [`${JAVA}/Failure.java`]: [
    "package p;",
    "public class Failure extends RuntimeException {",
    "    void save() { System.out.println(\"failure\"); }",
    "}",
  ].join("\n"),
  [`${JAVA}/Lapse.java`]: [
    "package p;",
    "public class Lapse extends RuntimeException {",
    "    void save() { System.out.println(\"lapse\"); }",
    "}",
  ].join("\n"),
  [`${JAVA}/Use.java`]: [
    "package p;",
    "",
    "import java.util.List;",
    "import java.util.function.Consumer;",
    "",
    "public class Use {",
    "    private Other item;",
    "",
    "    void switchRule(Object o) {",
    "        switch (o) {",
    "            case Store item -> item.save();",
    "            default -> System.out.println(\"none\");",
    "        }",
    "    }",
    "",
    "    void switchGroup(Object o) {",
    "        switch (o) {",
    "            case Store item:",
    "                item.save();",
    "                break;",
    "            default:",
    "                System.out.println(\"none\");",
    "        }",
    "    }",
    "",
    "    void switchGuard(Object o) {",
    "        switch (o) {",
    "            case Store item when item.ready() -> item.save();",
    "            default -> System.out.println(\"none\");",
    "        }",
    "    }",
    "",
    "    void switchRecord(Object o) {",
    "        switch (o) {",
    "            case Box(Store item) -> item.save();",
    "            default -> System.out.println(\"none\");",
    "        }",
    "    }",
    "",
    "    void instanceofNestedRecord(Object o) {",
    "        if (o instanceof Wrap(Box(Store item))) {",
    "            item.save();",
    "        }",
    "    }",
    "",
    "    void instanceofPlain(Object o) {",
    "        if (o instanceof Store item) {",
    "            item.save();",
    "        }",
    "    }",
    "",
    "    void instanceofNegated(Object o) {",
    "        if (!(o instanceof Store item)) return;",
    "        item.save();",
    "    }",
    "",
    "    void instanceofAnd(Object o) {",
    "        if (o instanceof Store item && item.ready()) {",
    "            System.out.println(\"and\");",
    "        }",
    "    }",
    "",
    "    void instanceofUndecided(Object o) {",
    "        if (!(o instanceof Store item)) {",
    "            for (;;) {",
    "                System.out.println(\"spin\");",
    "            }",
    "        }",
    "        item.save();",
    "    }",
    "",
    "    void resource() throws Exception {",
    "        try (Store item = new Store()) {",
    "            item.save();",
    "        }",
    "    }",
    "",
    "    void existingResource(Store item) throws Exception {",
    "        try (item) {",
    "            item.save();",
    "        }",
    "    }",
    "",
    "    void enhancedFor(List<Store> stores) {",
    "        for (Store item : stores) {",
    "            item.save();",
    "        }",
    "    }",
    "",
    "    void typedLambda() {",
    "        Consumer<Store> run = (Store item) -> item.save();",
    "        run.accept(new Store());",
    "    }",
    "",
    "    void catchSingle() {",
    "        try {",
    "            System.out.println(\"try\");",
    "        } catch (Failure item) {",
    "            item.save();",
    "        }",
    "    }",
    "",
    "    void catchMulti() {",
    "        try {",
    "            System.out.println(\"try\");",
    "        } catch (Failure | Lapse item) {",
    "            item.save();",
    "        }",
    "    }",
    "",
    "    void inferred() {",
    "        var item = new Store();",
    "        item.save();",
    "    }",
    "",
    "    void afterInstanceof(Object o) {",
    "        if (o instanceof Store item) {",
    "            item.save();",
    "        }",
    "        item.save();",
    "    }",
    "",
    "    void afterSwitch(Object o) {",
    "        switch (o) {",
    "            case Store item -> item.save();",
    "            default -> System.out.println(\"none\");",
    "        }",
    "        item.save();",
    "    }",
    "",
    "    void plainField() {",
    "        item.save();",
    "    }",
    "",
    "    void plainLocal() {",
    "        Store local = new Store();",
    "        local.save();",
    "    }",
    "",
    "    void plainParameter(Store parameter) {",
    "        parameter.save();",
    "    }",
    "}",
  ].join("\n"),
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-pattern-variables-"));
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

interface Answer {
  status: string;
  cuts?: readonly Cut[];
  value: unknown;
}

async function run(args: readonly string[]): Promise<Answer> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(args, { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

/** The steps below the root, as `file:symbol@line`, and each cut as its reason and the place it starts at. */
async function trace(method: string): Promise<{ steps: readonly string[]; cuts: readonly string[] }> {
  const fact = await run(["trace", repo, `${JAVA}/Use.java:${method}`]);
  const { steps } = fact.value as { steps: readonly { file: string; symbol: string; at?: { line: number } }[] };
  return {
    steps: steps.filter(({ at }) => at !== undefined).map(({ file, symbol, at }) => `${file.split("/").at(-1)}:${symbol}@${at!.line}`),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at[0]}`),
  };
}

/** The status, the methods that call the target, and the places the cuts start at. */
async function callers(target: string): Promise<{ status: string; callers: readonly string[]; cuts: readonly string[] }> {
  const fact = await run(["callers", repo, `${JAVA}/${target}`]);
  const { symbols } = fact.value as { symbols: readonly { symbol: string; kind: string; via?: { basis: string } }[] };
  return { status: fact.status, callers: symbols.filter(({ kind, via }) => kind === "method" && via?.basis === "call").map(({ symbol }) => symbol).sort(), cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at[0]}`) };
}

test("a switch pattern variable hides the field of its name: its call is a caller of the type it writes, never of the field's", async () => {
  const store = await callers("Store.java:save");
  const other = await callers("Other.java:save");

  assert.equal(store.status, "complete", JSON.stringify(store.cuts));
  for (const method of ["switchRule", "switchGroup", "switchGuard", "switchRecord"]) assert.ok(store.callers.includes(method), `${method} in ${JSON.stringify(store.callers)}`);
  assert.deepEqual(other, { status: "complete", callers: ["afterInstanceof", "afterSwitch", "plainField"], cuts: [] });
});

test("a call on a variable a pattern, a resource, an enhanced for, a typed lambda parameter or a one-type catch declares steps into the method of the type it writes", async () => {
  const expected: Readonly<Record<string, readonly string[]>> = {
    switchRule: ["Store.java:save@11"],
    switchGroup: ["Store.java:save@19"],
    switchGuard: ["Store.java:ready@28", "Store.java:save@28"],
    switchRecord: ["Store.java:save@35"],
    instanceofNestedRecord: ["Store.java:save@42"],
    instanceofPlain: ["Store.java:save@48"],
    instanceofNegated: ["Store.java:save@54"],
    instanceofAnd: ["Store.java:ready@58"],
    resource: ["Store.java:save@74"],
    existingResource: ["Store.java:save@80"],
    enhancedFor: ["Store.java:save@86"],
    catchSingle: ["Failure.java:save@99"],
  };
  for (const [method, steps] of Object.entries(expected)) assert.deepEqual(await trace(method), { steps, cuts: [] }, method);
  assert.deepEqual((await trace("typedLambda")).steps, ["Store.java:save@91"]);
});

test("a name read after the scope of the pattern variable ends is the field again", async () => {
  assert.deepEqual(await trace("afterInstanceof"), { steps: ["Store.java:save@118", "Other.java:save@120"], cuts: [] });
  assert.deepEqual(await trace("afterSwitch"), { steps: ["Store.java:save@125", "Other.java:save@128"], cuts: [] });
});

test("a var, a multi-catch variable and a pattern variable after a statement whose completion the reading does not decide bind no guessed type", async () => {
  for (const [method, line] of [["inferred", 113], ["catchMulti", 107], ["instanceofUndecided", 69]] as const) {
    assert.deepEqual(await trace(method), { steps: [], cuts: [`receiver-unproven ${JAVA}/Use.java:${line} save`] }, method);
  }
});
