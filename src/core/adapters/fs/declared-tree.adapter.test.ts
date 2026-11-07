import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import { createDeclaredTrees } from "./declared-tree.adapter.ts";

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-declared-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A checkout with `node_modules` installed inside it at `at`, the pipeline layout; `files` and `links` are relative to the case. */
async function checkout(at: string, files: Record<string, string>, links: Record<string, string>): Promise<DeclaredBuildOutput> {
  counter += 1;
  const base = join(scratch, `case-${counter}`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), content);
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await symlink(target, join(base, path));
  }
  const modules = join(base, "checkout", at, "node_modules");
  await mkdir(modules, { recursive: true });
  return { kind: "node-modules", at, path: modules };
}

test("a link leading out of the declared directory and the repository is refused, and its target is never read", async () => {
  const outside = join(scratch, "outside-secret");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "index.d.ts"), "export declare const secret: 1;");
  const relative = await checkout("", {}, { "checkout/node_modules/evil": "../../../outside-secret" });
  const absolute = await checkout("", {}, { "checkout/node_modules/evil": outside });
  for (const output of [relative, absolute]) {
    assert.deepEqual(createDeclaredTrees().open(output).entry("evil/index.d.ts"), { kind: "refused", link: "node_modules/evil" });
  }
});

test("a link into the repository is answered as the snapshot's path, never with the working tree's bytes", async () => {
  const output = await checkout("web", { "checkout/shared/index.d.ts": "WORKING TREE" }, { "checkout/web/node_modules/@app/shared": "../../../shared" });
  assert.deepEqual(createDeclaredTrees().open(output).entry("@app/shared/index.d.ts"), { kind: "snapshot", path: "shared/index.d.ts" });
});

test("a link that stays inside the declared directory is followed, as a pnpm layout needs", async () => {
  const output = await checkout(
    "",
    { "checkout/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.d.ts": "export declare const pkg: 1;" },
    { "checkout/node_modules/pkg": ".pnpm/pkg@1.0.0/node_modules/pkg" },
  );
  assert.deepEqual(createDeclaredTrees().open(output).entry("pkg/index.d.ts"), { kind: "file", path: ".pnpm/pkg@1.0.0/node_modules/pkg/index.d.ts", content: "export declare const pkg: 1;" });
});

test("a cycle of links is refused instead of followed forever", async () => {
  const output = await checkout("", {}, { "checkout/node_modules/a": "b", "checkout/node_modules/b": "a" });
  assert.equal(createDeclaredTrees().open(output).entry("a/index.d.ts").kind, "refused");
});

test("a path that climbs out of the declared directory reads nothing", async () => {
  const output = await checkout("", { "checkout/index.d.ts": "export declare const repository: 1;" }, {});
  assert.deepEqual(createDeclaredTrees().open(output).entry("../index.d.ts"), { kind: "absent" });
});
