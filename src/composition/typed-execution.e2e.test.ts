import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";

/**
 * ADR-0045 decision 5's mandatory fixtures, with a declared build output: the type checker's binding of a call on a
 * structural parameter, on what a replaceable provider injects, or on a private member of the class it names, proves
 * the dependence `callers` lists, never a body trace runs.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "es2022", moduleResolution: "bundler", experimentalDecorators: true }, include: ["src"] }),
  "src/service.ts": "export class Service {\n  execute(): string {\n    return 'service';\n  }\n}\n\nexport class Other extends Service {\n  override execute(): string {\n    return 'other';\n  }\n}\n",
  "src/run.ts": "import { Service } from './service';\n\nexport function run(x: Service): string {\n  return x.execute();\n}\n",
  "src/panel.ts": "import { Component, inject } from '@angular/core';\nimport { Other, Service } from './service';\n\n@Component({ selector: 'app-panel', template: '', providers: [{ provide: Service, useClass: Other }] })\nexport class Panel {\n  show(): string {\n    return inject(Service).execute();\n  }\n}\n",
  "src/ledger.ts": "export class Ledger {\n  #save(value: string): void {\n    console.log(value);\n  }\n\n  run(other: Ledger): void {\n    other.#save('a');\n  }\n}\n",
};

/** The declarations the fixture imports from `@angular/core`, as an install would leave them. */
const ANGULAR_CORE: Record<string, string> = {
  "@angular/core/package.json": JSON.stringify({ name: "@angular/core", version: "20.0.0", types: "index.d.ts" }),
  "@angular/core/index.d.ts": "export declare function Component(options: unknown): ClassDecorator;\nexport declare function inject<T>(token: abstract new (...args: never[]) => T): T;\n",
};

let root: string;
let repo: string;
let scratchRoot: string;
let modules: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

async function writeAll(at: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(at, path)), { recursive: true });
    await writeFile(join(at, path), text);
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-typed-execution-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  modules = join(root, "install", "node_modules");
  await mkdir(repo);
  await mkdir(scratchRoot);
  await writeAll(repo, FILES);
  await writeAll(modules, ANGULAR_CORE);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env: ENV });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const queries = () => composeQueries({ scratchRoot, buildOutputs: (at) => (at === repo ? [{ kind: "node-modules", at: "", path: modules }] : undefined) });

async function callersOf(file: string, symbol: string): Promise<Fact<ImpactValue>> {
  const result = await queries().impact.callers({ repo, repoId: "typed-execution", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return result.value;
}

async function traceOf(file: string, symbol: string): Promise<Fact<TraceValue>> {
  const result = await queries().trace.walk({ repo, repoId: "typed-execution", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return result.value;
}

/** Each dependent at depth 1 with how the call is known. */
const dependents = (fact: Fact<ImpactValue>): string[] => (fact.status === "unknown" ? [] : fact.value.symbols.filter(({ depth }) => depth === 1).map(({ file, symbol, via }) => `${file}:${symbol} ${via?.derivation ?? ""}`).sort());
const stepsOf = (fact: Fact<TraceValue>): string[] => (fact.status === "unknown" ? [] : fact.value.steps.map(({ file, symbol }) => `${file}:${symbol}`));

test("a call on a structural parameter the type checker binds is a typed caller, and trace does not run the declaration (structural parameter)", async () => {
  const callers = await callersOf("src/service.ts", "Service.execute");
  const trace = await traceOf("src/run.ts", "run");

  assert.ok(dependents(callers).includes("src/run.ts:run typed"), dependents(callers).join("\n"));
  assert.deepEqual(stepsOf(trace), ["src/run.ts:run"]);
  assert.ok(trace.inputs.buildOutputs !== undefined && trace.inputs.buildOutputs.length === 1);
});

test("a call on what a replaceable provider injects that the type checker binds is a typed caller, and trace does not run the declaration as proven (replaceable provider)", async () => {
  const callers = await callersOf("src/service.ts", "Service.execute");
  const trace = await traceOf("src/panel.ts", "Panel.show");

  assert.ok(dependents(callers).includes("src/panel.ts:show typed"), dependents(callers).join("\n"));
  assert.ok(!stepsOf(trace).includes("src/service.ts:Service.execute"), stepsOf(trace).join("\n"));
});

test("a typed binding of a private member keeps its `#`, so the call on it is a typed caller", async () => {
  const callers = await callersOf("src/ledger.ts", "#save");

  assert.ok(dependents(callers).includes("src/ledger.ts:run typed"), dependents(callers).join("\n"));
});
