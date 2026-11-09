import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
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
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

async function trace(target: string): Promise<{ status: string; cuts?: Cut[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, target], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

test("a dispatch the TypeScript pack declares absent stays a dispatch cut that names the absence (ADR-0042 fixture 12)", async () => {
  commit({
    "src/flow.ts": `export interface Port {
  save(): void;
}

export class Flow {
  constructor(private readonly port: Port) {}

  run(): void {
    this.port.save();
  }
}
`,
  });
  const result = await trace("src/flow.ts:Flow.run");
  assert.equal(result.status, "partial");
  const dispatch = result.cuts?.filter((cut) => cut.at[0] === "src/flow.ts:2 save");
  assert.deepEqual(dispatch?.map(({ kind, reason, subReason }) => ({ kind, reason, subReason })), [{ kind: "unresolved-link", reason: "dispatch", subReason: "capability-absent" }]);
});

test("a member call whose receiver only the absent receiver stage could settle keeps receiver-unproven and names the absence", async () => {
  commit({
    "src/flow.ts": `export class A { save(): void {} }
export class B { save(): void {} }
export function run(port: A): void {
  port.save();
}
`,
  });
  const result = await trace("src/flow.ts:run");
  const call = result.cuts?.filter((cut) => cut.at[0] === "src/flow.ts:4 save");
  assert.deepEqual(call?.map(({ reason, subReason, reach }) => ({ reason, subReason, reach })), [{ reason: "receiver-unproven", subReason: "capability-absent", reach: { kind: "call-at", place: "src/flow.ts:4 save" } }]);
});

test("a member call the declared-receiver binding leaves unbound names the same absence when its pack cannot read receivers", async () => {
  commit({
    "src/flow.ts": `export class A { save(): void {} }
export class B { save(): void {} }
const holder = { port: new A() };
export function run(): void {
  holder.port.save();
}
`,
  });
  const result = await trace("src/flow.ts:run");
  const call = result.cuts?.filter((cut) => cut.at[0] === "src/flow.ts:5 holder.port.save");
  assert.deepEqual(call?.map(({ reason, subReason }) => ({ reason, subReason })), [{ reason: "receiver-unproven", subReason: "capability-absent" }]);
});

test("a Java dispatch an aspect may replace keeps the reason the dispatch port gave as its sub-reason", async () => {
  commit({
    "src/Flow.java": `@org.aspectj.lang.annotation.Aspect class Advice { @org.aspectj.lang.annotation.Around("bean(worker)") Object around() { return null; } }
interface Port { void save(); }
class Worker implements Port { public void save() {} }
class Flow {
  private Port service;
  void run() { service.save(); }
}
`,
  });
  const result = await trace("src/Flow.java:Flow.run");
  const dispatch = result.cuts?.filter((cut) => cut.at[0] === "src/Flow.java:2 save");
  assert.deepEqual(dispatch?.map(({ reason, subReason }) => ({ reason, subReason })), [{ reason: "dispatch", subReason: "aspect may replace the body" }]);
});
