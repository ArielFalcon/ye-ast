import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { Cut } from "../core/domain/shared/fact.ts";

/**
 * A class whose supertype a single-type import names and no source declares. In `proxied` a test source creates a
 * dynamic proxy, which settles nothing about the type a written name binds; in `unparsed` a source the reader cannot
 * parse may declare the imported type itself.
 */
const APP = "src/main/java/app";
const java = (path: string, ...lines: string[]): [string, string] => [path, [`package ${path.split("/").at(-2)};`, ...lines, ""].join("\n")];
const CONTROLLER = java(`${APP}/Controller.java`, "import app.api.OrdersApi;", "public class Controller implements OrdersApi {", "  public String m() { return \"c\"; }", "}");
const REPOSITORIES: Record<string, Record<string, string>> = {
  proxied: Object.fromEntries([
    CONTROLLER,
    java("src/test/java/app/ControllerTest.java", "import java.lang.reflect.Proxy;", "class ControllerTest {", "  Object proxy(Class<?> type) { return Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (p, m, a) -> null); }", "}"),
  ]),
  unparsed: Object.fromEntries([CONTROLLER, java(`${APP}/Broken.java`, "public class Broken { void broken( }")]),
};

let root: string;
let scratchRoot: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-supertype-proof-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  for (const [name, files] of Object.entries(REPOSITORIES)) {
    const repo = join(root, name);
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
    execFileSync("git", ["commit", "-qm", name], { cwd: repo, env: ENV });
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function relationUnread(name: string): Promise<(readonly string[])[]> {
  const result = await composeQueries({ scratchRoot }).impact.importers({ repo: join(root, name), repoId: name, revision: "HEAD", files: [`${APP}/Controller.java`] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const cuts: readonly Cut[] = result.value.status === "partial" ? result.value.cuts : [];
  return cuts.filter((cut) => "reason" in cut && cut.reason === "relation-unread" && cut.at[0] === `${APP}/Controller.java::Controller`).map(({ at }) => at);
}

test("importers of a class whose supertype a single-type import names outside the sources carry no cut where a source creates a dynamic proxy, and a cut where a source is unparsed", async () => {
  assert.deepEqual(await relationUnread("proxied"), []);
  assert.deepEqual(await relationUnread("unparsed"), [[`${APP}/Controller.java::Controller`, `${APP}/Controller.java:3 OrdersApi`]]);
});
