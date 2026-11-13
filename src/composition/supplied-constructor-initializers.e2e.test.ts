import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import { composeCli } from "./compose.ts";

/**
 * Constructing a class runs more than a constructor's written body: its field initializers and initializer blocks, and
 * the superclass constructor an explicit or implicit `super()` chains to. Where the language supplies the constructor,
 * the class itself is the step, walked as that construction; what the walk cannot settle is a cut, never left out.
 */

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const JAVA = "src/main/java/shop";
const POM = { "pom.xml": "<project><groupId>shop</groupId><artifactId>shop</artifactId></project>\n" };
const HELPER = { [`${JAVA}/Helper.java`]: "package shop;\n\npublic class Helper {\n  public int make() {\n    return 1;\n  }\n}\n" };

let workspace: string;
let repo: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop");
  mkdirSync(repo);
  mkdirSync(join(workspace, "scratch"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function commit(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries({ ...POM, ...HELPER, ...files })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

async function trace(target: string): Promise<{ status: string; cuts?: readonly Cut[]; value: TraceValue }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, `${JAVA}/${target}`], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const cutsOf = (fact: { cuts?: readonly Cut[] }) => (fact.cuts ?? []).map((cut) => [cut.reason, cut.at[0]]);

/** Every declaration a trace reaches, expanded or as a leaf, by file and name. */
const reached = (fact: { value: TraceValue }) => fact.value.steps.flatMap((step) => [`${step.file}:${step.symbol}`, ...(step.leaves ?? []).map((leaf) => `${leaf.file}:${leaf.symbol}`)]);

const java = (name: string, body: string) => ({ [`${JAVA}/${name}.java`]: `package shop;\n\n${body}\n` });
const use = (body: string) => java("Use", `import java.util.function.Supplier;\n\npublic class Use {\n  public Object run() {\n${body}\n  }\n}`);
const BASE = java("Base", "public class Base {\n  int n = new Helper().make();\n}");

const CHECK = java("Check", "public class Check {\n  public static int count() {\n    return 1;\n  }\n}");
const COUNT = `${JAVA}/Check.java:count`;

test("a super() call to a class that writes no constructor walks that class's field initializers, so what it cannot settle is a cut", async () => {
  commit({ ...BASE, ...java("Sub", "public class Sub extends Base {\n  public Sub() {\n    super();\n  }\n}"), ...use("    return new Sub();") });

  const fact = await trace("Use.java:Use.run");

  assert.deepEqual(fact.value.steps.filter((step) => step.symbol === "Base" || step.symbol === "n").map((step) => [step.symbol, step.kind, step.via]), [["Base", "class", "call"], ["n", "field", "member"]]);
  assert.deepEqual(cutsOf(fact), [["receiver-unproven", `${JAVA}/Base.java:4 new Helper().make`]]);
  assert.ok(fact.cuts?.[0]?.at.includes(`${JAVA}/Helper.java::shop.Helper.make`));
});

test("new T() and T::new of a class that writes no constructor walk its field initializers and initializer blocks, once, in the same order every run", async () => {
  commit({
    ...CHECK,
    ...java("Holder", "public class Holder {\n  private final int n = Check.count();\n}"),
    ...java("Gate", "public class Gate {\n  {\n    Check.count();\n  }\n}"),
    ...use("    Supplier<Holder> later = Holder::new;\n    new Gate();\n    return new Holder();"),
  });

  const fact = await trace("Use.java:Use.run");

  assert.deepEqual([fact.status, cutsOf(fact)], ["complete", []]);
  assert.deepEqual(fact.value.steps.filter((step) => step.kind === "class").map((step) => [step.symbol, step.via, step.deferred ?? false, step.leaves?.map((leaf) => `${leaf.file}:${leaf.symbol}`) ?? []]), [
    ["Holder", "reference", true, []],
    ["Gate", "call", false, [COUNT]],
    ["Holder", "call", false, []],
  ]);
  assert.ok(fact.value.steps.some((step) => step.symbol === "n" && step.leaves?.some((leaf) => `${leaf.file}:${leaf.symbol}` === COUNT)));
  assert.deepEqual(await trace("Use.java:Use.run"), fact);
});

for (const [above, files] of [
  ["initializes a field and writes no constructor", java("Base", "public class Base {\n  int n = Check.count();\n}")],
  ["writes a constructor of no arguments", java("Base", "public class Base {\n  public Base() {\n    Check.count();\n  }\n}")],
] as const) {
  test(`a written constructor without super() runs what the implicit super() reaches when the superclass ${above}`, async () => {
    commit({ ...CHECK, ...files, ...java("Sub", "public class Sub extends Base {\n  public Sub() {\n    int a = 1;\n  }\n}"), ...use("    return new Sub();") });

    const fact = await trace("Use.java:Use.run");

    assert.deepEqual([fact.status, cutsOf(fact)], ["complete", []]);
    assert.ok(reached(fact).includes(COUNT));
  });
}

test("a written constructor runs its class's instance initializer block", async () => {
  commit({ ...CHECK, ...java("Blk", "public class Blk {\n  {\n    Check.count();\n  }\n\n  public Blk() {\n    int a = 1;\n  }\n}"), ...use("    return new Blk();") });

  const fact = await trace("Use.java:Use.run");

  assert.deepEqual([fact.status, cutsOf(fact)], ["complete", []]);
  assert.deepEqual(fact.value.steps.find((step) => step.symbol === "Blk")?.leaves?.map((leaf) => `${leaf.file}:${leaf.symbol}`), [COUNT]);
});

for (const [above, files] of [
  ["writes a varargs constructor beside one of no arguments", java("Base", "public class Base {\n  public Base() {\n    Check.count();\n  }\n\n  public Base(String... names) {\n  }\n}")],
  ["writes constructors and none of no arguments", java("Base", "public class Base {\n  public Base(long id) {\n    Check.count();\n  }\n}")],
  ["holds an annotation by which a processor may add constructors", java("Base", "import lombok.NoArgsConstructor;\n\n@NoArgsConstructor\npublic class Base {\n  int n = Check.count();\n}")],
] as const) {
  test(`an implicit super() to a superclass that ${above} is a cut at the constructed class`, async () => {
    commit({ ...CHECK, ...files, ...java("Sub", "public class Sub extends Base {\n}"), ...use("    return new Sub();") });

    const fact = await trace("Use.java:Use.run");

    assert.equal(fact.status, "partial");
    assert.deepEqual(fact.cuts?.map((cut) => [cut.reason, cut.at]), [["constructor-unsettled", [`${JAVA}/Sub.java:3 Sub`]]]);
  });
}

test("a cycle of classes that write no constructor is walked once each and ends, and one that runs no code is no step", async () => {
  commit({
    ...CHECK,
    ...java("A", "public class A extends B {\n}"),
    ...java("B", "public class B extends A {\n  int n = Check.count();\n}"),
    ...java("C", "public class C extends D {\n}"),
    ...java("D", "public class D extends C {\n}"),
    ...use("    new C();\n    return new A();"),
  });

  const fact = await trace("Use.java:Use.run");

  assert.ok(reached(fact).includes(COUNT));
  assert.deepEqual(fact.value.steps.filter((step) => step.kind === "class").map((step) => [step.symbol, step.depth]), [["A", 1], ["B", 2], ["A", 3]]);
});

test("a constructor's construction never runs a decorator written before its class", async () => {
  commit({ "src/app/deco.ts": "function mark(): (type: unknown) => void {\n  return () => undefined;\n}\n\n@mark()\nexport class Deco {\n  constructor() {}\n}\n" });
  const stdout: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, "src/app/deco.ts:Deco.constructor"], { out: (line) => stdout.push(line), err: () => undefined });
  assert.equal(code, EXIT_CODE.ok);
  const fact: { status: string; value: TraceValue } = JSON.parse(stdout.join("\n"));

  assert.deepEqual([fact.status, reached(fact)], ["complete", ["src/app/deco.ts:constructor"]]);
});

for (const [shape, files, classes] of [
  ["a construction by qualified name", java("Use", "public class Use {\n  public Object run() {\n    return new shop.b.Item();\n  }\n}"), [`${JAVA}/b/Item.java:Item`]],
  ["a construction by import", java("Use", "import shop.b.Item;\n\npublic class Use {\n  public Object run() {\n    return new Item();\n  }\n}"), [`${JAVA}/b/Item.java:Item`]],
  ["a method reference by import", java("Use", "import java.util.function.Supplier;\nimport shop.b.Item;\n\npublic class Use {\n  public Object run() {\n    Supplier<Item> later = Item::new;\n    return later;\n  }\n}"), [`${JAVA}/b/Item.java:Item`]],
  ["an implicit super()", { ...java("Sub", "public class Sub extends shop.b.Item {\n}"), ...use("    return new Sub();") }, [`${JAVA}/Sub.java:Sub`, `${JAVA}/b/Item.java:Item`]],
] as const) {
  test(`${shape} of a class whose simple name another package declares walks that class down to its superclass's constructor of no arguments`, async () => {
    commit({
      ...CHECK,
      ...java("Base", "public class Base {\n  public Base() {\n    Check.count();\n  }\n\n  public Base(long id) {\n  }\n}"),
      [`${JAVA}/a/Item.java`]: "package shop.a;\n\nimport shop.Check;\n\npublic class Item {\n  int n = Check.count();\n}\n",
      [`${JAVA}/b/Item.java`]: "package shop.b;\n\nimport shop.Base;\n\npublic class Item extends Base {\n}\n",
      ...files,
    });

    const fact = await trace("Use.java:Use.run");

    assert.deepEqual([fact.status, cutsOf(fact)], ["complete", []]);
    assert.deepEqual(fact.value.steps.filter((step) => step.kind === "class" && step.symbol !== "Use").map((step) => `${step.file}:${step.symbol}`), classes);
    assert.deepEqual(fact.value.steps.filter((step) => step.symbol === "Base").map((step) => [step.kind, step.line]), [["method", 4]]);
    assert.ok(!reached(fact).some((declaration) => declaration.startsWith(`${JAVA}/a/`)));
  });
}

test("the reading plan of a class walked as its construction holds only the lines that construction runs", async () => {
  commit({ ...CHECK, ...java("Gate", "public class Gate {\n  int n = Check.count();\n\n  {\n    Check.count();\n  }\n\n  public int unused() {\n    return 2;\n  }\n}"), ...use("    return new Gate();") });

  const fact = await trace("Use.java:Use.run");
  const gate = fact.value.steps.find((step) => step.symbol === "Gate")!;

  assert.deepEqual([gate.kind, gate.line, gate.endLine], ["class", 3, 13]);
  assert.deepEqual(fact.value.readingPlan.ranges.filter((range) => range.file === `${JAVA}/Gate.java`).map((range) => [range.start, range.end]), [[4, 4], [7, 7]]);
});
