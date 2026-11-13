import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";

/**
 * `Controller` implements `CustomersApi`, an interface the snapshot does not hold, and names the repository's
 * `Customer` through its import. With `pom.xml` declaring a source generator the interface is a generated one; without
 * it the interface may declare a member type `Customer`. The second commit changes `Customer`, so `impact` walks from it
 * as `callers` of `Customer` does.
 */
const CUSTOMER = "src/main/java/app/repo/Customer.java";
const CONTROLLER = "src/main/java/app/web/Controller.java";
const GENERATOR_POM = "<project>\n  <build>\n    <plugins>\n      <plugin>\n        <groupId>org.openapitools</groupId>\n        <artifactId>openapi-generator-maven-plugin</artifactId>\n      </plugin>\n    </plugins>\n  </build>\n</project>\n";
const SOURCES: Record<string, string> = {
  [CUSTOMER]: "package app.repo;\n\npublic class Customer {}\n",
  [CONTROLLER]: ["package app.web;", "", "import app.api.CustomersApi;", "import app.repo.Customer;", "", "public class Controller implements CustomersApi {", "  Customer customer;", "}", ""].join("\n"),
};
const CHANGED = { [CUSTOMER]: "package app.repo;\n\npublic class Customer {\n  int id;\n}\n" };

let root: string;
let scratchRoot: string;
const repos: Record<"generated" | "undeclared", string> = { generated: "", undeclared: "" };

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

async function commit(repo: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-generated-supertype-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  for (const kind of ["generated", "undeclared"] as const) {
    const repo = join(root, kind);
    repos[kind] = repo;
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
    await commit(repo, kind === "generated" ? { ...SOURCES, "pom.xml": GENERATOR_POM } : SOURCES, "fixture");
    await commit(repo, CHANGED, "change");
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** `callers` of `Customer` and the impact of its change, each as its dependents and its cuts. */
async function answersOf(kind: keyof typeof repos): Promise<{ files: string[]; cuts: readonly Cut[] }[]> {
  const queries = composeQueries({ scratchRoot });
  const callers = await queries.impact.callers({ repo: repos[kind], repoId: `generated-supertype-${kind}`, revision: "HEAD", targets: [{ file: CUSTOMER, symbol: "Customer" }] });
  const impact = await queries.impact.ofChange({ repo: repos[kind], repoId: `generated-supertype-${kind}`, base: "HEAD~1", head: "HEAD" });
  return [callers, impact].map((result) => {
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
    const value: ImpactValue = result.value.value;
    return { files: [...new Set(value.symbols.map(({ file }) => file))].filter((file) => file !== CUSTOMER).toSorted(), cuts: result.value.status === "partial" ? result.value.cuts : [] };
  });
}

const nameOnlyAt = (cuts: readonly Cut[], file: string): boolean => cuts.some((cut) => cut.reason === "name-only" && cut.at.some((at) => at.startsWith(file)));

test("a type a class under a generated supertype names by import is a placed dependent of callers and impact, with no name-only cut", async () => {
  for (const { files, cuts } of await answersOf("generated")) {
    assert.deepEqual(files, [CONTROLLER]);
    assert.equal(nameOnlyAt(cuts, CONTROLLER), false, JSON.stringify(cuts));
  }
});

test("without a declared generator, the same class keeps its name-only cut in callers and impact", async () => {
  for (const { cuts } of await answersOf("undeclared")) assert.equal(nameOnlyAt(cuts, CONTROLLER), true, JSON.stringify(cuts));
});
