import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { FUNCTION_SPEC, OBJECT_SPEC, TEMURIN_RELEASE, writeJdkHome } from "../core/adapters/jdk/jdk-home.testing.ts";
import { composeCli } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const TARGET = "src/main/java/shop/Check.java:run";
const SOURCES = {
  "src/main/java/shop/Pricing.java": "package shop;\n\npublic class Pricing {\n  public int total(int a, int b) {\n    return a + b;\n  }\n}\n",
  "src/main/java/shop/Check.java": "package shop;\n\npublic class Check {\n  private final Pricing pricing = new Pricing();\n\n  public boolean run() {\n    return pricing.total(1, 2) == 3;\n  }\n}\n",
};

let workspace: string;
let repo: string;
let homes = 0;

const homeDirectory = mkdtempSync(join(tmpdir(), "ye-ast-declared-jdk-"));
after(() => rmSync(homeDirectory, { recursive: true, force: true }));

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop");
  mkdirSync(repo);
  mkdirSync(join(workspace, "scratch"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function commit(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries({ ...SOURCES, ...files })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

async function jdkHome(release = TEMURIN_RELEASE): Promise<string> {
  homes += 1;
  return writeJdkHome(join(homeDirectory, `home-${homes}`), { release, signatures: [{ set: "OP", spec: OBJECT_SPEC }, { set: "OP", spec: FUNCTION_SPEC }] });
}

async function cli(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(argv, { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function trace(...options: string[]): Promise<Record<string, any>> {
  const answer = await cli(["trace", ...options, repo, TARGET]);
  assert.equal(answer.code, EXIT_CODE.ok, answer.stderr);
  return JSON.parse(answer.stdout);
}

test("a declared JDK is recorded in the inputs as an unverified jdk and changes no step, link or cut, a build stating its own release included", async () => {
  commit({ "pom.xml": "<project><properties><java.version>25</java.version></properties></project>\n" });
  const home = await jdkHome();
  const plain = await trace();
  const declared = await trace("--jdk", home);

  assert.equal("buildOutputs" in plain.inputs, false);
  assert.deepEqual(declared.inputs.buildOutputs, [
    {
      kind: "jdk",
      at: "",
      verified: false,
      digest: createHash("sha256").update(readFileSync(join(home, "lib", "ct.sym"))).digest("hex"),
      jdk: { vendor: "Eclipse Adoptium", version: "25.0.5", feature: 25, basis: "declared-jdk" },
    },
  ]);
  const { buildOutputs: _recorded, ...otherInputs } = declared.inputs;
  assert.deepEqual({ ...declared, inputs: otherInputs }, plain);
});

test("a JDK older than a release a build file states is a build-output cut, and the answer records no jdk", async () => {
  commit({ "pom.xml": "<project><properties><java.version>26</java.version></properties></project>\n" });
  const declared = await trace("--jdk", await jdkHome());

  assert.equal("buildOutputs" in declared.inputs, false);
  assert.equal(declared.status, "partial");
  assert.deepEqual(declared.cuts.filter((cut: { kind: string }) => cut.kind === "build-output").map(({ at, reason }: { at: string[]; reason: string }) => ({ at, reason })), [{ at: ["."], reason: "jdk-older-than-build" }]);
});

test("a build file under another directory than the declaration's at does not refuse it", async () => {
  commit({ "api/pom.xml": "<project><properties><java.version>26</java.version></properties></project>\n" });
  const declared = await trace("--jdk", `src=${await jdkHome()}`);

  assert.equal(declared.inputs.buildOutputs[0].at, "src");
  assert.equal(declared.status, "complete");
});

test("a declared JDK that cannot be read is a jdk-unreadable cut, never a failed query", async () => {
  commit({});
  const declared = await trace("--jdk", join(workspace, "no-jdk"));

  assert.equal("buildOutputs" in declared.inputs, false);
  assert.deepEqual(declared.cuts.filter((cut: { kind: string }) => cut.kind === "build-output").map(({ reason }: { reason: string }) => reason), ["jdk-unreadable"]);
});

test("the commands that read no library signatures refuse --jdk as a usage error", async () => {
  commit({});
  const home = await jdkHome();
  for (const argv of [
    ["callers", "--jdk", home, repo, TARGET],
    ["impact", "--jdk", home, "--base", "HEAD", repo],
    ["importers", "--jdk", home, repo, "src/main/java/shop/Check.java"],
    ["outline", "--jdk", home, repo, "src/main/java/shop/Check.java"],
    ["workspace", "--jdk", home, repo],
    ["decisions", "--jdk", home, repo],
    ["contract-consequences", "--jdk", home, "--base", "HEAD", repo],
  ]) {
    const refused = await cli(argv);
    assert.equal(refused.code, EXIT_CODE.usage, argv[0]);
    assert.equal(refused.stdout, "", argv[0]);
  }
});
