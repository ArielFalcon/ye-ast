import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTreeWatch, defaultTreeWatchDeps } from "./tree-watch.adapter.ts";

test("a change deep under the root is reported by its root-relative path with / separators", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ye-ast-tree-watch-"));
  mkdirSync(join(root, "src", "app"), { recursive: true });
  try {
    const paths: (string | undefined)[] = [];
    const seen = new Promise<void>((settle, fail) => {
      const opened = createTreeWatch().watch(root, {
        changed: (path) => {
          paths.push(path);
          if (!path?.endsWith("App.java") || "fault" in opened) return;
          opened.close();
          settle();
        },
        failed: (fault) => fail(new Error(fault.code)),
      });
      if ("fault" in opened) fail(new Error(opened.fault.code));
    });
    let edits = 0;
    const write = (): void => writeFileSync(join(root, "src", "app", "App.java"), `class App {} // ${++edits}\n`);
    write();
    const rewriting = setInterval(write, 200);
    await seen.finally(() => clearInterval(rewriting));
    assert.equal(paths.at(-1), "src/app/App.java");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a watcher the platform refuses to open is a fault naming the platform's code, not a throw", () => {
  const refused = Object.assign(new Error("too many open files"), { code: "EMFILE" });
  const opened = createTreeWatch({ ...defaultTreeWatchDeps, watch: () => { throw refused; } }).watch("/nowhere", { changed: () => undefined, failed: () => undefined });
  assert.deepEqual("fault" in opened ? opened.fault.code : undefined, "EMFILE");
});

test("the watcher never holds the process open, including the per-directory watchers a platform without a native recursive watcher opens later", () => {
  const options: unknown[] = [];
  const watch = ((_root: string, opened: unknown) => {
    options.push(opened);
    return { on: () => undefined, unref: () => undefined, close: () => undefined };
  }) as unknown as typeof defaultTreeWatchDeps.watch;

  createTreeWatch({ ...defaultTreeWatchDeps, watch }).watch("/repo", { changed: () => undefined, failed: () => undefined });

  assert.deepEqual(options.map((one) => (one as { persistent?: boolean }).persistent), [false]);
});
