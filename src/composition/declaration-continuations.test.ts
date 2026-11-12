import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeQueries } from "./compose.ts";

async function inRepository(files: Readonly<Record<string, string>>, verify: (queries: ReturnType<typeof composeQueries>, request: { repo: string; repoId: string; revision: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ye-ast-declarations-"));
  const repo = join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(root, "scratch"));
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" }).toString().trim();
    git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "fixture");
    const queries = composeQueries({ scratchRoot: join(root, "scratch"), cacheDirectory: join(root, "cache") });
    const request = { repo, repoId: "fixture", revision: git("rev-parse", "HEAD") };
    await verify(queries, request);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("store declarations join trace effects and reverse callers through the same registered plugin", async () => {
  await inRepository({
  "package.json": JSON.stringify({ dependencies: { "@angular/core": "1.0.0", "@ngrx/signals": "1.0.0" } }),
  "src/store.ts": "import { signalStore, withMethods } from '@ngrx/signals';\nexport const S = signalStore(withMethods(() => ({\n m() {\n  fetch('/items');\n }\n})));\n",
  "src/page.ts": "import { inject } from '@angular/core';\nimport { S } from './store';\nexport class Page {\n private readonly s = inject(S);\n run() { this.s.m(); this.s.m(); }\n}\n",
}, async (queries, request) => {
    const trace = await queries.trace.walk({ ...request, targets: [{ file: "src/page.ts", symbol: "Page.run" }] });
    assert.ok(trace.ok, JSON.stringify(trace));
    assert.notEqual(trace.value.status, "unknown");
    if (trace.value.status === "unknown") return;
    assert.ok(trace.value.value.steps.some(({ file, symbol }) => file === "src/store.ts" && symbol === "m"), JSON.stringify(trace.value));
    assert.ok(trace.value.value.steps.some(({ effects }) => effects?.some((effect) => effect.kind === "http")), JSON.stringify(trace.value));
    const callers = await queries.impact.callers({ ...request, targets: [{ file: "src/store.ts", symbol: "S.m" }] });
    assert.ok(callers.ok, JSON.stringify(callers));
    assert.notEqual(callers.value.status, "unknown");
    if (callers.value.status === "unknown") return;
    const run = callers.value.value.symbols.find(({ file, symbol }) => file === "src/page.ts" && symbol === "run");
    assert.equal(run?.depth, 1, JSON.stringify(callers.value));
    assert.deepEqual(run?.via?.lines, [5]);
    assert.equal(run?.via?.derivation, "proven");
  });
});

test("a Java method reference reaches its caller while remaining deferred in trace", async () => {
  await inRepository({ "src/Refs.java": "package fixture;\nimport java.util.function.Function;\nclass Refs {\n String fmt(String value) { return value.trim(); }\n void run() { Function<String, String> fn = this::fmt; }\n}\n" }, async (queries, request) => {
    const trace = await queries.trace.walk({ ...request, targets: [{ file: "src/Refs.java", symbol: "Refs.run" }] });
    assert.ok(trace.ok, JSON.stringify(trace));
    assert.notEqual(trace.value.status, "unknown");
    if (trace.value.status === "unknown") return;
    const reference = trace.value.value.steps.find(({ symbol }) => symbol === "fmt");
    assert.equal(reference?.deferred, true, JSON.stringify(trace.value));
    assert.equal(reference?.via, "reference");
    const callers = await queries.impact.callers({ ...request, targets: [{ file: "src/Refs.java", symbol: "Refs.fmt" }] });
    assert.ok(callers.ok, JSON.stringify(callers));
    assert.notEqual(callers.value.status, "unknown");
    if (callers.value.status === "unknown") return;
    const run = callers.value.value.symbols.find(({ symbol }) => symbol === "run");
    assert.equal(run?.via?.basis, "reference", JSON.stringify(callers.value));
    assert.deepEqual(run?.via?.lines, [5]);
  });
});
