import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";

test("native change analysis disproves a removed callback declaration while retaining a real deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ye-ast-declaration-evidence-"));
  const repo = join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  try {
    await mkdir(repo);
    await mkdir(join(root, "scratch"));
    git("init", "-q", "-b", "main");
    await put("package.json", JSON.stringify({ dependencies: { "event-library": "1.0.0" } }));
    await put("src/events.ts", "import { subscribe } from 'event-library';\nexport function run() {\n  subscribe(() => {\n    return 1;\n  });\n}\nexport function save() { return 1; }\n");
    await put("src/use.ts", "export function consume(receiver: any) { receiver.subscribe(); receiver.save(); }\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    await put("src/events.ts", "import { subscribe } from 'event-library';\nexport function run() { return 2; }\n");
    git("add", ".");
    git("commit", "-qm", "change");
    const result = await composeQueries({ scratchRoot: join(root, "scratch") }).impact.ofChange({ repo, repoId: "events", base, head: "HEAD" });
    assert.ok(result.ok, JSON.stringify(result));
    assert.notEqual(result.value.status, "unknown");
    if (result.value.status === "unknown") return;
    const anchors = (result.value.status === "partial" ? result.value.cuts : []).map((cut) => cut.at[0]);
    assert.ok(!anchors.includes("src/events.ts::subscribe"), JSON.stringify(anchors));
    assert.ok(anchors.includes("src/events.ts::save"), JSON.stringify(anchors));
    assert.ok(result.value.value.symbols.some((symbol) => symbol.file === "src/events.ts" && symbol.symbol === "run"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
