import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * Uses the index records no edge for: a read of a value through a member (`Code.First`), through `typeof` in a type, a
 * name written in a constant's initializer, or in a file's top-level statements. Each is a dependent at the declaration
 * that writes it, or at the file for a statement outside every declaration, never a declaration of the file that does
 * not write it.
 */
const SOURCES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { "@angular/core": "21.0.0", "@angular/router": "21.0.0" } }),
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
  "src/app/module.ts": "export class AppModule {}\n\nexport function noop(): void {}\n\nconsole.log(AppModule.name);\n\nexport default AppModule.name;\n",
  "src/app/main.ts": "import { AppModule } from './module';\n\nconsole.log(String(AppModule));\n",
  "src/app/server.ts": "import { AppModule } from './module';\n\nexport function helper(): number {\n  return 1;\n}\n\nconsole.log([AppModule].length);\n",
  "src/app/made.ts": "import { AppModule } from './module';\n\nfunction make(value: unknown): unknown {\n  return value;\n}\n\nexport default make(AppModule);\n",
  "src/app/loader.ts": "import './main';\n\nexport function load(): number {\n  return 1;\n}\n",
  "src/app/theme.ts": "export const Theme = 'dark';\n",
  "src/app/theme-index.ts": "import { Theme } from './theme';\n\nexport function other(): number {\n  return 1;\n}\n\nexport { Theme };\nexport type { Theme as ThemeName };\nexport default Theme;\n",
  "src/app/marker.ts": "export const Marker = 1;\n",
  "src/app/host.component.ts": "import { Component, Inject } from '@angular/core';\nimport { Marker } from './marker';\n\n@Component({ selector: 'app-host', template: '<p>host</p>' })\nexport class HostComponent {\n  constructor(@Inject(TOKEN) other: unknown) {}\n}\n\nconsole.log(String(Marker));\n",
  "src/app/app.routes.ts": "import { Routes } from '@angular/router';\nimport { Marker } from './marker';\n\nfunction pick(): any {\n  return undefined;\n}\n\nexport const routes: Routes = [{ path: 'page', component: pick() }];\n\nconsole.log(Marker);\n",
  "src/app/level.ts": "export const Level = 3;\n",
  "src/app/level-use.ts": "import { Level } from './level';\n\nexport function scale(Level: number): number {\n  return Level * 2;\n}\n",
  "src/app/status.ts": "export enum Status {\n  On = 'ON',\n  Off = 'OFF',\n}\n\nexport const Limits = { Max: 3 } as const;\n",
  "src/app/status-use.ts": "import * as st from './status';\n\nexport function on(): string {\n  return st.Status.On;\n}\n\nexport function limit(): number {\n  return st.Limits.Max;\n}\n\nconsole.log(st.Status.Off);\n",
  "src/app/states/index.ts": "export * from '../status';\n",
  "src/app/states-alias.ts": "export { Status as State } from './status';\n",
  "src/app/local-states.ts": "import { Status } from './status';\n\nexport { Status };\n",
  "src/app/status-barrels.ts": "import * as all from './states';\nimport * as alias from './states-alias';\nimport * as local from './local-states';\n\nexport function viaStar(): string {\n  return all.Status.On;\n}\n\nexport function viaAlias(): string {\n  return alias.State.Off;\n}\n\nexport function viaLocal(): string {\n  return local.Status.On;\n}\n",
  "src/app/status-tagged.ts": "import * as st from './status';\n\nfunction Tag(value: unknown): ClassDecorator {\n  return () => undefined;\n}\n\n@Tag(st.Status.On)\nexport class Tagged {}\n",
  "src/app/status-shadow.ts": "import * as st from './status';\n\nexport function shadowed(): string {\n  const st = { Status: { On: 'x' } };\n  return st.Status.On;\n}\n",
  "src/app/shadowing-states.ts": "export * from './status';\n\nexport const Status = { On: 'local' };\n",
  "src/app/status-local.ts": "import * as mine from './shadowing-states';\nimport { Holder } from './holder';\n\nexport function local(): string {\n  return mine.Status.On;\n}\n\nexport function property(): unknown {\n  return Holder.mine;\n}\n",
  "src/app/holder.ts": "export const Holder = { mine: 1 };\n",
  "src/app/tokens.ts": "export const Token = 'T';\n",
  "src/app/token-space.ts": "export * as tokens from './tokens';\n",
  "src/app/token-space-use.ts": "import { tokens } from './token-space';\n\nexport function read(): string {\n  return tokens.Token;\n}\n",
  "src/app/tokens.spec.ts": "import * as tk from './tokens';\n\nconsole.log(tk);\n",
  "src/app/kinds.ts": "export const Limit = 3;\n\nexport type Mode = 'a' | 'b';\n\nexport interface Shape {\n  side: number;\n}\n\nexport class Box {\n  open(): void {}\n}\n",
  "src/app/kit.ts": "export * from './kinds';\nexport * from '@angular/core';\n",
  "src/app/kind-shapes.ts": "import { Shape } from './kinds';\n\nexport { Shape };\n",
  "src/app/kind-uses.ts": "import * as k from './kinds';\nimport * as kit from './kit';\nimport * as shapes from './kind-shapes';\nexport function area(shape: k.Shape, mode: k.Mode): number {\n  return shape.side;\n}\n\nexport type LimitType = typeof k.Limit;\n\nexport function make(): unknown {\n  return new kit.Box();\n}\n\nexport function marker(): unknown {\n  return kit.Component;\n}\n\nconsole.log(shapes);\n",
  "src/app/marks.ts": "export const Mark = 'm';\n",
  "src/app/mark-uses.ts": "import * as mk from './marks';\n\nexport function first(): string {\n  return mk.Mark;\n}\n\nexport function labels(): unknown {\n  return { mk: 1 };\n}\n\nexport type Keyed = { mk?: number };\n",
  "src/app/sizes.ts": "const Small = 1;\n\nexport { Small as Tiny };\n\nexport default function large(): number {\n  return 2;\n}\n",
  "src/app/size-names.ts": "import { Tiny } from './sizes';\n\nexport { Tiny as Least, Tiny as 'Wee' };\n",
  "src/app/size-reader.ts": "import { Tiny } from './sizes';\n\nconsole.log(Tiny);\n",
  "src/app/size-uses.ts": "import * as sz from './sizes';\nimport * as names from './size-names';\nimport * as reads from './size-reader';\n\nexport function tiny(): number {\n  return sz.Tiny;\n}\n\nexport function least(): number {\n  return names.Least;\n}\n\nexport function wee(): number {\n  return names.Wee;\n}\n\nexport function pick(): unknown {\n  return sz.default;\n}\n\nconsole.log(reads);\n",
  "src/app/token-uses.ts": "import * as tk from './tokens';\n\nfunction use(value: unknown): unknown {\n  return value;\n}\n\nexport function pass(key: 'Token'): unknown {\n  return [tk[key], use(tk)];\n}\n\nexport { tk };\n",
};
const CHANGE = { "src/app/router/server.routes.ts": "export const serverRoutes: string[] = ['a', 'b', 'c'];\n" };
const STATUS_CHANGE = { "src/app/status.ts": "export enum Status {\n  On = 'ON',\n  Off = 'OFF',\n  Idle = 'IDLE',\n}\n\nexport const Limits = { Max: 3 } as const;\n" };

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
  await commit(STATUS_CHANGE, "status change");
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
  const change = await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "fixture", base: "HEAD~2", head: "HEAD~1" });
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

test("a use in a file's top-level statements, of an imported declaration or of one of the same file, makes the file the dependent at the lines of the use, and no declaration of the file that does not write it", async () => {
  const { status, value } = await callersOf("src/app/module.ts", "AppModule");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [
    { file: "src/app/made.ts", symbol: "made.ts", basis: "reference", lines: [7] },
    { file: "src/app/main.ts", symbol: "main.ts", basis: "reference", lines: [3] },
    { file: "src/app/module.ts", symbol: "module.ts", basis: "reference", lines: [5, 7] },
    { file: "src/app/server.ts", symbol: "server.ts", basis: "reference", lines: [7] },
  ]);
  const main = value.symbols.find(({ file, depth }) => file === "src/app/main.ts" && depth > 0);
  assert.deepEqual(main && { kind: main.kind, line: main.line, endLine: main.endLine, fanIn: main.fanIn, derivation: main.via?.derivation }, { kind: "file", line: 1, endLine: 4, fanIn: 0, derivation: "proven" });
});

test("a file a top-level use names as a dependent leads nowhere: what imports the file is not its dependent", async () => {
  const { value } = await callersOf("src/app/module.ts", "AppModule");

  assert.ok(value.symbols.some(({ file }) => file === "src/app/main.ts"), JSON.stringify(value.symbols));
  assert.deepEqual(value.symbols.filter(({ file }) => file === "src/app/loader.ts"), []);
});

test("an export statement that only re-exposes an imported name writes no dependence of its file, nor stands a declaration of the file in for it", async () => {
  const { status, value } = await callersOf("src/app/theme.ts", "Theme");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), []);
});

test("a file a top-level use names as a dependent reaches no entrypoint of its own and adds no cut its other declarations hold", async () => {
  const { status, value } = await callersOf("src/app/marker.ts", "Marker");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [
    { file: "src/app/app.routes.ts", symbol: "app.routes.ts", basis: "reference", lines: [10] },
    { file: "src/app/host.component.ts", symbol: "host.component.ts", basis: "reference", lines: [9] },
  ]);
  assert.deepEqual(value.entrypoints, []);
});

test("a file with a place whose binding is unknown keeps its top-level declarations standing in for its code", async () => {
  const { status, value } = await callersOf("src/app/level.ts", "Level");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [{ file: "src/app/level-use.ts", symbol: "scale", basis: "import", lines: [] }]);
});

test("a declaration read through a namespace import, of its module or of a barrel that re-exports it, is a dependent at the declaration or the file that writes the read, for callers and for the impact of a change", async () => {
  const callers = await callersOf("src/app/status.ts", "Status");
  const change = await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "fixture", base: "HEAD~1", head: "HEAD" });
  assert.ok(change.ok && change.value.status !== "unknown", JSON.stringify(change));

  for (const { status, value } of [callers, { status: change.value.status, value: change.value.value }]) {
    assert.equal(status, "complete");
    assert.deepEqual(dependents(value), [
      { file: "src/app/status-barrels.ts", symbol: "viaStar", basis: "reference", lines: [6] },
      { file: "src/app/status-barrels.ts", symbol: "viaAlias", basis: "reference", lines: [10] },
      { file: "src/app/status-barrels.ts", symbol: "viaLocal", basis: "reference", lines: [14] },
      { file: "src/app/status-tagged.ts", symbol: "Tagged", basis: "reference", lines: [7] },
      { file: "src/app/status-use.ts", symbol: "status-use.ts", basis: "reference", lines: [11] },
      { file: "src/app/status-use.ts", symbol: "on", basis: "reference", lines: [4] },
    ]);
  }
});

test("a namespace written where the sources do not settle which declaration it reads, indexed, passed as a value, re-exported or imported by name from a module that exports it, cuts the answer at each such place, none of a test file", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "fixture", revision: "HEAD", targets: [{ file: "src/app/tokens.ts", symbol: "Token" }] });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));

  assert.deepEqual(dependents(result.value.value), []);
  assert.deepEqual(result.value.cuts.map(({ kind, reason, at }) => ({ kind, reason, at })), [
    { kind: "unresolved-link", reason: "hidden-caller", at: ["src/app/tokens.ts::Token", "src/app/token-space-use.ts:4 tokens", "src/app/token-uses.ts:11 tk", "src/app/token-uses.ts:8 tk"] },
  ]);
});

test("a namespace place whose member no export path of the module gives the declaration is no place of it: no dependent and no cut, beside the place that names it", async () => {
  const { status, value } = await callersOf("src/app/kinds.ts", "Box");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [{ file: "src/app/kind-uses.ts", symbol: "make", basis: "call", lines: [11] }]);
});

test("the root of a type query of a namespace member binds the declaration the module exports under that name: a dependent, not a cut", async () => {
  const { status, value } = await callersOf("src/app/kinds.ts", "Limit");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [{ file: "src/app/kind-uses.ts", symbol: "LimitType", basis: "reference", lines: [8] }]);
});

test("a property name that spells a namespace's local, of an object literal or a type literal, writes no namespace: no dependent and no cut", async () => {
  const { status, value } = await callersOf("src/app/marks.ts", "Mark");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value), [{ file: "src/app/mark-uses.ts", symbol: "first", basis: "reference", lines: [4] }]);
});

test("the members a namespace may name a declaration by follow the export statements of its file and of the modules that import it: an alias, an unread alias, a default declaration, and no module that only imports it", async () => {
  const [small, large] = await Promise.all([callersOf("src/app/sizes.ts", "Small"), callersOf("src/app/sizes.ts", "large")]);

  assert.deepEqual([small.status, large.status], ["complete", "complete"]);
  assert.deepEqual(dependents(small.value), [
    { file: "src/app/size-reader.ts", symbol: "size-reader.ts", basis: "reference", lines: [3] },
    { file: "src/app/size-uses.ts", symbol: "tiny", basis: "reference", lines: [6] },
    { file: "src/app/size-uses.ts", symbol: "least", basis: "reference", lines: [10] },
    { file: "src/app/size-uses.ts", symbol: "wee", basis: "reference", lines: [14] },
  ]);
  assert.deepEqual(dependents(large.value), [{ file: "src/app/size-uses.ts", symbol: "pick", basis: "reference", lines: [18] }]);
});
