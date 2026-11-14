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
 * A TypeScript call on `this` binds through the hierarchy of the class it is written in (ADR-0090): the index edge of
 * such a call is moved to the declaration the class chain names, and not followed into a homonym the call cannot run.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const method = (name: string, body = `console.log("${name}");`): string => `  ${name}(): void {\n    ${body}\n  }`;
const SOURCES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "fx", private: true, dependencies: { "base-kit": "1.0.0" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/store.ts": `export class Store {\n${method("save")}\n}`,
  "src/other.ts": `export class Other {\n${method("save")}\n}`,
  "src/sub.ts": `import { Store } from "./store";\n\nexport class Sub extends Store {\n${method("run", "this.save();")}\n}`,
  "src/own.ts": `export class Own {\n${method("save")}\n\n${method("keep", "this.save();")}\n}`,
  "src/queue.ts": `export abstract class Queue {\n  abstract send(row: string): void;\n\n${method("flush", "this.send(\"row\");")}\n}`,
  "src/fast-queue.ts": `import { Queue } from "./queue";\n\nexport class FastQueue extends Queue {\n  send(row: string): void {\n    console.log("fast", row);\n  }\n}`,
  "src/slow-queue.ts": `import { Queue } from "./queue";\n\nexport class SlowQueue extends Queue {\n  send(row: string): void {\n    console.log("slow", row);\n  }\n}`,
  "src/mailer.ts": `export class Mailer {\n  send(row: string): void {\n    console.log("mail", row);\n  }\n}`,
  "src/widget.ts": `import { Base } from "base-kit";\n\nexport class Widget extends Base {\n${method("draw", "this.render();")}\n}`,
  "src/painter.ts": `export class Painter {\n${method("render")}\n}`,
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-this-call-edge-"));
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

/** The status, the declarations reached through a call, and every cut as its reason and its places. */
async function callers(target: string): Promise<{ status: string; callers: readonly string[]; cuts: readonly string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["callers", repo, target], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  const fact = JSON.parse(stdout.join("\n")) as { status: string; cuts?: readonly Cut[]; value: { symbols: readonly { symbol: string; via?: { basis: string } }[] } };
  return {
    status: fact.status,
    callers: fact.value.symbols.filter(({ via }) => via?.basis === "call").map(({ symbol }) => symbol).sort(),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at.join(" | ")}`),
  };
}

test("a call on this binds to the member its class inherits, never to a homonym outside the class's hierarchy", async () => {
  assert.deepEqual(await callers("src/store.ts:save"), { status: "complete", callers: ["run"], cuts: [] });
  assert.deepEqual(await callers("src/other.ts:save"), { status: "complete", callers: [], cuts: [] });
});

test("a call on this into the class it is written in keeps its caller", async () => {
  assert.deepEqual(await callers("src/own.ts:save"), { status: "complete", callers: ["keep"], cuts: [] });
});

test("a call on this to an abstract member lists or cuts its caller in every implementation, and in no homonym outside the hierarchy", async () => {
  for (const implementation of ["src/fast-queue.ts:send", "src/slow-queue.ts:send"]) {
    const fact = await callers(implementation);
    const cut = `hidden-caller ${implementation.replace(":", "::")} | src/queue.ts:5 send`;
    assert.ok(fact.callers.includes("flush") ? fact.status === "complete" && fact.cuts.length === 0 : fact.status === "partial" && fact.cuts.includes(cut), `${implementation} ${JSON.stringify(fact)}`);
  }
  assert.deepEqual(await callers("src/mailer.ts:send"), { status: "complete", callers: [], cuts: [] });
});

test("a call on this whose class chain ends at a package's superclass is not followed into a repository homonym outside the chain", async () => {
  assert.deepEqual(await callers("src/painter.ts:render"), { status: "complete", callers: [], cuts: [] });
});
