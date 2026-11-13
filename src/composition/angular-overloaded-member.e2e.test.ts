import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import { EDGE_POLICY } from "../core/domain/impact/edge-policy.ts";

/**
 * `Handler` injects `Errors`, whose `notify` is two overload signatures and one implementation and `clear` one method, and
 * `Audit`, whose `record` has a homonym in `Trail`, another class of its file.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0" } }),
  "src/errors.service.ts": [
    "import { Injectable } from '@angular/core';",
    "",
    "@Injectable({ providedIn: 'root' })",
    "export class Errors {",
    "  notify(message: string): void;",
    "  notify(message: string, code: number): void;",
    "  notify(message: string, code?: number): void {",
    "    console.log(message, code);",
    "  }",
    "",
    "  clear(): void {",
    "    console.log('clear');",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/audit.service.ts": [
    "import { Injectable } from '@angular/core';",
    "",
    "@Injectable({ providedIn: 'root' })",
    "export class Audit {",
    "  record(): void {",
    "    console.log('audit');",
    "  }",
    "}",
    "",
    "export class Trail {",
    "  record(): void {",
    "    console.log('trail');",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/handler.ts": [
    "import { Injectable, inject } from '@angular/core';",
    "import { Audit } from './audit.service';",
    "import { Errors } from './errors.service';",
    "",
    "@Injectable({ providedIn: 'root' })",
    "export class Handler {",
    "  private readonly errors = inject(Errors);",
    "  private readonly audit = inject(Audit);",
    "",
    "  fail(): void {",
    "    this.errors.notify('failed', 500);",
    "  }",
    "",
    "  reset(): void {",
    "    this.errors.clear();",
    "  }",
    "",
    "  log(): void {",
    "    this.audit.record();",
    "  }",
    "}",
    "",
  ].join("\n"),
};

let root: string;
let repo: string;
let scratchRoot: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-angular-overloaded-member-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env: ENV });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const PROVEN = { confidence: EDGE_POLICY.relations.confidence, derivation: "proven" };

async function callerOf(member: string, caller: string, file = "src/errors.service.ts"): Promise<{ settled: unknown; cuts: unknown }> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "angular-overloaded-member", revision: "HEAD", targets: [{ file, symbol: member }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const found = result.value.value.symbols.find((symbol) => symbol.file === "src/handler.ts" && symbol.symbol === caller);
  return { settled: found === undefined ? undefined : { confidence: found.confidence, derivation: found.via?.derivation }, cuts: result.value.status === "partial" ? result.value.cuts : [] };
}

test("a call on an injected service member that is an overload set is a proven caller of its one implementation, with no cut at the call", async () => {
  assert.deepEqual(await callerOf("Errors.notify", "fail"), { settled: PROVEN, cuts: [] });
});

test("a call on an injected service member that is one method is a proven caller, with no cut at the call", async () => {
  assert.deepEqual(await callerOf("Errors.clear", "reset"), { settled: PROVEN, cuts: [] });
});

test("a call on an injected service member whose name another class of its file also declares stays a proven caller with its name-only cut", async () => {
  const { settled, cuts } = await callerOf("Audit.record", "log", "src/audit.service.ts");
  assert.deepEqual(settled, PROVEN);
  assert.deepEqual((cuts as { reason: string; at: string[] }[]).map(({ reason, at }) => [reason, at]), [["name-only", ["src/handler.ts", "src/handler.ts:19 this.audit.record"]]]);
});
