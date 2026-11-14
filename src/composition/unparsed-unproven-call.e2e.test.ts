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
 * A repository with a source the reader does not parse proves no call (ADR-0089 "Not decided here"): an index-resolved
 * call edge keeps today's verdict, followed with no cut of its own.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const USE = `${JAVA}/Use.java`;
const CALL = `${JAVA}/Call.java`;
const java = (name: string, ...body: string[]): string => ["package com.acme;", "", ...body.map((line) => line.replace("$", name))].join("\n");
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/Store.java`]: java("Store", "public class $ {", "    void save() {", "        System.out.println(\"store\");", "    }", "}"),
  [`${JAVA}/Other.java`]: java("Other", "public class $ {", "    void save() {", "        System.out.println(\"other\");", "    }", "}"),
  [`${JAVA}/Wide.java`]: java("Wide", "public class $ {", "    void save(int a, int b) {", "        System.out.println(\"wide\");", "    }", "}"),
  [USE]: java(
    "Use",
    "import java.util.List;",
    "",
    "public class $ {",
    "    Other item;",
    "",
    "    void byLambda(List<Store> l) {",
    "        l.forEach(item -> item.save());",
    "    }",
    "",
    "    void byVar(List<Store> l) {",
    "        for (var item : l) {",
    "            item.save();",
    "        }",
    "    }",
    "}",
  ),
  [`${JAVA}/Known.java`]: java("Known", "public class $ {", "    void direct(Store s) {", "        s.save();", "    }", "}"),
  [`${JAVA}/Base.java`]: java("Base", "public class $ {", "    void take(Integer a) {", "        System.out.println(\"integer\");", "    }", "}"),
  [`${JAVA}/Pick.java`]: java("Pick", "public class $ extends Base {", "    void take(String a) {", "        System.out.println(\"string\");", "    }", "}"),
  [CALL]: java(
    "Call",
    "public class $ {",
    "    Pick field;",
    "",
    "    void byParameter(Pick p) {",
    "        p.take(System.getenv(\"x\"));",
    "    }",
    "",
    "    void byField() {",
    "        field.take(System.getenv(\"x\"));",
    "    }",
    "}",
  ),
  [`${JAVA}/Broken.java`]: java("Broken", "public class $ {", "    void x( {", "}"),
  "src/web/store.ts": "export class Store {\n  save(): void {\n    console.log(\"store\");\n  }\n}",
  "src/web/other.ts": "export class Other {\n  save(): void {\n    console.log(\"other\");\n  }\n}",
  "src/web/use.ts": "import { Other } from \"./other\";\n\nexport function run(items: readonly unknown[], other: Other): void {\n  items.forEach((item: any) => item.save());\n  other.save();\n}",
  "package.json": "{\"name\":\"fx\",\"private\":true}",
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-unparsed-unproven-"));
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

/** The status, the declarations reached through anything but containment, and every cut as its reason and its places. */
async function callers(target: string): Promise<{ status: string; callers: readonly string[]; cuts: readonly string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["callers", repo, target], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  const fact = JSON.parse(stdout.join("\n")) as { status: string; cuts?: readonly Cut[]; value: { symbols: readonly { symbol: string; via?: { basis: string } }[] } };
  return {
    status: fact.status,
    callers: fact.value.symbols.filter(({ via }) => via !== undefined && via.basis !== "contains").map(({ symbol }) => symbol).sort(),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at.join(" | ")}`),
  };
}

test("a call a lambda parameter makes in a repository whose reading proves nothing cuts nothing beyond the unread source", async () => {
  const fact = await callers(`${JAVA}/Store.java:save`);

  assert.deepEqual(fact, { status: "partial", callers: ["direct"], cuts: [`relation-unread ${JAVA}/Broken.java:4 source-unreadable`] });
});
