import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import { composeCli } from "./compose.ts";

/**
 * A reference the index spells as a bare name is settled by the base binding like a qualified one (ADR-0088):
 * a call on `super` whose superclass lies outside the repository runs no repository method (ADR-0087 decision 5), so it
 * is no hidden caller of the class's own override and no name-only caller of a homonym in another class. A call without
 * a receiver keeps the dispatch it may make.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/Task.java`]: [
    "package com.acme;",
    "",
    "public class Task extends com.lib.Outside {",
    "    @Override",
    "    public void step(int a) {",
    "        System.out.println(\"task\");",
    "        super.step(a);",
    "    }",
    "",
    "    void own() {",
    "        step(1);",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Forms.java`]: ["package com.acme;", "", "public class Forms extends com.lib.Base {", "    void bRun() {", "        System.out.println(\"forms\");", "    }", "}"].join("\n"),
  [`${JAVA}/Maker.java`]: [
    "package com.acme;",
    "",
    "public class Maker {",
    "    Object make() {",
    "        return new com.lib.Base() {",
    "            void bRun() {",
    "                super.bRun();",
    "            }",
    "        };",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Upper.java`]: ["package com.acme;", "", "public class Upper extends com.lib.Outside {", "    void n() {", "        run(1);", "    }", "}"].join("\n"),
  [`${JAVA}/Lower.java`]: ["package com.acme;", "", "public class Lower extends Upper {", "    public void run(int a) {", "        System.out.println(\"lower\");", "    }", "}"].join("\n"),
};

let workspace: string;
let repo: string;
let base: string;

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-settled-bare-"));
  mkdirSync(join(workspace, "scratch"));
  repo = join(workspace, "repo");
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  base = git(["rev-parse", "HEAD"]);
  const task = join(repo, JAVA, "Task.java");
  writeFileSync(task, readFileSync(task, "utf8").replace("\"task\"", "\"changed\""));
  git(["commit", "-q", "-am", "change"]);
});

after(() => rmSync(workspace, { recursive: true, force: true }));

interface Answer {
  status: string;
  cuts?: readonly Cut[];
  value: { symbols: readonly { symbol: string; via?: { basis: string } }[] };
}

async function run(args: readonly string[]): Promise<{ status: string; callers: readonly string[]; cuts: readonly string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(args, { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  const fact = JSON.parse(stdout.join("\n")) as Answer;
  return {
    status: fact.status,
    callers: fact.value.symbols.filter(({ via }) => via !== undefined && via.basis !== "contains").map(({ symbol }) => symbol).sort(),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at.join(" ")}`),
  };
}

test("impact of an override leaves no hidden caller at its own call on an outside super, and keeps the call without a receiver", async () => {
  assert.deepEqual(await run(["impact", repo, "--base", base]), { status: "complete", callers: ["own"], cuts: [] });
});

test("callers of a method leave no name-only cut at a homonym's call on an outside super in an anonymous class", async () => {
  assert.deepEqual(await run(["callers", repo, `${JAVA}/Forms.java:bRun`]), { status: "complete", callers: [], cuts: [] });
});

test("callers of a subclass's method keep the cut of a call without a receiver that may dispatch to it, as a hidden caller of that method", async () => {
  assert.deepEqual(await run(["callers", repo, `${JAVA}/Lower.java:run`]), { status: "partial", callers: [], cuts: [`hidden-caller ${JAVA}/Lower.java::run ${JAVA}/Upper.java:5 run`] });
});
