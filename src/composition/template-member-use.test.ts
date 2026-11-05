import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

const CORE = "import { Component, inject, signal } from '@angular/core';\n";
const page = (name: string, selector: string, template: string, body: string, imports = "import { ArchiveApi } from './archive.api';\n"): string =>
  `${CORE}${imports}\n@Component({ selector: '${selector}', ${template} })\nexport class ${name} {\n${body}\n}\n`;

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "22.0.0", "@angular/router": "22.0.0", "@angular/common": "22.0.0", "@angular/platform-browser": "22.0.0" } }),
  "src/main.ts": "import { bootstrapApplication } from '@angular/platform-browser';\nimport { provideRouter } from '@angular/router';\nimport { routes } from './app/app.routes';\nimport { ArchivePage } from './app/archive.page';\n\nbootstrapApplication(ArchivePage, { providers: [provideRouter(routes)] });\n",
  "src/app/app.routes.ts": [
    "import { Routes } from '@angular/router';",
    ...["ArchivePage:archive", "ReportPage:report", "LetPage:let", "ForPage:for", "RefPage:ref", "NewPage:new", "CallablePage:callable", "OverloadPage:overload", "ThisPage:this", "WritePage:write", "ClassWritePage:class-write"].map((entry) => {
      const [name, file] = entry.split(":");
      return `import { ${name} } from './${file}.page';`;
    }),
    "",
    "export const routes: Routes = [",
    "  { path: 'archive', component: ArchivePage },",
    "  { path: 'report', component: ReportPage },",
    "  { path: 'let', component: LetPage },",
    "  { path: 'for', component: ForPage },",
    "  { path: 'ref', component: RefPage },",
    "  { path: 'new', component: NewPage },",
    "  { path: 'callable', component: CallablePage },",
    "  { path: 'overload', component: OverloadPage },",
    "  { path: 'this', component: ThisPage },",
    "  { path: 'write', component: WritePage },",
    "  { path: 'class-write', component: ClassWritePage },",
    "];",
    "",
  ].join("\n"),
  "src/app/archive.api.ts": "import { Injectable } from '@angular/core';\n\n@Injectable({ providedIn: 'root' })\nexport class ArchiveApi {\n  archive(): void {\n    console.log('archive');\n  }\n}\n",
  "src/app/callable.api.ts": "import { Injectable, signal } from '@angular/core';\n\n@Injectable({ providedIn: 'root' })\nexport class CallableApi {\n  items = signal<string[]>([]);\n  archive = (): void => {\n    console.log('archive');\n  };\n}\n",
  "src/app/overload.api.ts": "import { Injectable } from '@angular/core';\n\n@Injectable({ providedIn: 'root' })\nexport class OverloadApi {\n  archive(id: string): void;\n  archive(id?: string): void {\n    console.log(id);\n  }\n}\n",
  "src/app/archive.page.ts": page("ArchivePage", "app-archive", `template: '<button (click)="api.archive()">Archive</button>'`, "  api = inject(ArchiveApi);"),
  "src/app/report.page.ts": page("ReportPage", "app-report", "templateUrl: './report.page.html'", "  api = inject(ArchiveApi);"),
  "src/app/report.page.html": "<h1>Report</h1>\n<button (click)=\"api.archive()\">Archive</button>\n",
  "src/app/let.page.ts": page("LetPage", "app-let", `template: '@let api = other; <button (click)="api.archive()">Archive</button>'`, "  api = inject(ArchiveApi);\n  other = { archive: (): void => undefined };"),
  "src/app/for.page.ts": page("ForPage", "app-for", `template: '@for (api of others; track api) { <button (click)="api.archive()">Archive</button> }'`, "  api = inject(ArchiveApi);\n  others = [{ archive: (): void => undefined }];"),
  "src/app/ref.page.ts": page("RefPage", "app-ref", `template: '<input #api /><button (click)="api.archive()">Archive</button>'`, "  api = inject(ArchiveApi);"),
  "src/app/this.page.ts": page("ThisPage", "app-this", `template: '<button (click)="this.api.archive()">Archive</button>'`, "  api = inject(ArchiveApi);"),
  "src/app/write.page.ts": page("WritePage", "app-write", `template: '<button (click)="api.archive(); api = other">Archive</button>'`, "  api = inject(ArchiveApi);\n  other = inject(ArchiveApi);"),
  "src/app/class-write.page.ts": page("ClassWritePage", "app-class-write", `template: '<button (click)="api.archive()">Archive</button>'`, "  api = inject(ArchiveApi);\n  reset(): void { delete this.api; }"),
  "src/app/new.page.ts": page("NewPage", "app-new", `template: '<button (click)="api.archive()">Archive</button>'`, "  api = new ArchiveApi();"),
  "src/app/callable.page.ts": page("CallablePage", "app-callable", `template: '<button (click)="api.archive()">{{ api.items() }}</button>'`, "  api = inject(CallableApi);", "import { CallableApi } from './callable.api';\n"),
  "src/app/overload.page.ts": page("OverloadPage", "app-overload", `template: '<button (click)="api.archive()">Archive</button>'`, "  api = inject(OverloadApi);", "import { OverloadApi } from './overload.api';\n"),
};

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-template-member-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  await mkdir(repo);
  await mkdir(scratchRoot);
  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
  await writeFile(join(repo, "src/app/archive.api.ts"), FILES["src/app/archive.api.ts"]!.replace("console.log('archive');", "console.log('archived');"));
  git("commit", "-qam", "change archive");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const answers = new Map<string, Promise<Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>>>();

async function callersOf(file: string, symbol: string): Promise<ImpactValue> {
  const key = `${file}:${symbol}`;
  if (!answers.has(key)) answers.set(key, composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "template-member", revision: "HEAD", targets: [{ file, symbol }] }));
  const result = (await answers.get(key))!;
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.status, "complete", JSON.stringify(result.value));
  if (result.value.status !== "complete") throw new Error("unreachable");
  return result.value.value;
}

const callerNames = (value: ImpactValue): string[] => value.symbols.map((symbol) => symbol.symbol);
const entrypointNames = (value: ImpactValue): (string | undefined)[] => value.entrypoints.map((entrypoint) => entrypoint.name);

test("a template call through an injected field reaches the component and its route, with the template as evidence", async () => {
  const value = await callersOf("src/app/archive.api.ts", "archive");
  const inline = value.symbols.find((symbol) => symbol.symbol === "ArchivePage");
  assert.deepEqual(inline?.via, { file: "src/app/archive.api.ts", symbol: "archive", lines: [4], basis: "call" });
  const external = value.symbols.find((symbol) => symbol.symbol === "ReportPage");
  assert.deepEqual(external?.via, { file: "src/app/archive.api.ts", symbol: "archive", resource: "src/app/report.page.html", lines: [2], basis: "call" });
  assert.ok(entrypointNames(value).includes("/archive"), JSON.stringify(value.entrypoints));
  assert.ok(entrypointNames(value).includes("/report"), JSON.stringify(value.entrypoints));
  assert.ok(callerNames(value).includes("ThisPage"), JSON.stringify(value.symbols));
});

test("the impact of a change to a template-called member names the component and its route", async () => {
  const result = await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "template-member", base: "HEAD~1", head: "HEAD" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.status, "complete", JSON.stringify(result.value));
  if (result.value.status !== "complete") return;
  assert.ok(callerNames(result.value.value).includes("ArchivePage"), JSON.stringify(result.value.value.symbols));
  assert.ok(entrypointNames(result.value.value).includes("/archive"), JSON.stringify(result.value.value.entrypoints));
});

for (const [control, component] of [
  ["a top-level @let shadows the field", "LetPage"],
  ["an @for variable shadows the field", "ForPage"],
  ["a template reference shadows the field", "RefPage"],
  ["a field constructed with new is no injection", "NewPage"],
  ["the template assigns the field", "WritePage"],
  ["the class deletes the field", "ClassWritePage"],
] as const) {
  test(`no reach is claimed when ${control}`, async () => {
    const value = await callersOf("src/app/archive.api.ts", "archive");
    assert.ok(callerNames(value).includes("ArchivePage"));
    assert.ok(!callerNames(value).includes(component), JSON.stringify(value.symbols));
  });
}

test("no reach is claimed through a callable field of the receiver", async () => {
  const value = await callersOf("src/app/callable.api.ts", "archive");
  assert.ok(!callerNames(value).includes("CallablePage"), JSON.stringify(value.symbols));
});

test("no reach is claimed for a member the receiver declares more than once", async () => {
  const value = await callersOf("src/app/overload.api.ts", "archive");
  assert.ok(!callerNames(value).includes("OverloadPage"), JSON.stringify(value.symbols));
});
