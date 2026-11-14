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
 * A record component declares an implicit private final field of the component's type (JLS 8.10.3), so a call on it
 * inside the record body is selected through that type as a call on a class's private final field is.
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
  for (const [path, content] of Object.entries({ ...POM, ...files })) {
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

const java = (name: string, body: string) => ({ [`${JAVA}/${name}.java`]: `package shop;\n\n${body}\n` });

/** The status, what the root reaches, expanded or as a leaf, and the cut reasons: what a record and a class must answer alike. */
const answer = (fact: { status: string; cuts?: readonly Cut[]; value: TraceValue }) => ({
  status: fact.status,
  reached: fact.value.steps.flatMap((step) => [...(step.depth === 0 ? [] : [`${step.file}:${step.symbol}`]), ...(step.leaves ?? []).map((leaf) => `${leaf.file}:${leaf.symbol}`)]),
  cuts: (fact.cuts ?? []).map((cut) => cut.reason),
});

test("a call on a record component inside the record body is selected through the component's type, as on a class's private final field", async () => {
  commit({
    ...java("Delivery", "public class Delivery {\n  public int fee() {\n    return 1;\n  }\n}"),
    ...java("Order", "public record Order(Delivery delivery) {\n  public int total() {\n    return delivery.fee();\n  }\n}"),
    ...java("Cart", "public class Cart {\n  private final Delivery delivery;\n\n  public Cart(Delivery delivery) {\n    this.delivery = delivery;\n  }\n\n  public int total() {\n    return delivery.fee();\n  }\n}"),
  });

  const record = answer(await trace("Order.java:total"));
  const klass = answer(await trace("Cart.java:total"));

  assert.deepEqual(record, { status: "complete", reached: [`${JAVA}/Delivery.java:fee`], cuts: [] });
  assert.deepEqual(record, klass);
});

test("a method reference on a record component inside the record body is selected through the component's type, as on a class's private final field", async () => {
  const reference = `  public int total() {\n    java.util.function.Supplier<Integer> s = delivery::fee;\n    return s.get();\n  }\n}`;
  commit({
    ...java("Delivery", "public class Delivery {\n  public int fee() {\n    new Helper().go();\n    return 1;\n  }\n}"),
    ...java("Helper", "public class Helper {\n  public void go() {\n    System.out.println(1);\n  }\n}"),
    ...java("Order", `public record Order(Delivery delivery) {\n${reference}`),
    ...java("Cart", `public class Cart {\n  private final Delivery delivery;\n\n  public Cart(Delivery delivery) {\n    this.delivery = delivery;\n  }\n\n${reference}`),
  });

  const record = answer(await trace("Order.java:total"));

  assert.deepEqual(record.reached, [`${JAVA}/Delivery.java:fee`]);
  assert.deepEqual(record, answer(await trace("Cart.java:total")));
});
