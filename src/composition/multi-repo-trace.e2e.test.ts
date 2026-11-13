import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeCli } from "./compose.ts";
import { EXIT_CODE } from "../cli/main.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";

type Query = (args: string[]) => Promise<TraceValue>;

/** A client whose base URL its configuration either provides or leaves undecided, a server, and a workspace manifest. */
async function withWorkspace(options: { providers: string; gateways: readonly { prefix: string; repo: string }[]; clientFiles?: Record<string, string> }, use: (paths: { client: string; server: string; manifest: string }, query: Query) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ye-ast-"));
  mkdirSync(join(root, "scratch"));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const repository = (name: string, files: Record<string, string>): string => {
    const path = join(root, name);
    mkdirSync(path);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), text);
    }
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path, env: gitEnv });
    execFileSync("git", ["add", "-A"], { cwd: path, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: path, env: gitEnv });
    return path;
  };
  try {
    const client = repository("client", {
      "package.json": JSON.stringify({ dependencies: { "@angular/core": "1", "@angular/platform-browser": "1", "@angular/common": "1" } }),
      "angular.json": JSON.stringify({ projects: { app: { root: "", architect: { build: { builder: "@angular/build:application", options: { browser: "src/main.ts" } } } } } }),
      "README.md": "A non-source listing record does not make the captured source incomplete.",
      "src/token.ts": "import { InjectionToken } from '@angular/core'; export const BASE = new InjectionToken<string>('base');",
      "src/config.ts": `import { BASE } from './token'; export const config = { providers: [${options.providers}] };`,
      "src/main.ts": "import { Component } from '@angular/core'; import { bootstrapApplication } from '@angular/platform-browser'; import { config } from './config'; @Component({ standalone: true, template: '' }) class App {} bootstrapApplication(App, config);",
      "src/api.ts": "import { Injectable, inject } from '@angular/core'; import { HttpClient } from '@angular/common/http'; import { BASE } from './token';\n@Injectable({providedIn: 'root'}) export class Api {\n private base = inject(BASE);\n constructor(private http: HttpClient) {}\n load(id: string) { return this.http.get(this.base + '/orders/' + id); }\n}\nexport function other() { return fetch('/health'); }",
      ...options.clientFiles,
    });
    const server = repository("server", { "Orders.java": `import org.springframework.web.bind.annotation.*;
@RestController
class Orders {
  @GetMapping("/orders/{id}")
  String get(@PathVariable String id) { return normalize(id); }
  String normalize(String id) { return id.trim(); }
  @GetMapping("/health")
  String health() { return "ok"; }
}` });
    const manifest = join(root, "workspace.json");
    writeFileSync(manifest, JSON.stringify({ repos: [{ path: server, id: "server", revision: "HEAD" }], gateways: options.gateways }));
    const run = composeCli({ scratchRoot: join(root, "scratch"), indexCache: join(root, "cache") });
    const query = async (args: string[]): Promise<TraceValue> => {
      const out: string[] = [], err: string[] = [];
      const code = await run(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
      assert.equal(code, EXIT_CODE.ok, err.join("\n"));
      const result = JSON.parse(out.join("\n"));
      assert.notEqual(result.status, "unknown");
      return result.value;
    };
    await use({ client, server, manifest }, query);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a workspace trace connects an executed client request to its producer handler without unrelated calls", async () => {
  await withWorkspace({ providers: "{ provide: BASE, useValue: 'https://example.test/api' }", gateways: [{ prefix: "api", repo: "server" }] }, async ({ client, server, manifest }, query) => {
    const traced = await query(["trace", client, "src/api.ts:Api.load", "--workspace", manifest, "--offline"]);
    assert.equal(traced.links?.length, 1, JSON.stringify(traced));
    const link = traced.links![0]!;
    assert.equal(link.to.repo, "server");
    assert.equal(link.to.name, "GET /orders/{id}");
    assert.equal(link.to.handler.path, "Orders.java");
    assert.equal(link.basis, "gateway-prefix");
    const producerSnapshot = traced.repositorySnapshots?.find(({ repo }) => repo === "server")?.snapshot;
    assert.ok(producerSnapshot?.kind === "sha");
    const producer = await query(["trace", server, `${link.to.handler.path}:${link.to.handler.symbol}`, "--revision", producerSnapshot.sha]);
    assert.ok(producer.steps.some(({ symbol }) => symbol === "normalize"));
    assert.equal(producer.links, undefined);
  });
});

test("a workspace trace links an executed request whose base URL is undecided, marked as such", async () => {
  await withWorkspace({ providers: "", gateways: [] }, async ({ client, manifest }, query) => {
    const traced = await query(["trace", client, "src/api.ts:Api.load", "--workspace", manifest, "--offline"]);
    assert.deepEqual(traced.links?.map(({ to, basis, authority }) => `${to.repo} ${to.name} ${basis} ${authority}`), ["server GET /orders/{id} suffix undecided"]);
  });
});

test("a route trace through an rxMethod store member returns the link its service trace returns, marked deferred", async () => {
  const clientFiles = {
    "package.json": JSON.stringify({ dependencies: { "@angular/core": "1", "@angular/platform-browser": "1", "@angular/common": "1", "@ngrx/signals": "20.0.0", rxjs: "7.8.0" } }),
    "src/store.ts": [
      "import { inject } from '@angular/core';",
      "import { signalStore, withMethods } from '@ngrx/signals';",
      "import { rxMethod } from '@ngrx/signals/rxjs-interop';",
      "import { pipe, switchMap } from 'rxjs';",
      "import { Api } from './api';",
      "export const OrderStore = signalStore({ providedIn: 'root' }, withMethods((store, api = inject(Api)) => ({",
      "  load: rxMethod<string>(pipe(switchMap((id) => api.load(id)))),",
      "})));",
    ].join("\n"),
    "src/page.ts": [
      "import { Component, inject } from '@angular/core';",
      "import { OrderStore } from './store';",
      "@Component({ standalone: true, template: '' })",
      "export class Page {",
      "  private store = inject(OrderStore);",
      "  open(id: string) { this.store.load(id); }",
      "}",
    ].join("\n"),
  };
  await withWorkspace({ providers: "", gateways: [], clientFiles }, async ({ client, manifest }, query) => {
    const service = await query(["trace", client, "src/api.ts:Api.load", "--workspace", manifest, "--offline"]);
    const page = await query(["trace", client, "src/page.ts:Page.open", "--workspace", manifest, "--offline"]);
    const ids = (value: TraceValue) => value.links?.map(({ id }) => id);
    assert.equal(service.links?.length, 1, JSON.stringify(service.links));
    assert.deepEqual(ids(page), ids(service));
    assert.deepEqual(service.links?.map((one) => one.deferred), [undefined]);
    assert.deepEqual(page.links?.map((one) => one.deferred), [true]);
  });
});
