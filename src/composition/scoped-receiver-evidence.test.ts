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

for (const variant of ["unrelated literal write and own call", "element write on a value of the receiver class", "initializer closure call", "build-time replacement of the receiver's file"] as const) {
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
      ...(variant === "build-time replacement of the receiver's file" ? { "angular.json": JSON.stringify({ projects: { app: { architect: { build: { configurations: { native: { fileReplacements: [{ replace: "src/api.ts", with: "src/api.native.ts" }] } } } } } } }) } : {}),
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
      const proven = variant !== "element write on a value of the receiver class" && variant !== "build-time replacement of the receiver's file";
      assert.equal(result.value.status, proven ? "complete" : "partial", JSON.stringify(result.value));
      assert.ok(result.value.value.symbols.some((symbol) => symbol.symbol === "run" && symbol.file === "src/page.ts"), JSON.stringify(result.value.value.symbols));
      const places = result.value.status === "partial" ? result.value.cuts.flatMap((cut) => cut.at) : [];
      assert.equal(places.some((place) => place.includes("this.api.load")), !proven, JSON.stringify(places));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const API = "import { Injectable } from '@angular/core';\n@Injectable({providedIn:'root'})\nexport class Api {\n load() { return 3; }\n}\n";
const PAGE = (template: string, body: string, imports = "") => `import { Component, inject, computed } from '@angular/core';\nimport { Api } from './api';\n${imports}@Component({selector:'app-page', template: ${JSON.stringify(template)} })\nexport class Page {\n api = inject(Api);\n${body}\n}\n`;
const PATCH_IMPORT = "import { patch } from './patch';\n";

async function loadCallers(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "ye-ast-passed-receiver-"));
  const repo = join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  try {
    await mkdir(join(root, "scratch"), { recursive: true });
    for (const [path, text] of Object.entries({ "package.json": JSON.stringify({ dependencies: { "@angular/core": "22.2.4" } }), "src/api.ts": API, ...files })) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo, env });
    const result = await composeQueries({ scratchRoot: join(root, "scratch") }).impact.callers({ repo, repoId: "passed", revision: "HEAD", targets: [{ file: "src/api.ts", symbol: "load" }] });
    assert.ok(result.ok, JSON.stringify(result));
    assert.notEqual(result.value.status, "unknown");
    if (result.value.status === "unknown") throw new Error("unknown");
    const places = result.value.status === "partial" ? result.value.cuts.flatMap((cut) => cut.at) : [];
    return { status: result.value.status, places, callers: result.value.value.symbols.map((symbol) => `${symbol.file}:${symbol.symbol}`) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [name, files, proven] of [
  ["a helper merges unknown keys into the receiver it is passed", { "src/patch.ts": "export function patch(target: object, changes: object) { Object.assign(target, changes); }\n", "src/page.ts": PAGE("", " run() { patch(this.api, {load: () => 2}); this.api.load(); }", PATCH_IMPORT) }, false],
  ["a helper writes an unknown key of the receiver it is passed", { "src/patch.ts": "export function patch(target: any, key: string, value: any) { target[key] = value; }\n", "src/page.ts": PAGE("", " run() { patch(this.api, 'load', () => 2); this.api.load(); }", PATCH_IMPORT) }, false],
  ["the receiver is passed only to a helper that writes nothing", { "src/patch.ts": "export function patch(target: object) { return String(target); }\n", "src/page.ts": PAGE("", " run() { patch(this.api); this.api.load(); }", PATCH_IMPORT) }, true],
  ["a template reads and calls the receiver while a helper writes unknown keys of other values", { "src/patch.ts": "export function patch(target: object, changes: object) { Object.assign(target, changes); }\n", "src/page.ts": PAGE("<p [title]=\"api.load() + api.name\" (click)=\"api.load()\">{{ api.load() }}</p>", " run() { patch({}, {load: () => 2}); this.api.load(); }", PATCH_IMPORT) }, true],
  ["a helper writes unknown keys of values it is passed, never the receiver", { "src/patch.ts": "export function patch(target: object, changes: object) { Object.assign(target, changes); }\n", "src/page.ts": PAGE("", " run() { patch({}, {load: () => 2}); this.api.load(); }", PATCH_IMPORT) }, true],
  ["a template passes the receiver to a method that writes its unknown keys", { "src/patch.ts": "export function patch(target: object, changes: object) { Object.assign(target, changes); }\n", "src/page.ts": PAGE("<button (click)=\"mutate(api)\"></button>", " changes = {};\n mutate(target: object) { patch(target, this.changes); }\n run() { this.api.load(); }", PATCH_IMPORT) }, false],
  ["another template assigns the receiver's member", { "src/page.ts": PAGE("", " run() { this.api.load(); }"), "src/editor.ts": PAGE("<button (click)=\"api.load = other\"></button>", " other = () => 2;").replace("Page", "Editor").replace("app-page", "app-editor") }, false],
  ["another template that holds the receiver does not parse", { "src/page.ts": PAGE("", " run() { this.api.load(); }"), "src/editor.ts": PAGE("<button (click)=\"api.load(\"></button>", "").replace("Page", "Editor").replace("app-page", "app-editor") }, false],
] as const) {
  test(`callers of an injected member when ${name}`, async () => {
    const { status, places, callers } = await loadCallers(files);
    assert.equal(status, proven ? "complete" : "partial", JSON.stringify(places));
    assert.equal(places.some((place) => place.endsWith("this.api.load")), !proven, JSON.stringify(places));
    assert.ok(callers.includes("src/page.ts:run"), JSON.stringify(callers));
  });
}

for (const [name, template, proven] of [
  ["assigns the member it calls", "<button (click)=\"api.load = other; api.load()\"></button>", false],
  ["assigns a member of the receiver's member", "<button (click)=\"api.load.x = other; api.load()\"></button>", true],
  ["assigns an unknown key of the receiver", "<button (click)=\"api[key] = other; api.load()\"></button>", false],
  ["assigns another literal key of the receiver", "<button (click)=\"api['other'] = other; api.load()\"></button>", true],
  ["assigns the field itself", "<button (click)=\"api = other; api.load()\"></button>", false],
  ["only calls the member", "<button (click)=\"other(); api.load()\"></button>", true],
] as const) {
  test(`a template call through an injected field when the template ${name}`, async () => {
    const { callers } = await loadCallers({ "src/page.ts": PAGE(template, " other = () => 2; key = 'load';") });
    assert.equal(callers.includes("src/page.ts:Page"), proven, JSON.stringify(callers));
  });
}
