import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import { EDGE_POLICY } from "../core/domain/impact/edge-policy.ts";
import type { ImpactedSymbol, ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

/**
 * `Store` declares the only `get` and `save` of the repository, so the index matches every call of those names to it.
 * `RouteReader` calls `get` on a value of a package type, `persist` calls `save` on an unannotated parameter, and `Deep`
 * calls a `save` one link past its `Store` field: none of them is a call the sources bind to `Store`. `Typed` holds a
 * `Store` by a declared annotation, `useStore` by `inject()`, and `Escaping` by an injected field while it lets `this`
 * escape, so no syntax binds the receiver. `patch` writes `save` on an object no syntax places, so no member proof settles
 * a call of it. `parseAll` calls `parse` on a package's value, which the index matches to the one interface method
 * of that name. `Page`, the component of route `/page`, calls `RouteReader` through a declared annotation. `Plain` calls a
 * function, a static method and its own method.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0", "@angular/router": "20.0.0", "@angular/common": "20.0.0", zod: "3.0.0" } }),
  "src/store.ts": "export class Store {\n  readonly log: { save(value: string): void } = console as never;\n\n  get(key: string): string {\n    return key;\n  }\n\n  save(value: string): void {\n    console.log(value);\n  }\n}\n",
  "src/route-reader.ts": "import { ActivatedRoute } from '@angular/router';\n\nexport class RouteReader {\n  constructor(private route: ActivatedRoute) {}\n\n  id(): string | null {\n    return this.route.snapshot.paramMap.get('id');\n  }\n}\n",
  "src/saver.ts": "export function persist(target: any, value: string): void {\n  target.save(value);\n}\n",
  "src/deep.ts": "import { Injectable } from '@angular/core';\nimport { Store } from './store';\n\n@Injectable()\nexport class Deep {\n  constructor(private store: Store) {}\n\n  run(): void {\n    this.store.log.save('x');\n  }\n}\n",
  "src/typed.ts": "import { Store } from './store';\n\nexport class Typed {\n  constructor(private store: Store) {}\n\n  read(): string {\n    return this.store.get('a');\n  }\n}\n",
  "src/injected.ts": "import { inject } from '@angular/core';\nimport { Store } from './store';\n\nexport function useStore(): void {\n  const store = inject(Store);\n  store.save('b');\n}\n",
  "src/escaping.ts": "import { Injectable } from '@angular/core';\nimport { Store } from './store';\n\n@Injectable()\nexport class Escaping {\n  constructor(private store: Store) {\n    register(this);\n  }\n\n  flush(): void {\n    this.store.save('d');\n  }\n}\n\nfunction register(owner: unknown): void {\n  console.log(owner);\n}\n",
  "src/parser.ts": "export interface Parser {\n  parse(input: string): number;\n}\n",
  "src/use-parser.ts": "import { schema } from 'zod';\n\nconst parser = schema();\n\nexport function parseAll(): number {\n  return parser.parse('1');\n}\n",
  "src/patch.ts": "export function patch(target: { save?: unknown }): void {\n  target.save = () => undefined;\n}\n",
  "src/main.ts": "import { provideRouter } from '@angular/router';\nimport { routes } from './app.routes';\n\nexport const appConfig = { providers: [provideRouter(routes)] };\n",
  "src/page.ts": "import { Component } from '@angular/core';\nimport { RouteReader } from './route-reader';\n\n@Component({ selector: 'app-page', template: '' })\nexport class Page {\n  constructor(private reader: RouteReader) {}\n\n  show(): string | null {\n    return this.reader.id();\n  }\n}\n",
  "src/app.routes.ts": "import { Routes } from '@angular/router';\nimport { Page } from './page';\n\nexport const routes: Routes = [{ path: 'page', component: Page }];\n",
  "src/helpers.ts": "export function helper(): number {\n  return 1;\n}\n\nexport class Util {\n  static make(): number {\n    return 2;\n  }\n}\n",
  "src/plain.ts": "import { helper, Util } from './helpers';\n\nexport class Plain {\n  run(): number {\n    return helper() + Util.make() + this.own();\n  }\n\n  own(): number {\n    return 3;\n  }\n}\n",
};

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-edge-derivation-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function callersOf(file: string, symbol: string): Promise<ImpactValue> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "edge-derivation", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok, JSON.stringify(result));
  const answer: Fact<ImpactValue> = result.value;
  assert.ok(answer.status !== "unknown", JSON.stringify(answer));
  return answer.value;
}

function reached(value: ImpactValue, file: string, symbol: string): ImpactedSymbol | undefined {
  return value.symbols.find((candidate) => candidate.file === file && candidate.symbol === symbol);
}

const NAME_MATCH = EDGE_POLICY.unscoredHeuristicConfidence;

test("a call two links past a field of a package type, matched to a repository method by its name, is a name match", async () => {
  const value = await callersOf("src/store.ts", "get");

  assert.deepEqual(pick(reached(value, "src/route-reader.ts", "id")), { confidence: NAME_MATCH, derivation: "name-match" });
});

test("a call on a parameter the index matched to the only method of its name is a name match", async () => {
  const value = await callersOf("src/store.ts", "save");

  assert.deepEqual(pick(reached(value, "src/saver.ts", "persist")), { confidence: NAME_MATCH, derivation: "name-match" });
});

test("a call on a value the index matched to the only interface method of its name is a name match", async () => {
  const value = await callersOf("src/parser.ts", "parse");

  assert.deepEqual(pick(reached(value, "src/use-parser.ts", "parseAll")), { confidence: NAME_MATCH, derivation: "name-match" });
});

test("a call on a field whose declared annotation names the method's class is proven", async () => {
  const value = await callersOf("src/store.ts", "get");

  assert.deepEqual(pick(reached(value, "src/typed.ts", "read")), { confidence: 1, derivation: "proven" });
});

test("a call on a local an inject() call initializes with the method's class is proven", async () => {
  const value = await callersOf("src/store.ts", "save");

  assert.deepEqual(pick(reached(value, "src/injected.ts", "useStore")), { confidence: 1, derivation: "proven" });
});

test("a call on an injected field of the method's class is proven where the class lets `this` escape", async () => {
  const value = await callersOf("src/store.ts", "save");

  assert.deepEqual(pick(reached(value, "src/escaping.ts", "flush")), { confidence: 1, derivation: "proven" });
});

test("a field that holds the method's class proves nothing about a call one link past it, which stays a name match", async () => {
  const value = await callersOf("src/store.ts", "save");

  assert.deepEqual(pick(reached(value, "src/deep.ts", "run")), { confidence: NAME_MATCH, derivation: "name-match" });
});

test("what is reached only through a name match is no surer than the match, however sure the steps after it", async () => {
  const value = await callersOf("src/store.ts", "get");

  assert.deepEqual(pick(reached(value, "src/page.ts", "show")), { confidence: NAME_MATCH, derivation: "proven" });
  assert.deepEqual(value.entrypoints.map(({ name, confidence }) => ({ name, confidence })), [{ name: "/page", confidence: NAME_MATCH }]);
});

test("a call of a function, of a static method and of the class's own method stays resolved at the index's score", async () => {
  for (const [file, symbol] of [["src/helpers.ts", "helper"], ["src/helpers.ts", "make"], ["src/plain.ts", "own"]] as const) {
    const run = reached(await callersOf(file, symbol), "src/plain.ts", "run");
    assert.equal(run?.via?.derivation, "resolved", symbol);
    assert.ok(run !== undefined && run.confidence > NAME_MATCH, symbol);
  }
});

function pick(symbol: ImpactedSymbol | undefined): { confidence: number; derivation: unknown } | undefined {
  return symbol === undefined ? undefined : { confidence: symbol.confidence, derivation: symbol.via?.derivation };
}
