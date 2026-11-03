import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
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

const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
class OrderController {
  private final OrderService service;

  OrderController(OrderService service) { this.service = service; }

  @GetMapping("/{id}")
  String one() {
    return service.find();
  }
}
`;

const SERVICE = `package shop;

interface OrderService {
  String find();
}
`;

const IMPL = `package shop;

import org.springframework.stereotype.Service;

@Service
class OrderServiceImpl implements OrderService {
  public String find() {
    return Util.fmt("x");
  }
}
`;

const UTIL = (body: string): string => `package shop;

class Util {
  static String fmt(String s) {
    return ${body};
  }
}
`;

const DIR = "src/main/java/shop/";

let workspace: string;
let repo: string;
let scratchRoot: string;
let trustDirectory: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-live-"));
  repo = join(workspace, "shop-service");
  scratchRoot = join(workspace, "scratch");
  trustDirectory = join(workspace, "config", "ye-ast");
  mkdirSync(repo);
  mkdirSync(scratchRoot);
  git("init", "-q", "-b", "main");
  commit({ [`${DIR}OrderController.java`]: CONTROLLER, [`${DIR}OrderService.java`]: SERVICE, [`${DIR}OrderServiceImpl.java`]: IMPL, [`${DIR}Util.java`]: UTIL("s") }, "base");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commit(files: Readonly<Record<string, string>>, message = "change"): string {
  write(files);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

interface Answer {
  code: number;
  stdout: string;
  stderr: string;
  fact: { status: string; value: any; snapshot: { kind: string; stateId?: string; head?: string }; inputs: { content: string; origin?: { kind: string; base?: string }; declaredScope: { ignored?: string } }; reason?: string };
}

async function ye(command: string, args: string[], tail: string[] = []): Promise<Answer> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot, trustDirectory })([command, ...args, repo, ...tail], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  const text = stdout.join("\n");
  return { code, stdout: text, stderr: stderr.join("\n"), fact: text === "" ? ({} as Answer["fact"]) : JSON.parse(text) };
}

async function trust(mode: "trusted" | "untrusted"): Promise<void> {
  const installed = await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", mode, repo], { out: () => undefined, err: () => undefined });
  assert.equal(installed, EXIT_CODE.ok);
}

const stateFile = (): string => join(repo, ".ye-ast-graph", "live", readdirSync(join(repo, ".ye-ast-graph", "live")).find((name) => name.endsWith(".state.json"))!);

test("under untrusted, every live query is refused with the command that trusts the repository and nothing is written", async () => {
  for (const [command, tail] of [["map", []], ["impact", ["--base", "HEAD"]], ["callers", [`${DIR}Util.java:fmt`]], ["importers", [`${DIR}Util.java`]]] as const) {
    const args = command === "impact" ? ["--base", "HEAD", "--live"] : ["--live"];
    const answer = await ye(command, args, command === "impact" ? [] : [...tail]);

    assert.equal(answer.code, EXIT_CODE.queryFailed, command);
    assert.equal(answer.stdout, "");
    assert.match(answer.stderr, /live-requires-trusted.*ye-ast init --trust trusted/);
  }
  assert.equal(existsSync(join(repo, ".ye-ast-graph")), false);
});

test("--live with --head is a usage error", async () => {
  assert.equal((await ye("impact", ["--base", "HEAD", "--live", "--head", "HEAD"])).code, EXIT_CODE.usage);
});

test("on a clean tree every live answer carries the sha answer's value and the stateId is the content digest of HEAD", async () => {
  await trust("trusted");

  const liveMap = await ye("map", ["--live"]);
  const shaMap = await ye("map", []);
  const liveImpact = await ye("impact", ["--base", "HEAD", "--live"]);
  const shaImpact = await ye("impact", ["--base", "HEAD"]);
  const liveCallers = await ye("callers", ["--live"], [`${DIR}Util.java:fmt`]);
  const shaCallers = await ye("callers", [], [`${DIR}Util.java:fmt`]);
  const liveImporters = await ye("importers", ["--live"], [`${DIR}OrderService.java`]);
  const shaImporters = await ye("importers", [], [`${DIR}OrderService.java`]);

  for (const [live, sha] of [[liveMap, shaMap], [liveImpact, shaImpact], [liveCallers, shaCallers], [liveImporters, shaImporters]] as const) {
    assert.equal(live.code, EXIT_CODE.ok, live.stderr);
    assert.equal(live.fact.snapshot.kind, "live");
    assert.equal(live.fact.snapshot.stateId, shaMap.fact.inputs.content);
    assert.equal(live.fact.snapshot.head, git("rev-parse", "HEAD"));
    assert.equal(live.fact.inputs.declaredScope.ignored, "git");
    assert.equal(live.fact.status, sha.fact.status);
  }
  const entries = (fact: Answer["fact"]): unknown[] => fact.value.entrypoints.value.map((item: { value: unknown }) => item.value);
  assert.deepEqual(entries(liveMap.fact), entries(shaMap.fact));
  for (const [live, sha] of [[liveImpact, shaImpact], [liveCallers, shaCallers], [liveImporters, shaImporters]] as const) assert.deepEqual(live.fact.value, sha.fact.value);
  assert.equal("index" in liveMap.fact.inputs, false);
  assert.equal("index" in liveImpact.fact.inputs, false);
  assert.deepEqual(liveCallers.fact.inputs.origin, { kind: "full" });
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test("a second live query with no edit leaves the recorded state byte for byte as it was", async () => {
  await trust("trusted");
  await ye("importers", ["--live"], [`${DIR}OrderService.java`]);
  const before = readFileSync(stateFile(), "utf8");

  const again = await ye("importers", ["--live"], [`${DIR}OrderService.java`]);

  assert.equal(again.code, EXIT_CODE.ok, again.stderr);
  assert.equal(readFileSync(stateFile(), "utf8"), before);
});

const SHAPES: readonly (readonly [string, () => void])[] = [
  ["an unstaged edit", () => write({ [`${DIR}Util.java`]: UTIL("s.trim()") })],
  ["a staged edit", () => { write({ [`${DIR}Util.java`]: UTIL("s.strip()") }); git("add", `${DIR}Util.java`); }],
  ["an untracked file", () => write({ [`${DIR}Extra.java`]: "package shop;\n\nclass Extra {\n  static int one() {\n    return 1;\n  }\n}\n" })],
  ["a deleted file", () => rmSync(join(repo, `${DIR}Util.java`))],
  ["an edit staged and then edited again", () => { write({ [`${DIR}OrderServiceImpl.java`]: IMPL.replace('"x"', '"y"') }); git("add", "-A"); write({ [`${DIR}OrderServiceImpl.java`]: IMPL.replace('"x"', '"z"') }); }],
];

test("a staged edit, an unstaged edit, an untracked file and a deleted file each give the value committing them gives, and each refresh is a sync", async () => {
  await trust("trusted");
  const first = await ye("impact", ["--base", "HEAD", "--live"]);
  assert.equal(first.code, EXIT_CODE.ok, first.stderr);
  const fullBuild = first.fact.snapshot.stateId;

  for (const [name, apply] of SHAPES) {
    const base = git("rev-parse", "HEAD");
    apply();

    const live = await ye("impact", ["--base", base, "--live"]);
    commit({}, name);
    const sha = await ye("impact", ["--base", base, "--head", "HEAD"]);

    assert.equal(live.code, EXIT_CODE.ok, `${name}: ${live.stderr}`);
    assert.deepEqual(live.fact.value, sha.fact.value, name);
    assert.deepEqual(live.fact.inputs.origin, { kind: "sync", base: fullBuild }, name);
    assert.equal(live.fact.snapshot.stateId, (await ye("map", ["--live"])).fact.snapshot.stateId, name);
  }
});
