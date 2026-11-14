import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0", "@ngrx/signals": "20.0.0" } }),
  "src/owner-service.ts": ["export class OwnerService {", "  getOwnerById(id: string): string {", "    return id;", "  }", "}", ""].join("\n"),
  "src/detail.ts": [
    "import { rxResource } from '@angular/core/rxjs-interop';",
    "import { OwnerService } from './owner-service';",
    "",
    "export class Detail {",
    "  private readonly ownerService = new OwnerService();",
    "  private readonly ownerResource = rxResource({",
    "    params: () => ({ id: 'x' }),",
    "    stream: ({ params }) => this.ownerService.getOwnerById(params.id),",
    "  });",
    "}",
    "",
  ].join("\n"),
  "src/page.ts": ["import { Detail } from './detail';", "", "export class Page {", "  readonly detail = new Detail();", "}", ""].join("\n"),
  "src/top.ts": ["declare function register(handlers: object): void;", "", "register({", "  handler() {", "    return 1;", "  },", "});", ""].join("\n"),
  "src/plugin.ts": ["export default {", "  name: 'p',", "  setup(build: { value: number }) {", "    return build.value + 1;", "  },", "};", ""].join("\n"),
  "src/calls-handler.ts": ["export function run(target: { handler(): number }): number {", "  return target.handler();", "}", ""].join("\n"),
  "src/same-name-store.ts": [
    "import { inject } from '@angular/core';",
    "import { signalStore, withMethods } from '@ngrx/signals';",
    "import { rxMethod } from '@ngrx/signals/rxjs-interop';",
    "import { pipe, switchMap } from 'rxjs';",
    "import { OwnerService } from './owner-service';",
    "",
    "export const SameNameStore = signalStore(",
    "  { providedIn: 'root' },",
    "  withMethods((store, api = inject(OwnerService)) => ({",
    "    getOwnerById: rxMethod<string>(",
    "      pipe(",
    "        switchMap((id) => api.getOwnerById(id)),",
    "      ),",
    "    ),",
    "  })),",
    ");",
    "",
  ].join("\n"),
  "src/store.ts": [
    "import { inject } from '@angular/core';",
    "import { signalStore, withMethods } from '@ngrx/signals';",
    "import { rxMethod } from '@ngrx/signals/rxjs-interop';",
    "import { pipe, switchMap } from 'rxjs';",
    "import { OwnerService } from './owner-service';",
    "",
    "export const Store = signalStore(",
    "  { providedIn: 'root' },",
    "  withMethods(",
    "    (store, api = inject(OwnerService)) => ({",
    "      load: rxMethod<string>(",
    "        pipe(",
    "          switchMap((id) => api.getOwnerById(id)),",
    "        ),",
    "      ),",
    "      other: () => 1,",
    "    }),",
    "  ),",
    ");",
    "",
  ].join("\n"),
  "src/uses-load.ts": ["import { inject } from '@angular/core';", "import { Store } from './store';", "", "export class UsesLoad {", "  readonly store = inject(Store);", "  go() {", "    return this.store.load('a');", "  }", "}", ""].join("\n"),
  "src/uses-other.ts": ["import { inject } from '@angular/core';", "import { Store } from './store';", "", "export class UsesOther {", "  readonly store = inject(Store);", "  go() {", "    return this.store.other();", "  }", "}", ""].join("\n"),
};

let root: string;
let repo: string;
let scratchRoot: string;
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-syntax-only-owner-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env: ENV });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function callersOf(target: { file: string; symbol: string } | { file: string; start: number; end: number }): Promise<Fact<ImpactValue>> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "syntax-only-owner", revision: "HEAD", targets: [target] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return result.value;
}

const names = (fact: Fact<ImpactValue>, file: string): string[] => (fact.status === "unknown" ? [] : fact.value.symbols.filter((symbol) => symbol.file === file).map(({ symbol }) => symbol).sort());

test("callers of a declaration a store member calls list the member and not the users of the store (ADR-0093)", async () => {
  const fact = await callersOf({ file: "src/owner-service.ts", symbol: "OwnerService.getOwnerById" });
  assert.ok(fact.status !== "unknown");

  assert.deepEqual(names(fact, "src/store.ts"), ["Store", "load"]);
  assert.deepEqual(names(fact, "src/uses-other.ts"), []);
  assert.deepEqual(names(fact, "src/uses-load.ts"), []);
  const member = fact.value.symbols.find(({ symbol }) => symbol === "load");
  assert.deepEqual([member?.depth, member?.via?.basis, member?.via?.lines], [1, "call", [13]]);
  assert.ok(fact.status === "partial" && fact.cuts.some(({ reason, at }) => reason === "receiver-unproven" && at.includes("src/store.ts:11 Store.load")), JSON.stringify(fact.status === "partial" ? fact.cuts : []));
});

test("a request over the lines of a call written in a callable handed to a framework reaches what the request over the symbol it calls reaches (ADR-0093)", async () => {
  const byLines = await callersOf({ file: "src/detail.ts", start: 8, end: 8 });
  const bySymbol = await callersOf({ file: "src/owner-service.ts", symbol: "OwnerService.getOwnerById" });

  assert.equal(byLines.status, "complete");
  assert.deepEqual(names(byLines, "src/detail.ts").filter((name) => name !== "stream"), names(bySymbol, "src/detail.ts"));
});

test("a callable only a library calls has no repository caller and cuts nothing, as an indexed declaration nobody calls (ADR-0093)", async () => {
  const fact = await callersOf({ file: "src/plugin.ts", start: 4, end: 4 });

  assert.equal(fact.status, "complete", JSON.stringify(fact));
});

test("a syntax seed no holder names and no declaration contains is read by the uses of its name, whose unproven receivers are cut (ADR-0093)", async () => {
  const fact = await callersOf({ file: "src/top.ts", start: 5, end: 5 });

  assert.ok(fact.status === "partial", JSON.stringify(fact));
  assert.ok(fact.cuts.some(({ reason, at }) => reason === "receiver-unproven" && at.some((place) => place.startsWith("src/calls-handler.ts:2"))), JSON.stringify(fact.cuts));
  assert.deepEqual(fact.cuts.filter(({ reason }) => reason === "no-symbols"), []);
});

test("a call the base binds to another declaration is no use of a member that shares its name (ADR-0093)", async () => {
  const fact = await callersOf({ file: "src/owner-service.ts", symbol: "OwnerService.getOwnerById" });

  assert.ok(fact.status === "partial");
  assert.deepEqual(names(fact, "src/same-name-store.ts"), ["SameNameStore", "getOwnerById"]);
  assert.deepEqual(fact.cuts.filter(({ reason, at }) => reason === "receiver-unproven" && at.some((place) => place.startsWith("src/same-name-store.ts"))), []);
});
