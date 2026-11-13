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
 * Qualified references the index leaves unresolved, whose name tail is a reached declaration's name (ADR-0079 U1): the
 * base binding settles each one that binds elsewhere, and every other keeps its `name-only` cut. `Api` and `Store` both
 * declare `get` and `save`, so the index matches no `get` or `save` call by its name alone. `NameRepo.Kept` names `Repo`
 * inside a class whose superclass, outside the repository, may declare a member type `Repo`, so its supertype is unsettled.
 */
const JAVA = "src/main/java/com/acme";
const JAVA_FILES: Record<string, string> = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>fx</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency></dependencies></project>\n",
  [`${JAVA}/Api.java`]: "package com.acme;\n\npublic class Api {\n    public String get(String key) {\n        return key;\n    }\n\n    public Api save(Api api) {\n        return api;\n    }\n}\n",
  [`${JAVA}/Store.java`]: "package com.acme;\n\npublic class Store {\n    public Store save(Store store) {\n        return store;\n    }\n\n    public String get(int index) {\n        return \"\";\n    }\n}\n",
  [`${JAVA}/ApiRepository.java`]: "package com.acme;\n\nimport org.springframework.data.jpa.repository.JpaRepository;\n\npublic interface ApiRepository extends JpaRepository<Api, Long> {\n}\n",
  [`${JAVA}/Service.java`]: "package com.acme;\n\nimport java.nio.file.Path;\nimport java.nio.file.Paths;\nimport java.util.List;\nimport java.util.Map;\n\npublic class Service {\n    private final ApiRepository repository;\n\n    public Service(ApiRepository repository) {\n        this.repository = repository;\n    }\n\n    public Path path(String name) {\n        return Paths.get(name);\n    }\n\n    public Api store(Api api) {\n        return repository.save(api);\n    }\n\n    public void rows(List<Map<String, String>> rows) {\n        rows.forEach(row -> row.get(\"k\"));\n    }\n}\n",
  [`${JAVA}/Factory.java`]: "package com.acme;\n\npublic class Factory {\n    public Api api() {\n        return new Api();\n    }\n}\n",
  [`${JAVA}/Holder.java`]: "package com.acme;\n\npublic class Holder {\n    public String save(Factory factory) {\n        return factory.api().get(\"k\");\n    }\n}\n",
  [`${JAVA}/Shape.java`]: "package com.acme;\n\npublic interface Shape {\n    int area();\n}\n",
  [`${JAVA}/Square.java`]: "package com.acme;\n\npublic class Square implements Shape {\n    public int area() {\n        return 1;\n    }\n}\n",
  [`${JAVA}/Base.java`]: "package com.acme;\n\npublic class Base {\n    public int size() {\n        return 0;\n    }\n}\n",
  [`${JAVA}/Sub.java`]: "package com.acme;\n\npublic class Sub extends Base {\n    @Override\n    public int size() {\n        return 1;\n    }\n}\n",
  [`${JAVA}/Repo.java`]: "package com.acme;\n\npublic interface Repo<T> {\n    T find();\n}\n",
  [`${JAVA}/NameRepo.java`]: "package com.acme;\n\npublic class NameRepo extends org.lib.Names {\n    public static class Kept implements Repo<String> {\n        public String find() {\n            return \"\";\n        }\n    }\n}\n",
  [`${JAVA}/Other.java`]: "package com.acme;\n\npublic class Other {\n    public int area() {\n        return 2;\n    }\n\n    public int size() {\n        return 2;\n    }\n\n    public String find() {\n        return \"\";\n    }\n}\n",
  [`${JAVA}/Maker.java`]: "package com.acme;\n\npublic class Maker {\n    public Shape shape() {\n        return new Square();\n    }\n\n    public Base base() {\n        return new Sub();\n    }\n\n    public Repo<String> repo() {\n        return new NameRepo.Kept();\n    }\n}\n",
  [`${JAVA}/Client.java`]: "package com.acme;\n\npublic class Client {\n    public int shape(Maker maker) {\n        return maker.shape().area();\n    }\n\n    public int base(Maker maker) {\n        return maker.base().size();\n    }\n\n    public String repo(Maker maker) {\n        return maker.repo().find();\n    }\n}\n",
};
const JAVA_CHANGE = { [`${JAVA}/Api.java`]: JAVA_FILES[`${JAVA}/Api.java`]!.replace("return key;", "return key.trim();") };

const TS_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0", typeorm: "0.3.0" } }),
  "src/app/page.ts": "export class Page {\n  isOnline(): boolean {\n    return true;\n  }\n}\n",
  "src/app/status.service.ts": "import { Injectable } from '@angular/core';\n\n@Injectable({ providedIn: 'root' })\nexport class StatusService {\n  isOnline = (): boolean => true;\n}\n",
  "src/app/table.ts": "export class Table {\n  load(): number {\n    return 1;\n  }\n}\n",
  "src/app/helper.ts": "import { Injectable, inject } from '@angular/core';\nimport { StatusService } from './status.service';\n\n@Injectable({ providedIn: 'root' })\nexport class Helper {\n  private status = inject(StatusService);\n\n  online(): boolean {\n    return this.status.isOnline();\n  }\n}\n",
  "src/app/lists.ts": "import { DataSource } from 'typeorm';\n\nexport class Lists {\n  private readonly source: DataSource = new DataSource();\n\n  refresh(): unknown {\n    return this.source.load();\n  }\n}\n",
};

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
const repos: Record<"java" | "ts", string> = { java: "", ts: "" };

async function commit(repo: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-unresolved-binding-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  for (const name of ["java", "ts"] as const) {
    repos[name] = join(root, name);
    await mkdir(repos[name]);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repos[name], env: ENV });
  }
  await commit(repos.java, JAVA_FILES);
  await commit(repos.java, JAVA_CHANGE);
  await commit(repos.ts, TS_FILES);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function callersOf(name: "java" | "ts", file: string, symbol: string, budget?: { depth: number }): Promise<{ status: string; value: ImpactValue; cuts: readonly Cut[] }> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo: repos[name], repoId: name, revision: "HEAD", targets: [{ file, symbol }], ...(budget === undefined ? {} : { budget }) });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return { status: result.value.status, value: result.value.value, cuts: result.value.status === "partial" ? result.value.cuts : [] };
}

const nameOnly = (cuts: readonly Cut[]) => cuts.filter((cut) => cut.reason === "name-only").map(({ at, reach }) => ({ at, reach }));
const dependents = (value: ImpactValue, file: string) => value.symbols.filter((symbol) => symbol.file === file).map(({ symbol }) => symbol);

test("a static call on a type outside the repository leaves no name-only cut, and a lambda parameter's call nothing binds keeps its cut and its reach", async () => {
  const { cuts } = await callersOf("java", `${JAVA}/Api.java`, "get");

  assert.deepEqual(nameOnly(cuts).filter(({ at }) => at[0] === `${JAVA}/Service.java`), [{ at: [`${JAVA}/Service.java`, `${JAVA}/Service.java:24 row.get`], reach: { kind: "callers-of", declarations: [`${JAVA}/Api.java::get`] } }]);
});

test("an inherited operation of a Spring Data repository is generated code, so its call is no caller of a repository homonym", async () => {
  const { status } = await callersOf("java", `${JAVA}/Api.java`, "save");

  assert.equal(status, "complete");
});

test("a reference reached only once a later round of the walk reaches its homonym is settled in that round", async () => {
  const { value, cuts } = await callersOf("java", `${JAVA}/Api.java`, "get");

  assert.deepEqual(dependents(value, `${JAVA}/Holder.java`), ["Holder", "save"]);
  assert.equal(cuts.some((cut) => cut.at.some((place) => place.includes("repository.save"))), false, JSON.stringify(cuts));
});

test("a call bound to the supertype method an interface or a superclass declares stays a dependent of the overriding declaration", async () => {
  for (const [file, symbol] of [["Square.java", "area"], ["Sub.java", "size"]] as const) {
    const { status, value } = await callersOf("java", `${JAVA}/${file}`, symbol);

    assert.equal(status, "complete");
    assert.ok(dependents(value, `${JAVA}/Client.java`).includes(file === "Square.java" ? "shape" : "base"), JSON.stringify(value.symbols));
  }
});

test("an edge from a declaration the walk did not expand settles no reference, so its cut stays beside the bound's", async () => {
  const { cuts } = await callersOf("java", `${JAVA}/Shape.java`, "area", { depth: 0 });

  assert.deepEqual(nameOnly(cuts).map(({ at }) => at), [[`${JAVA}/Client.java`, `${JAVA}/Client.java:5 maker.shape().area`]]);
});

test("a call bound to a supertype method the walk never reached keeps its cut where the declaration implements that method", async () => {
  const { cuts } = await callersOf("java", `${JAVA}/NameRepo.java`, "find");

  assert.deepEqual(nameOnly(cuts).map(({ at }) => at), [[`${JAVA}/Client.java`, `${JAVA}/Client.java:13 maker.repo().find`]]);
});

test("impact of a change settles the references callers of the changed declaration settles", async () => {
  const callers = await callersOf("java", `${JAVA}/Api.java`, "get");
  const result = await composeQueries({ scratchRoot }).impact.ofChange({ repo: repos.java, repoId: "java", base: "HEAD~1", head: "HEAD" });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));

  assert.deepEqual(nameOnly(result.value.cuts), nameOnly(callers.cuts));
});

test("a call through a field initialized with a package type leaves no name-only cut", async () => {
  const { status } = await callersOf("ts", "src/app/table.ts", "load");

  assert.equal(status, "complete");
});

test("a call that binds to an unreached property member keeps its cut while the language pack cannot prove the reached method does not override it", async () => {
  const { cuts } = await callersOf("ts", "src/app/page.ts", "isOnline");

  assert.deepEqual(nameOnly(cuts).map(({ at }) => at), [["src/app/helper.ts", "src/app/helper.ts:9 this.status.isOnline"]]);
});
