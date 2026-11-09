import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Cut, Fact } from "../core/domain/shared/fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";

/**
 * ADR-0041 fixtures 7 to 9: written calls the index records nothing of reach `callers`, `impact` and trace through the
 * base's binding. codegraph records no call of a `signalStore(...)` initializer whose methods hold a member call broken
 * across lines (`api\n  .deleteComment(id)`), as in the realworld store the ADR measured. Fixtures 10 to 12 hold in the base's own
 * tests: codegraph records an unresolved reference for each of their calls in every shape tried.
 */
const java = (path: string, lines: readonly string[]): [string, string] => [`src/main/java/${path}`, `${lines.join("\n")}\n`];

const FILES: Record<string, string> = Object.fromEntries([
  ["package.json", JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0", "@ngrx/signals": "20.0.0", rxjs: "7.8.0" } })],
  ["src/api.ts", "export class Api {\n  getArticle(): string {\n    return 'a';\n  }\n\n  deleteComment(id: string): string {\n    return id;\n  }\n}\n\nexport function fetchArticle(): string {\n  return 'b';\n}\n"],
  ["src/box.ts", "export class Box {\n  get(id: string): string {\n    return id;\n  }\n\n  save(): void {\n    console.log('saved');\n  }\n}\n"],
  ["src/store.ts", "import { inject } from '@angular/core';\nimport { signalStore, withMethods, withState } from '@ngrx/signals';\nimport { rxMethod } from '@ngrx/signals/rxjs-interop';\nimport { pipe, switchMap } from 'rxjs';\nimport { Api } from './api';\n\ninterface State {\n  ready: boolean;\n}\n\nexport const Store = signalStore(\n  { providedIn: 'root' },\n  withState<State>({ ready: false }),\n  withMethods(\n    (\n      store,\n      api = inject(Api),\n    ) => ({\n      load: rxMethod<string>(\n        pipe(\n          switchMap((slug) => {\n            return api.getArticle();\n          }),\n        ),\n      ),\n      drop: (id: string) => api\n        .deleteComment(id),\n    }),\n  ),\n);\n"],
  ["src/aliased.ts", "import { inject } from '@angular/core';\nimport { signalStore, withMethods, withState } from '@ngrx/signals';\nimport { rxMethod } from '@ngrx/signals/rxjs-interop';\nimport { pipe, switchMap } from 'rxjs';\nimport { Api, fetchArticle as load } from './api';\nimport { Box as B } from './box';\n\ninterface State {\n  ready: boolean;\n}\n\nexport const Made = signalStore(\n  { providedIn: 'root' },\n  withState<State>({ ready: false }),\n  withMethods(\n    (\n      store,\n      api = inject(Api),\n    ) => ({\n      make: rxMethod<string>(\n        pipe(\n          switchMap(() => [load(), new B()]),\n        ),\n      ),\n      drop: (id: string) => api\n        .deleteComment(id),\n    }),\n  ),\n);\n"],
  ["src/fmt.ts", "export default function original(): string {\n  return 'f';\n}\n"],
  ["src/defaulted.ts", "import { inject } from '@angular/core';\nimport { signalStore, withMethods, withState } from '@ngrx/signals';\nimport { rxMethod } from '@ngrx/signals/rxjs-interop';\nimport { pipe, switchMap } from 'rxjs';\nimport renamed from './fmt';\nimport { Api } from './api';\n\ninterface State {\n  ready: boolean;\n}\n\nexport const Formatted = signalStore(\n  { providedIn: 'root' },\n  withState<State>({ ready: false }),\n  withMethods(\n    (\n      store,\n      api = inject(Api),\n    ) => ({\n      make: rxMethod<string>(\n        pipe(\n          switchMap(() => [renamed()]),\n        ),\n      ),\n      drop: (id: string) => api\n        .deleteComment(id),\n    }),\n  ),\n);\n"],
  java("p/A.java", ["package p;", "", "public class A {", "    public A(int a) {", "        System.out.println(a);", "    }", "", "    public A(int a, int b) {", "        System.out.println(a + b);", "    }", "}"]),
  java("p/B.java", ["package p;", "", "public class B extends A {", "    public B() {", "        super(1);", "    }", "", "    public B(String s) {", "        this();", "    }", "}"]),
  java("q/A.java", ["package q;", "", "public class A {", "    public A(int a) {", "        System.out.println(a);", "    }", "", "    public A(String a) {", "        System.out.println(a);", "    }", "}"]),
  java("q/B.java", ["package q;", "", "public class B extends A {", "    public B() {", "        super(1);", "    }", "}"]),
  java("r/R.java", ["package r;", "", "public record R(int a, int b) {", "    public R(int a) {", "        this(a, 0);", "    }", "", "    public R() {", "        this(1);", "    }", "}"]),
]);

/** `getArticle` and `A(int)` change, so `impact` walks from them as `callers` of them does. */
const CHANGED: Record<string, string> = {
  "src/api.ts": FILES["src/api.ts"]!.replace("return 'a';", "return 'changed';"),
};

let root: string;
let repo: string;
let scratchRoot: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

async function commit(files: Record<string, string>, message: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-recovered-calls-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(FILES, "fixture");
  await commit(CHANGED, "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function callersOf(target: { file: string; symbol: string } | { file: string; start: number; end: number }): Promise<Fact<ImpactValue>> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "recovered-calls", revision: "HEAD", targets: [target] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return result.value;
}

/** The dependents a call proves, by their declaration and the lines of the call. */
const dependents = (fact: Fact<ImpactValue>): string[] => (fact.status === "unknown" ? [] : fact.value.symbols.filter(({ depth, via }) => depth > 0 && via?.basis === "call").map(({ file, symbol, line, via }) => `${file}:${symbol}@${line}${via?.lines === undefined ? "" : ` L${via.lines.join(",")}`} ${via?.derivation ?? ""}`).sort());
const linkCuts = (fact: Fact<{}>): Cut[] => (fact.status === "partial" ? fact.cuts.filter(({ kind }) => kind === "unresolved-link") : []);

test("callers of a method lists the top-level constant whose initializer calls it inside a function value the index records nothing of, proven at the call's line (fixture 8)", async () => {
  const fact = await callersOf({ file: "src/api.ts", symbol: "Api.getArticle" });

  assert.deepEqual(dependents(fact), ["src/store.ts:Store@11 L22 proven"]);
});

test("callers of a function and of a class list the constant whose initializer calls them through import aliases (fixture 9)", async () => {
  assert.deepEqual(dependents(await callersOf({ file: "src/api.ts", symbol: "fetchArticle" })), ["src/aliased.ts:Made@12 L22 proven"]);
  assert.deepEqual(dependents(await callersOf({ file: "src/box.ts", symbol: "Box" })), ["src/aliased.ts:Made@12 L22 proven"]);
});

test("callers of a default-exported function list the constant whose initializer calls it under the name its default import gives it", async () => {
  assert.deepEqual(dependents(await callersOf({ file: "src/fmt.ts", symbol: "original" })), ["src/defaulted.ts:Formatted@12 L22 proven"]);
});

test("callers of a constructor lists the subclass constructor that chains to it by super(...) and the constructor that chains to that one by this(...), and of a record's constructor the one that chains by this(...) (fixture 7)", async () => {
  assert.deepEqual(dependents(await callersOf({ file: "src/main/java/p/A.java", start: 4, end: 6 })), ["src/main/java/p/B.java:B@4 L5 proven", "src/main/java/p/B.java:B@8 L9 proven"]);
  assert.deepEqual(dependents(await callersOf({ file: "src/main/java/r/R.java", start: 4, end: 6 })), ["src/main/java/r/R.java:R@8 L9 proven"]);
});

test("super(...) the signature reading does not settle at its arity is a cut at the call in callers, attributed to the superclass's constructors (fixture 7)", async () => {
  const fact = await callersOf({ file: "src/main/java/q/A.java", start: 4, end: 6 });

  assert.deepEqual(dependents(fact), []);
  assert.deepEqual(linkCuts(fact), [{ kind: "unresolved-link", at: ["src/main/java/q/A.java::A", "src/main/java/q/B.java:5 super"] }]);
});

test("impact of a changed method reaches the constant whose initializer calls it where the index records nothing", async () => {
  const result = await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "recovered-calls", base: "HEAD~1", head: "HEAD" });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));

  assert.ok(dependents(result.value).includes("src/store.ts:Store@11 L22 proven"), JSON.stringify(dependents(result.value)));
});

async function traceOf(file: string, symbol: string): Promise<Fact<TraceValue>> {
  const result = await composeQueries({ scratchRoot }).trace.walk({ repo, repoId: "recovered-calls", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return result.value;
}

const steps = (fact: Fact<TraceValue>) => (fact.status === "unknown" ? [] : fact.value.steps.map(({ symbol, file, line, at, deferred }) => `${file}:${symbol}@${line}${at === undefined ? "" : ` L${at.line}`}${deferred === true ? " deferred" : ""}`));

test("trace steps through constructor chaining, and is a cut listing the constructors where the arity does not settle it (fixture 7)", async () => {
  assert.deepEqual(steps(await traceOf("src/main/java/p/B.java", "B.B")).slice(0, 4), ["src/main/java/p/B.java:B@4", "src/main/java/p/A.java:A@4 L5", "src/main/java/p/B.java:B@8", "src/main/java/p/B.java:B@4 L9"]);
  const overloaded = await traceOf("src/main/java/q/B.java", "B.B");
  assert.ok(linkCuts(overloaded).some(({ at }) => at[0] === "src/main/java/q/B.java:5 super" && at.length === 3), JSON.stringify(linkCuts(overloaded)));
});

test("trace marks a call the index records nothing of inside a function value its body does not run deferred (fixture 8)", async () => {
  const fact = await traceOf("src/store.ts", "Store");
  assert.ok(fact.status !== "unknown");

  assert.deepEqual(fact.value.steps[0]?.leaves?.map(({ symbol, file, deferred }) => [symbol, file, deferred]), [["getArticle", "src/api.ts", true]]);
});
