import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createEvidenceComposition } from "../core/application/composition/evidence-composition.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { createMcpServer } from "../mcp/server.ts";
import { openSession } from "../mcp/test-session.testing.ts";
import { composeCli, composeQueries, type CompositionOptions, type ComposedQueries } from "./compose.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const REPO_ID = "shop";
const SERVICE = "src/service.ts";
const RUN = "src/run.ts";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop", dependencies: { "@angular/core": "20.0.0" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "es2022", moduleResolution: "bundler", experimentalDecorators: true }, include: ["src"] }),
  [SERVICE]: "export class Service {\n  execute(): string {\n    return 'service';\n  }\n}\n",
  [RUN]: "import { Service } from './service';\n\nexport function run(x: Service): string {\n  return x.execute();\n}\n",
  "src/panel.ts": "import { inject } from '@angular/core';\nimport { Service } from './service';\n\nexport class Panel {\n  show(): string {\n    return inject(Service).execute();\n  }\n}\n",
};

/** `@angular/core` as an install leaves it, at `version`. */
const angularCore = (version: string): Record<string, string> => ({
  "@angular/core/package.json": JSON.stringify({ name: "@angular/core", version, types: "index.d.ts" }),
  "@angular/core/index.d.ts": "export declare function inject<T>(token: abstract new (...args: never[]) => T): T;\n",
});

let workspace: string;
let repo: string;
let scratchRoot: string;
let trustDirectory: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-answer-memo-"));
  repo = join(workspace, REPO_ID);
  scratchRoot = join(workspace, "scratch");
  trustDirectory = join(workspace, "config", "ye-ast");
  mkdirSync(repo);
  mkdirSync(scratchRoot);
  write(repo, FILES);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const installed = await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", "trusted", repo], { out: () => undefined, err: () => undefined });
  assert.equal(installed, EXIT_CODE.ok);
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

interface Line {
  event: string;
  stage?: string;
  outcome?: string;
}

/** One process whose measurement lines are kept: `outcomes` empties them and answers what the answer memo did since. */
function measured(options: CompositionOptions = {}): { queries: ComposedQueries; outcomes: () => string[]; lines: Line[] } {
  const lines: Line[] = [];
  const queries = composeQueries({ scratchRoot, trustDirectory, ...options, measure: (text) => void lines.push(JSON.parse(text).ye_ast as Line) });
  return { queries, lines, outcomes: () => lines.splice(0).filter(({ event }) => event === "answer-memo").map(({ outcome }) => outcome!) };
}

const liveCallers = (queries: ComposedQueries) => queries.impact.callers({ repo, repoId: REPO_ID, live: true, targets: [{ file: SERVICE, symbol: "Service.execute" }] });
const fresh = (ask: (queries: ComposedQueries) => Promise<unknown>, options: CompositionOptions = {}) => ask(composeQueries({ scratchRoot, trustDirectory, ...options }));

/** A stage line that reads the index or the sources to derive the answer: a kept answer writes none. */
const derives = ({ event, stage }: Line): boolean => event === "stage" && stage !== undefined && /^(graph-|relations|import-origins|root-origins|member-names|type-bindings|angular)/.test(stage);

test("a paged follow-up of a callers answer derives nothing: it answers the kept fact after the freshness proof", async () => {
  const { queries, lines, outcomes } = measured();
  const server = createMcpServer({ ...queries, digest: createSha256Digest(), evidenceComposition: createEvidenceComposition(createSha256Digest()), repository: { path: repo, repoId: REPO_ID } });
  const session = await openSession(server);
  const args = { revision: "HEAD", targets: [{ file: SERVICE, symbol: "Service.execute" }] };
  const first = await session.callTool("ye_ast_callers", args);
  assert.notEqual(first.isError, true, JSON.stringify(first).slice(0, 1000));
  assert.deepEqual(outcomes(), ["admitted"]);

  await session.callTool("ye_ast_callers", { ...args, select: { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 }, page: { limit: 1 } });
  assert.deepEqual(lines.filter(derives), []);
  assert.deepEqual(outcomes(), ["hit"]);
});

test("an edit misses the kept live answer, and the new answer equals a fresh process's", async () => {
  const { queries, outcomes } = measured();
  await liveCallers(queries);
  await liveCallers(queries);
  assert.deepEqual(outcomes(), ["admitted", "hit"]);

  write(repo, { [RUN]: FILES[RUN]!.replace("x.execute()", "x.execute() + '!'") });
  const edited = await liveCallers(queries);
  assert.deepEqual(outcomes(), ["admitted"]);
  assert.equal(canonicalJson(edited), canonicalJson(await fresh(liveCallers)));
});

test("a commit without a tree change misses the kept live answer: the new answer names the new HEAD", async () => {
  const { queries, outcomes } = measured();
  const before = await liveCallers(queries);
  git("commit", "-q", "--allow-empty", "-m", "empty");
  const after = await liveCallers(queries);
  assert.deepEqual(outcomes(), ["admitted", "admitted"]);
  assert.ok(before.ok && after.ok && before.value.snapshot.kind === "live" && after.value.snapshot.kind === "live");
  assert.equal(after.value.snapshot.head, git("rev-parse", "HEAD"));
  assert.notEqual(after.value.snapshot.head, before.value.snapshot.head);
});

test("a dependency installed again at the same declared path misses: the answer reads what the path holds now", async () => {
  const modules = join(workspace, "install", "node_modules");
  write(modules, angularCore("20.0.0"));
  const options: CompositionOptions = { buildOutputs: (at) => (at === repo ? [{ kind: "node-modules", at: "", path: modules }] : undefined) };
  const callers = (queries: ComposedQueries) => queries.impact.callers({ repo, repoId: REPO_ID, revision: "HEAD", targets: [{ file: SERVICE, symbol: "Service.execute" }] });
  const { queries, outcomes } = measured(options);
  const first = await callers(queries);

  write(modules, angularCore("20.1.0"));
  const second = await callers(queries);
  assert.deepEqual(outcomes(), ["not-kept", "not-kept"]);
  assert.notEqual(canonicalJson(second), canonicalJson(first));
  assert.equal(canonicalJson(second), canonicalJson(await fresh(callers, options)));
});
