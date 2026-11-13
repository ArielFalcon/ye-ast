import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";

/**
 * Each class implements or extends a supertype written with type arguments, which the index leaves as an unresolved
 * reference and no supertype edge. `client.ts` calls through the supertypes. `src/other/repo.ts` declares a homonym
 * `Repo` that `other-client.ts` calls. `Store` is `Repo` re-exported under another name. `Merged` is declared twice, so
 * the language merges both declarations into one type. `Names` and `Guard` write supertypes of the language's libraries
 * and of a package. The second commit changes the body of `NameRepo.find`.
 */
const APP = "src/app";
const CLIENT = `${APP}/client.ts`;
const OTHER_CLIENT = "src/other/other-client.ts";
const ts = (...lines: string[]): string => [...lines, ""].join("\n");
const SOURCES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "lib-router": "1.0.0" } }),
  [`${APP}/repo.ts`]: ts("export interface Repo<T> {", "  find(key: string): T;", "}"),
  [`${APP}/name-repo.ts`]: ts('import { Repo } from "./repo";', "export class NameRepo implements Repo<string> {", "  find(key: string): string {", '    return "n";', "  }", "}"),
  [`${APP}/index.ts`]: ts('export { Repo as Store } from "./repo";'),
  [`${APP}/store-repo.ts`]: ts('import { Store } from "./index";', "export class StoreRepo implements Store<number> {", "  find(key: string): number {", "    return 1;", "  }", "}"),
  [`${APP}/base-service.ts`]: ts("export class BaseService<T> {", "  load(id: string): T | undefined {", "    return undefined;", "  }", "  save(item: T): void {}", "}"),
  [`${APP}/user.ts`]: ts("export interface User {", "  name: string;", "}"),
  [`${APP}/user-service.ts`]: ts('import { BaseService } from "./base-service";', 'import { User } from "./user";', "export class UserService extends BaseService<User> {", "  save(item: User): void {}", "}"),
  [`${APP}/merged.ts`]: ts("export interface Merged<T> {", "  first(): T;", "}", "export interface Merged<T> {", "  second(): T;", "}"),
  [`${APP}/merged-impl.ts`]: ts('import { Merged } from "./merged";', "export class MergedImpl implements Merged<string> {", '  first(): string { return "f"; }', '  second(): string { return "s"; }', "}"),
  [`${APP}/names.ts`]: ts('import { Resolver } from "lib-router";', "export class Names extends Array<string> {", '  label(): string { return "l"; }', "}", "export class Guard implements Resolver<string> {", '  resolve(): string { return "r"; }', "}"),
  [CLIENT]: ts(
    'import { Repo } from "./repo";',
    'import { BaseService } from "./base-service";',
    'import { UserService } from "./user-service";',
    'import { User } from "./user";',
    'import { Merged } from "./merged";',
    "export function viaRepo(repo: Repo<string>): string {",
    '  return repo.find("a");',
    "}",
    "export function viaStore(repo: Repo<number>): number {",
    '  return repo.find("b");',
    "}",
    "export function inherited(service: UserService): User | undefined {",
    '  return service.load("1");',
    "}",
    "export function viaBase(service: BaseService<User>, user: User): void {",
    "  service.save(user);",
    "}",
    "export function viaMerged(merged: Merged<string>): string {",
    "  return merged.second();",
    "}",
  ),
  "src/other/repo.ts": ts("export interface Repo<T> {", "  find(key: string): T;", "}"),
  [OTHER_CLIENT]: ts('import { Repo } from "./repo";', "export function otherFind(repo: Repo<string>): string {", '  return repo.find("o");', "}"),
};
const CHANGED = { [`${APP}/name-repo.ts`]: SOURCES[`${APP}/name-repo.ts`]!.replace('"n"', '"m"') };

let root: string;
let scratchRoot: string;
let repo: string;

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
  root = await mkdtemp(join(tmpdir(), "ye-ast-ts-generic-supertype-"));
  scratchRoot = join(root, "scratch");
  repo = join(root, "repo");
  await mkdir(scratchRoot);
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(SOURCES, "fixture");
  await commit(CHANGED, "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const queries = () => composeQueries({ scratchRoot }).impact;
const callersFact = (file: string, symbol: string) => queries().callers({ repo, repoId: "ts-generic-supertype", revision: "HEAD", targets: [{ file, symbol }] });

/** The dependents an answer lists, as `<file>:<symbol>`. */
function dependentsOf(result: Awaited<ReturnType<typeof callersFact>>): string[] {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  return value.symbols.map(({ file, symbol }) => `${file}:${symbol}`);
}

const relationUnread = (result: Awaited<ReturnType<typeof callersFact>>): (readonly string[])[] => {
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const cuts: readonly Cut[] = result.value.status === "partial" ? result.value.cuts : [];
  return cuts.filter((cut) => "reason" in cut && cut.reason === "relation-unread").map(({ at }) => at);
};

test("callers of a method implementing or overriding a method of a supertype written with type arguments list the supertype's caller, never a homonym's", async () => {
  const cases: [string, string, string][] = [
    ["name-repo.ts", "NameRepo.find", "viaRepo"],
    ["store-repo.ts", "StoreRepo.find", "viaStore"],
    ["user-service.ts", "UserService.save", "viaBase"],
  ];
  for (const [file, symbol, caller] of cases) {
    const result = await callersFact(`${APP}/${file}`, symbol);
    const dependents = dependentsOf(result);
    assert.ok(dependents.includes(`${CLIENT}:${caller}`), `${symbol}: ${JSON.stringify(dependents)}`);
    assert.ok(!dependents.some((dependent) => dependent.startsWith(OTHER_CLIENT)), `${symbol}: ${JSON.stringify(dependents)}`);
    assert.deepEqual(relationUnread(result), [], symbol);
  }
});

test("callers of a method a class inherits from a superclass written with type arguments list the call made through the class", async () => {
  assert.ok(dependentsOf(await callersFact(`${APP}/base-service.ts`, "BaseService.load")).includes(`${CLIENT}:inherited`));
});

test("the impact of a change to an implementation of a supertype written with type arguments lists the supertype's caller", async () => {
  const result = await queries().ofChange({ repo, repoId: "ts-generic-supertype", base: "HEAD~1", head: "HEAD" });
  const dependents = dependentsOf(result);
  assert.ok(dependents.includes(`${CLIENT}:viaRepo`), JSON.stringify(dependents));
  assert.ok(!dependents.some((dependent) => dependent.startsWith(OTHER_CLIENT)), JSON.stringify(dependents));
});

test("importers of a supertype's file written with type arguments list the file of the type that implements it, and not the homonym's", async () => {
  const result = await queries().importers({ repo, repoId: "ts-generic-supertype", revision: "HEAD", files: [`${APP}/repo.ts`, "src/other/repo.ts"] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const users = Object.fromEntries(result.value.value.files.map(({ file, users }) => [file, users]));
  assert.ok(users[`${APP}/repo.ts`]?.includes(`${APP}/name-repo.ts`), JSON.stringify(users));
  assert.ok(!users["src/other/repo.ts"]?.includes(`${APP}/name-repo.ts`), JSON.stringify(users));
});

test("a supertype the language merges from several declarations links nothing and cuts the answers about its type", async () => {
  const result = await callersFact(`${APP}/merged-impl.ts`, "MergedImpl.second");
  assert.deepEqual(relationUnread(result), [[`${APP}/merged-impl.ts::MergedImpl`, `${APP}/merged-impl.ts:2 Merged<string>`]]);
  assert.ok(!dependentsOf(result).includes(`${CLIENT}:viaMerged`));
});

test("a supertype of the language's libraries or of a package adds no cut and no dependent", async () => {
  for (const symbol of ["Names.label", "Guard.resolve"]) {
    const result = await callersFact(`${APP}/names.ts`, symbol);
    assert.deepEqual(relationUnread(result), [], symbol);
    assert.deepEqual(dependentsOf(result).filter((dependent) => !dependent.startsWith(`${APP}/names.ts`)), [], symbol);
  }
});
