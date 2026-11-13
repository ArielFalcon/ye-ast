import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * Uses the index records no edge for: a read of a value through a member (`Code.First`), through `typeof` in a type, or a
 * name written in a constant's initializer. Each is a dependent at the declaration that writes it, never a declaration of
 * the file that does not write it.
 */
const SOURCES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, baseUrl: ".", paths: { "@app/*": ["src/app/*"] } } }),
  "src/app/router/server.routes.ts": "export const serverRoutes: string[] = ['a', 'b'];\n",
  "src/app/config.ts": "import { serverRoutes as routes } from './router/server.routes';\n\nexport const config = {\n  providers: [String(routes)],\n};\n",
  "src/app/codes.ts": "export enum Code {\n  First = 'FIRST',\n  Second = 'SECOND',\n}\n",
  "src/app/value-use.ts": "import { Code } from './codes';\n\nexport function pick(flag: boolean): string {\n  if (flag) throw new Error(Code.First);\n  return 'none';\n}\n",
  "src/app/class-use.ts": "import { Code } from './codes';\n\nexport class Reporter {\n  private readonly code = Code.First;\n\n  report(): string {\n    return Code.Second + this.code;\n  }\n}\n",
  "src/app/type-use.ts": "import { Code } from './codes';\n\nexport function describe(code: Code): string {\n  return String(code);\n}\n",
  "src/app/paths.ts": "export const Paths = { Home: 'home', User: 'user' } as const;\n\nexport type LocalPathValue = (typeof Paths)[keyof typeof Paths];\n\nexport { Paths as AllPaths };\n",
  "src/app/path-types.ts": "import { Paths } from './paths';\n\nexport type PathValue = (typeof Paths)[keyof typeof Paths];\n",
  "src/app/paths-use.ts": "import { Paths } from './paths';\n\nexport function unrelated(): number {\n  return 1;\n}\n\nexport function home(): string {\n  return Paths.Home;\n}\n",
  "src/app/paths.spec.ts": "import { Paths } from './paths';\n\nconsole.log(Paths.User);\n",
  "src/app/widget.ts": "export class Widget {\n  render(): string {\n    return 'w';\n  }\n}\n",
  "src/app/widgets.module.ts": "import { Widget } from './widget';\n\nfunction Module(options: { declarations: unknown[] }): ClassDecorator {\n  return () => undefined;\n}\n\n@Module({\n  declarations: [Widget],\n})\nexport class WidgetsModule {}\n",
  "src/app/widget-user.ts": "import { Widget } from './widget';\n\nexport class WidgetUser {\n  show(): string {\n    return new Widget().render();\n  }\n}\n",
  "src/app/router/index.ts": "export { serverRoutes } from './server.routes';\n",
  "src/app/barrel.config.ts": "import { serverRoutes } from '@app/router';\n\nexport const barrelConfig = { routes: String(serverRoutes) };\n",
  "src/app/flag.ts": "export const Flag = true;\n",
  "src/app/shadow.ts": "import { Flag } from './flag';\n\nexport function check(): boolean {\n  const Flag = false;\n  return Flag;\n}\n",
  "src/app/labels.ts": "import { Code } from './codes';\n\nexport function labels(): Record<string, number> {\n  return { Code: 1 };\n}\n",
};
const CHANGE = { "src/app/router/server.routes.ts": "export const serverRoutes: string[] = ['a', 'b', 'c'];\n" };

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
let repo: string;

async function commit(files: Record<string, string>, message: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-written-value-uses-"));
  scratchRoot = join(root, "scratch");
  repo = join(root, "repo");
  await mkdir(scratchRoot);
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(SOURCES, "fixture");
  await commit(CHANGE, "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Answer {
  status: string;
  value: ImpactValue;
}

async function callersOf(file: string, symbol: string): Promise<Answer> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "fixture", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return { status: result.value.status, value: result.value.value };
}

const dependents = (value: ImpactValue) => value.symbols.filter(({ depth }) => depth > 0).map(({ file, symbol, via }) => ({ file, symbol, basis: via?.basis, lines: via?.lines ?? [] }));

test("a member read of an enum inside a function, a method or a field's initializer is a dependent at its line, the field's at its class", async () => {
  const { status, value } = await callersOf("src/app/codes.ts", "Code");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [
    { file: "src/app/class-use.ts", symbol: "Reporter", basis: "reference", lines: [4] },
    { file: "src/app/class-use.ts", symbol: "report", basis: "reference", lines: [7] },
    { file: "src/app/type-use.ts", symbol: "describe", basis: "reference", lines: [3] },
    { file: "src/app/value-use.ts", symbol: "pick", basis: "reference", lines: [4] },
  ]);
});

test("a type alias that reads a value through typeof, in the value's file or another, is a dependent, and a function of the file that does not read it is none", async () => {
  const { status, value } = await callersOf("src/app/paths.ts", "Paths");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [
    { file: "src/app/path-types.ts", symbol: "PathValue", basis: "reference", lines: [3] },
    { file: "src/app/paths-use.ts", symbol: "home", basis: "reference", lines: [8] },
    { file: "src/app/paths.ts", symbol: "LocalPathValue", basis: "reference", lines: [3] },
  ]);
});

test("a name written in a constant's initializer, through an alias or a barrel, is a dependent at the constant, for callers and for the impact of a change", async () => {
  const callers = await callersOf("src/app/router/server.routes.ts", "serverRoutes");
  const change = await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "fixture", base: "HEAD~1", head: "HEAD" });
  assert.ok(change.ok && change.value.status !== "unknown", JSON.stringify(change));

  for (const { status, value } of [callers, { status: change.value.status, value: change.value.value }]) {
    assert.equal(status, "complete");
    assert.deepEqual(dependents(value), [
      { file: "src/app/barrel.config.ts", symbol: "barrelConfig", basis: "reference", lines: [3] },
      { file: "src/app/config.ts", symbol: "config", basis: "reference", lines: [4] },
    ]);
  }
});

test("a name written in a decorator's arguments is a dependent at the class it decorates, beside the class's other callers", async () => {
  const { status, value } = await callersOf("src/app/widget.ts", "Widget");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value).filter(({ file }) => file === "src/app/widgets.module.ts"), [{ file: "src/app/widgets.module.ts", symbol: "WidgetsModule", basis: "reference", lines: [8] }]);
  assert.ok(dependents(value).some(({ symbol }) => symbol === "WidgetUser"), JSON.stringify(value.symbols));
});

test("an import every use of which a local declaration shadows makes no dependent of the file that writes it", async () => {
  const { status, value } = await callersOf("src/app/flag.ts", "Flag");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), []);
});
