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
    writeFileSync(join(root, "src", "app", "App.java"), "class App {}\n");
    await seen;
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
