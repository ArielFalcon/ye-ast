import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import { EDGE_POLICY } from "../core/domain/impact/edge-policy.ts";
import type { ImpactedSymbol, ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * Every receiver settlement `callers` and `impact` make of an edge on a value receiver, each with the class the proof
 * names declaring the member (proven) and not declaring it (name match). `Store` declares the only `save`, `Counter` the
 * only `tick` and `Base` the only `load`, so the index matches every call of those names to them; `Other`, `Silent` and
 * `Unrelated` declare none of them.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "20.0.0" } }),
  "src/store.ts": "export class Store {\n  save(value: string): void {\n    console.log(value);\n  }\n}\n",
  "src/other.ts": "export class Other {\n  read(): string {\n    return '';\n  }\n}\n",
  "src/base.ts": "export class Base {\n  load(): number {\n    return 1;\n  }\n}\n\nexport class Child extends Base {}\n\nexport class Unrelated {}\n",
  "src/field-wrong.ts": "import { Injectable } from '@angular/core';\nimport { Other } from './other';\n\n@Injectable()\nexport class FieldWrong {\n  constructor(private store: Other) {}\n\n  flush(): void {\n    this.store.save('a');\n  }\n}\n",
  "src/local-wrong.ts": "import { inject } from '@angular/core';\nimport { Other } from './other';\n\nexport function useOther(): void {\n  const store = inject(Other);\n  store.save('b');\n}\n",
  "src/constructed.ts": "import { Store } from './store';\nimport { Other } from './other';\n\nexport function makeStore(): void {\n  const store = new Store();\n  store.save('c');\n}\n\nexport function makeOther(): void {\n  const other = new Other();\n  other.save('d');\n}\n",
  "src/inherited.ts": "import { Child, Unrelated } from './base';\n\nexport function loadChild(): number {\n  const child = new Child();\n  return child.load();\n}\n\nexport function loadUnrelated(): number {\n  const value = new Unrelated();\n  return value.load();\n}\n",
  "src/counter.ts": "export class Counter {\n  tick(): void {\n    console.log('tick');\n  }\n}\n\nexport function count(): void {\n  const counter = new Counter();\n  counter.tick();\n}\n",
  "src/silent.ts": "class Silent {}\n\nexport function hush(): void {\n  const silent = new Silent();\n  silent.tick();\n}\n",
  "src/field-inherited.ts": "import { Injectable, inject } from '@angular/core';\nimport { Child } from './base';\n\n@Injectable()\nexport class FieldInherited {\n  private child = inject(Child);\n\n  flush(): number {\n    return this.child.load();\n  }\n}\n",
  "src/annotated.ts": "import { Store } from './store';\nimport { Other } from './other';\n\nexport function keepStore(store: Store): void {\n  store.save('e');\n}\n\nexport function keepOther(other: Other): void {\n  other.save('f');\n}\n",
  "src/ledger.ts": "export class Ledger {\n  #save(value: string): void {\n    console.log(value);\n  }\n\n  run(x: Ledger): void {\n    x.#save('a');\n  }\n}\n",
};

/** `save` changes, so `impact` walks from it as `callers` of `Store.save` does. */
const CHANGED = { "src/store.ts": "export class Store {\n  save(value: string): void {\n    console.info(value);\n  }\n}\n" };

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
  root = await mkdtemp(join(tmpdir(), "ye-ast-receiver-settlement-"));
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

async function callersOf(file: string, symbol: string): Promise<ImpactValue> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "receiver-settlement", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return result.value.value;
}

const NAME_MATCH = { confidence: EDGE_POLICY.unscoredHeuristicConfidence, derivation: "name-match" };
const PROVEN = { confidence: EDGE_POLICY.relations.confidence, derivation: "proven" };

function settlement(value: ImpactValue, file: string, symbol: string): { confidence: number; derivation: unknown } | undefined {
  const found: ImpactedSymbol | undefined = value.symbols.find((candidate) => candidate.file === file && candidate.symbol === symbol);
  return found === undefined ? undefined : { confidence: found.confidence, derivation: found.via?.derivation };
}

test("a call on an inject() local is a name match when it holds a class that does not declare the member, and one on an injected field of such a class is no caller but a cut at the call", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "receiver-settlement", revision: "HEAD", targets: [{ file: "src/store.ts", symbol: "save" }] });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));

  assert.deepEqual(settlement(result.value.value, "src/local-wrong.ts", "useOther"), NAME_MATCH);
  assert.equal(settlement(result.value.value, "src/field-wrong.ts", "flush"), undefined);
  assert.deepEqual(result.value.cuts, [{ kind: "unresolved-link", at: ["src/field-wrong.ts", "src/field-wrong.ts:9 this.store.save"], reason: "name-only", reach: { kind: "callers-of", declarations: ["src/store.ts::save"] } }]);
});

test("a call on a value constructed from an imported class is proven when that class declares the member, and a name match otherwise", async () => {
  const value = await callersOf("src/store.ts", "save");

  assert.deepEqual(settlement(value, "src/constructed.ts", "makeStore"), PROVEN);
  assert.deepEqual(settlement(value, "src/constructed.ts", "makeOther"), NAME_MATCH);
});

test("a constructed class proves a member a class above it declares, and no member of a class outside its line", async () => {
  const value = await callersOf("src/base.ts", "Base.load");

  assert.deepEqual(settlement(value, "src/inherited.ts", "loadChild"), PROVEN);
  assert.deepEqual(settlement(value, "src/inherited.ts", "loadUnrelated"), NAME_MATCH);
});

test("a call on a value constructed from a class its own file declares is proven when that class declares the member, and a name match otherwise", async () => {
  const value = await callersOf("src/counter.ts", "Counter.tick");

  assert.deepEqual(settlement(value, "src/counter.ts", "count"), PROVEN);
  assert.deepEqual(settlement(value, "src/silent.ts", "hush"), NAME_MATCH);
});

test("a call on a parameter annotated with a class is proven when that class declares the member, and a name match otherwise", async () => {
  const value = await callersOf("src/store.ts", "save");

  assert.deepEqual(settlement(value, "src/annotated.ts", "keepStore"), PROVEN);
  assert.deepEqual(settlement(value, "src/annotated.ts", "keepOther"), NAME_MATCH);
});

test("in a scoped read, with no member proof, a call on an injected field of a class that inherits the member is a proven caller of the member its class has", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "receiver-settlement", revision: "HEAD", targets: [{ file: "src/base.ts", symbol: "Base.load" }], scope: { include: ["src/**"] } });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));

  assert.deepEqual(settlement(result.value.value, "src/field-inherited.ts", "flush"), PROVEN);
});

test("a call on a private member of a typed receiver that no base proves leaves a cut at it, never a complete answer with no caller", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "receiver-settlement", revision: "HEAD", targets: [{ file: "src/ledger.ts", symbol: "#save" }] });
  assert.ok(result.ok && result.value.status !== "complete", JSON.stringify(result));

  const cuts = result.ok && result.value.status === "partial" ? result.value.cuts : [];
  assert.ok(cuts.some((cut) => cut.kind === "unresolved-link" && cut.reach.kind === "callers-of" && cut.reach.declarations.includes("src/ledger.ts::#save")), JSON.stringify(cuts));
});

test("impact of a change settles every receiver as callers of the changed declaration does", async () => {
  const callers = await callersOf("src/store.ts", "save");
  const result = await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "receiver-settlement", base: "HEAD~1", head: "HEAD" });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));

  const settled = (value: ImpactValue) => value.symbols.filter(({ file }) => file !== "src/store.ts").map(({ file, symbol, confidence, via }) => ({ file, symbol, confidence, derivation: via?.derivation }));
  assert.deepEqual(settled(result.value.value), settled(callers));
  assert.deepEqual(settlement(result.value.value, "src/annotated.ts", "keepOther"), NAME_MATCH);
  assert.deepEqual(settlement(result.value.value, "src/constructed.ts", "makeStore"), PROVEN);
});
