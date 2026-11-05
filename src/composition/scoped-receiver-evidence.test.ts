import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";

for (const variant of ["private record", "class alias provider", "escaped record"] as const) {
  test(`native member evidence distinguishes ${variant} across provider and mutation gates`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ye-ast-scoped-evidence-"));
    const repo = join(root, "repo");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
    const files = {
      "package.json": JSON.stringify({ dependencies: { "@angular/core": "22.2.4" } }),
      "src/store.ts": "import { Injectable } from '@angular/core'; @Injectable({ providedIn: 'root' }) export class Store { start() {} }",
      "src/owner.ts": "import { inject } from '@angular/core'; import { Store } from './store'; export function initialize() { inject(Store).start(); }",
      "src/tokens.ts": variant === "class alias provider"
        ? "import { Store } from './store'; export const OPTIONS = Store;"
        : "import { InjectionToken } from '@angular/core'; export const OPTIONS = new InjectionToken<string>('options');",
      "src/providers.ts": "import { OPTIONS } from './tokens'; export const providers = [{ provide: OPTIONS, useValue: 'ready' }];",
      "src/scratch.ts": `export function scratch() { const record = { __proto__: null }; record['entry'] = 1; ${variant === "escaped record" ? "return record;" : ""} }`,
    };
    try {
      await mkdir(repo);
      await mkdir(join(root, "scratch"));
      git("init", "-q", "-b", "main");
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), text);
      }
      git("add", ".");
      git("commit", "-qm", "fixture");
      const result = await composeQueries({ scratchRoot: join(root, "scratch") }).impact.callers({ repo, repoId: "scoped", revision: "HEAD", targets: [{ file: "src/store.ts", symbol: "start" }] });
      assert.ok(result.ok, JSON.stringify(result));
      assert.notEqual(result.value.status, "unknown");
      if (result.value.status === "unknown") return;
      const places = result.value.status === "partial" ? result.value.cuts.flatMap((cut) => cut.at) : [];
      const unresolvedInline = places.some((place) => place.includes("inject().start"));
      assert.equal(unresolvedInline, variant === "class alias provider", JSON.stringify(result.value));
      if (variant !== "class alias provider") assert.ok(result.value.value.symbols.some((symbol) => symbol.symbol === "initialize"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const variant of ["unrelated literal write and own call", "element write on a value of the receiver class", "initializer closure call"] as const) {
  test(`callers of an injected service member with an ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ye-ast-scoped-risks-"));
    const repo = join(root, "repo");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
    const files = {
      "package.json": JSON.stringify({ dependencies: { "@angular/core": "22.2.4" } }),
      "src/api.ts": "import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class Api {\n  load(): number { return 1; }\n  save(): void {}\n}\n",
      "src/page.ts": variant === "initializer closure call"
        ? "import { Component, computed, inject } from '@angular/core';\nimport { Api } from './api';\n@Component({ selector: 'app-page', template: '' })\nexport class Page {\n  private readonly api = inject(Api);\n  readonly run = computed(() => this.api.load());\n}\n"
        : "import { Component, inject } from '@angular/core';\nimport { Api } from './api';\n@Component({ selector: 'app-page', template: '' })\nexport class Page {\n  api = inject(Api);\n  run(): void { this.api.load(); }\n}\n",
      "src/editor.ts": "export class Editor { load(): void {} submit(): void { this.load(); } }\n",
      "src/util.ts": variant === "element write on a value of the receiver class"
        ? "import type { Api } from './api';\nexport function patch(api: Api, key: string): void { (api as any)[key] = 1; }\n"
        : "export function fill(): number[] { const a: number[] = []; a[0] = 1; return a; }\n",
    };
    try {
      await mkdir(repo);
      await mkdir(join(root, "scratch"));
      git("init", "-q", "-b", "main");
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), text);
      }
      git("add", ".");
      git("commit", "-qm", "fixture");
      const result = await composeQueries({ scratchRoot: join(root, "scratch") }).impact.callers({ repo, repoId: "risks", revision: "HEAD", targets: [{ file: "src/api.ts", symbol: "load" }] });
      assert.ok(result.ok, JSON.stringify(result));
      assert.notEqual(result.value.status, "unknown");
      if (result.value.status === "unknown") return;
      const proven = variant !== "element write on a value of the receiver class";
      assert.equal(result.value.status, proven ? "complete" : "partial", JSON.stringify(result.value));
      assert.ok(result.value.value.symbols.some((symbol) => symbol.symbol === "run" && symbol.file === "src/page.ts"), JSON.stringify(result.value.value.symbols));
      const places = result.value.status === "partial" ? result.value.cuts.flatMap((cut) => cut.at) : [];
      assert.equal(places.some((place) => place.includes("this.api.load")), !proven, JSON.stringify(places));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
