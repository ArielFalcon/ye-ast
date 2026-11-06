import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_STORE_DIRECTORY, type CodeGraph, type CodeGraphFault, type CodeGraphReader, type GraphNodeId, type IndexSummary } from "../../ports/code-graph.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import {
  createCodeGraph,
  defaultCodeGraphDeps,
  siblingScript,
  SUPPORTED_STORE,
  type CodeGraphDeps,
  type IndexerRun,
} from "./codegraph.adapter.ts";

const ORDERS = `export function loadOrder(id: string): string {
  return id;
}
export function listOrders(): string[] {
  return [loadOrder("1")];
}
export function unknownCall(): void {
  externalThing();
}
`;

const APP = `import express from "express";
import { listOrders, loadOrder } from "./orders";
const app = express();
function handleList(req: unknown, res: { json(v: unknown): void }) {
  res.json(listOrders());
}
app.get("/orders", handleList);
app.get("/orders/:id", (req: any, res: any) => res.json(loadOrder(req.params.id)));
startServer();
`;

const BASE: Readonly<Record<string, string>> = {
  "package.json": '{"name":"fixture","dependencies":{"express":"4.18.0"}}',
  "src/orders.ts": ORDERS,
  "src/app.ts": APP,
  "java/Repo.java": "package app;\npublic interface Repo {\n    void save(String v);\n}\n",
  "java/RepoImpl.java": "package app;\npublic class RepoImpl implements Repo {\n    public void save(String v) {\n    }\n}\n",
  "java/Svc.java":
    "package app;\npublic class Svc {\n    private final Repo repo;\n    public Svc(Repo repo) { this.repo = repo; }\n    public void run() {\n        repo.save(\"a\");\n    }\n}\n",
};

const SEED: Readonly<Record<string, string>> = { "src/seed.ts": "export function seeded(): number {\n  return 1;\n}\n" };

const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ye-ast-graph-"));
  scratches.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function snapshotOf(files: Readonly<Record<string, string>>): string {
  const dir = join(scratch(), "snapshot");
  mkdirSync(dir);
  writeTree(dir, files);
  return dir;
}

function listTree(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) tree[join(entry.parentPath, entry.name).slice(root.length + 1)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return tree;
}

function unwrap<T>(result: Result<T, CodeGraphFault>): T {
  assert.ok(result.ok, result.ok ? "" : `${result.fault.kind}: ${result.fault.detail}`);
  return result.value;
}

function faultOf<T>(result: Result<T, CodeGraphFault>): CodeGraphFault {
  assert.ok(!result.ok, "expected a fault");
  return result.fault;
}

async function indexFiles(files: Readonly<Record<string, string>>, graph: CodeGraph = createCodeGraph()): Promise<{ snapshot: string; store: string; result: Result<IndexSummary, CodeGraphFault> }> {
  const snapshot = snapshotOf(files);
  const store = join(scratch(), "store");
  return { snapshot, store, result: await graph.index(snapshot, store) };
}

interface IndexerCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

function recordingDeps(answer: (call: IndexerCall) => IndexerRun | Promise<IndexerRun>, overrides: Partial<CodeGraphDeps> = {}): { deps: CodeGraphDeps; calls: IndexerCall[] } {
  const calls: IndexerCall[] = [];
  const deps: CodeGraphDeps = {
    ...defaultCodeGraphDeps,
    ...overrides,
    runIndexer: async (command, args, env) => {
      const call = { command, args, env };
      calls.push(call);
      return answer(call);
    },
  };
  return { deps, calls };
}

const NOTHING: IndexerRun = { code: 1, stdout: "", stderr: "" };

function installedCodegraphVersion(): string {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../node_modules/@colbymchenry/codegraph/package.json"), "utf8")) as { version: string };
  return manifest.version;
}

interface SharedStore {
  store: string;
  reader: CodeGraphReader;
  root: string;
}

let sharedStore: Promise<SharedStore> | undefined;

function shared(): Promise<SharedStore> {
  sharedStore ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "ye-ast-graph-shared-"));
    const snapshot = join(root, "snapshot");
    mkdirSync(snapshot);
    writeTree(snapshot, BASE);
    const store = join(root, "store");
    const graph = createCodeGraph();
    unwrap(await graph.index(snapshot, store));
    return { store, reader: unwrap(graph.open(store)), root };
  })();
  return sharedStore;
}

after(async () => {
  if (sharedStore === undefined) return;
  const { reader, root } = await sharedStore.catch(() => ({ reader: undefined, root: undefined }));
  reader?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function symbol(reader: CodeGraphReader, file: string, name: string) {
  const found = reader.symbolsInFiles([file]).find((candidate) => candidate.name === name);
  assert.ok(found, `${name} in ${file}`);
  return found;
}

test("indexes into a store outside the snapshot and leaves the snapshot as it was", async () => {
  const snapshot = snapshotOf(BASE);
  const before = listTree(snapshot);
  const store = join(scratch(), "store");
  const summary = unwrap(await createCodeGraph().index(snapshot, store));
  assert.deepEqual(listTree(snapshot), before);
  assert.deepEqual(readdirSync(store), [INDEX_STORE_DIRECTORY]);
  assert.deepEqual(summary, {
    filesIndexed: 5,
    filesSkipped: 0,
    filesErrored: 0,
    filesNotIndexed: [],
    versions: { codegraph: installedCodegraphVersion(), schema: SUPPORTED_STORE.schema.min, extraction: SUPPORTED_STORE.extraction.min },
  });
});

const JAVA_CLASS = (name: string): string => `package com.acme;
public class ${name} {
}
`;

test("a file the engine could index but its built-in ignored directory names left out is reported", async () => {
  const { result } = await indexFiles({
    "com/acme/target/Targets.java": JAVA_CLASS("Targets"),
    "com/acme/Service.java": JAVA_CLASS("Service"),
    "com/acme/out/Outbound.java": JAVA_CLASS("Outbound"),
  });
  const summary = unwrap(result);
  assert.equal(summary.filesIndexed, 1);
  assert.deepEqual(summary.filesNotIndexed, ["com/acme/out/Outbound.java", "com/acme/target/Targets.java"]);
});

test("a file in a language the engine does not support is not reported when it is left out", async () => {
  const { result } = await indexFiles({
    "com/acme/Service.java": JAVA_CLASS("Service"),
    "com/acme/out/notes.txt": "notes\n",
    "com/acme/out/data.json": "{}\n",
  });
  assert.deepEqual(unwrap(result).filesNotIndexed, []);
});

test("the files left out are listed in code-unit order, not in the order they were staged", async () => {
  const { result } = await indexFiles({
    "out/b.java": JAVA_CLASS("B"),
    "out/Z.java": JAVA_CLASS("Upper"),
    "a.java": JAVA_CLASS("A"),
    "a/out/X.java": JAVA_CLASS("X"),
    "a-b/out/Y.java": JAVA_CLASS("Y"),
    "vendor/Z.java": JAVA_CLASS("Z"),
  });
  assert.deepEqual(unwrap(result).filesNotIndexed, ["a-b/out/Y.java", "a/out/X.java", "out/Z.java", "out/b.java", "vendor/Z.java"]);
});

test("the same snapshot gives the same answers wherever it is indexed", async () => {
  const answers = async (): Promise<string> => {
    const graph = createCodeGraph();
    const { store, snapshot } = await indexFiles(BASE, graph);
    const reader = unwrap(graph.open(store));
    const files = ["src/orders.ts", "src/app.ts", "java/RepoImpl.java"];
    const symbols = reader.symbolsInFiles(files);
    const ids = symbols.map((candidate) => candidate.id);
    const json = JSON.stringify([symbols, reader.incomingEdges(ids), reader.unresolvedReferences(files)]);
    reader.close();
    assert.ok(!json.includes(store) && !json.includes(snapshot));
    return json;
  };
  assert.equal(await answers(), await answers());
});

const ENGINE_FILES: ReadonlyArray<{ name: string; committed?: Readonly<Record<string, string>>; prebuiltAs?: string }> = [
  { name: "codegraph.json", committed: { "codegraph.json": '{"exclude":["src/","java/"]}' } },
  { name: "a codegraph.json spelled in another case", committed: { "CodeGraph.JSON": '{"exclude":["src/","java/"]}' } },
  { name: "every .gitignore, at the root and below", committed: { ".gitignore": "src/orders.ts\n", "java/.gitignore": "Svc.java\n" } },
  { name: "a .gitignore spelled in another case", committed: { ".GitIgnore": "src/orders.ts\n" } },
  { name: "a pre-built index in .ye-ast-graph", prebuiltAs: INDEX_STORE_DIRECTORY },
  { name: "a pre-built index in .ye-ast-graph spelled in another case", prebuiltAs: ".YE-AST-GRAPH" },
  { name: "a pre-built index in .codegraph", prebuiltAs: ".codegraph" },
  { name: "the .ye-ast directory", committed: { ".ye-ast/generated.ts": "export function fromYeAst(): void {}\n" } },
  {
    name: "a git repository",
    committed: { ".git/HEAD": "ref: refs/heads/main\n", ".git/objects/.keep": "", ".git/refs/.keep": "", ".git/info/exclude": "src/\njava/\n" },
  },
  { name: "a file named like the store directory", committed: { [INDEX_STORE_DIRECTORY]: "not a store\n" } },
];

for (const { name, committed = {}, prebuiltAs } of ENGINE_FILES) {
  test(`${name} in the snapshot neither configures nor seeds the index`, async () => {
    const snapshot = snapshotOf({ ...BASE, ...committed });
    if (prebuiltAs !== undefined) {
      const prebuilt = await indexFiles(SEED);
      unwrap(prebuilt.result);
      cpSync(join(prebuilt.store, INDEX_STORE_DIRECTORY), join(snapshot, prebuiltAs), { recursive: true });
    }
    const graph = createCodeGraph();
    const store = join(scratch(), "store");
    unwrap(await graph.index(snapshot, store));
    const reader = unwrap(graph.open(store));
    const names = (file: string) => reader.symbolsInFiles([file]).map((candidate) => candidate.name);
    assert.ok(names("src/orders.ts").includes("loadOrder"));
    assert.ok(names("java/Svc.java").includes("run"));
    assert.deepEqual(reader.symbolsInFiles(["src/seed.ts", ".ye-ast/generated.ts"]), []);
    reader.close();
  });
}

test("a store that is not empty is refused and left as it was", async () => {
  const snapshot = snapshotOf(BASE);
  const store = scratch();
  writeFileSync(join(store, "keep.txt"), "mine");
  const fault = faultOf(await createCodeGraph().index(snapshot, store));
  assert.equal(fault.kind, "stage-failed");
  assert.deepEqual(listTree(store), { "keep.txt": "mine" });
});

test("a symbolic link in the snapshot is not followed", async () => {
  const snapshot = snapshotOf(BASE);
  const outside = scratch();
  writeTree(outside, { "leak.ts": "export function leaked(): void {}\n" });
  symlinkSync(outside, join(snapshot, "linked"));
  const fault = faultOf(await createCodeGraph().index(snapshot, join(scratch(), "store")));
  assert.equal(fault.kind, "stage-failed");
});

test("a missing platform package is a fault for indexing and for opening, and nothing runs", async () => {
  const s = await shared();
  const { deps, calls } = recordingDeps(() => NOTHING, { resolveBundle: () => null });
  const graph = createCodeGraph(deps);
  const snapshot = snapshotOf(BASE);
  const store = join(scratch(), "store");
  assert.equal(faultOf(await graph.index(snapshot, store)).kind, "platform-package-missing");
  assert.equal(faultOf(graph.open(s.store)).kind, "platform-package-missing");
  assert.equal(calls.length, 0);
  assert.equal(existsSync(store), false);
});

test("the bundle is resolved from the platform package in node_modules, never from a cache", () => {
  const bundle = defaultCodeGraphDeps.resolveBundle();
  assert.ok(bundle !== null);
  assert.ok(bundle.includes(join("node_modules", "@colbymchenry", `codegraph-${process.platform}-${process.arch}`, "lib", "dist")));
});

test("the child script carries the extension of the module that spawns it, so the published build finds it", () => {
  const emitted = siblingScript("file:///pkg/dist/core/adapters/codegraph/codegraph.adapter.js", "index-snapshot.child");
  const source = siblingScript("file:///repo/src/core/adapters/codegraph/codegraph.adapter.ts", "index-snapshot.child");

  assert.equal(emitted, join("/pkg/dist/core/adapters/codegraph", "index-snapshot.child.js"));
  assert.equal(source, join("/repo/src/core/adapters/codegraph", "index-snapshot.child.ts"));
});

test("the indexer runs the child with the V8 flag and the resolved bundle, never codegraph's launcher", async () => {
  const { deps, calls } = recordingDeps(() => NOTHING);
  const snapshot = snapshotOf(BASE);
  const store = join(scratch(), "store");
  await createCodeGraph(deps).index(snapshot, store);
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.command, process.execPath);
  assert.equal(call.args[0], "--liftoff-only");
  assert.equal(call.args[2], defaultCodeGraphDeps.resolveBundle());
  assert.equal(call.args[3], store);
  assert.equal(call.args.length, 4);
  assert.ok(!call.args.join(" ").includes("npm-shim"));
});

test("the indexer runs with telemetry off whatever the host says", async () => {
  const { deps, calls } = recordingDeps(() => NOTHING, { environment: { DO_NOT_TRACK: "0", PATH: "/bin" } });
  await createCodeGraph(deps).index(snapshotOf(BASE), join(scratch(), "store"));
  assert.equal(calls[0]?.env.DO_NOT_TRACK, "1");
});

test("the indexer keeps no compile cache, so it writes nothing outside the store", async () => {
  const { deps, calls } = recordingDeps(() => NOTHING, { environment: { PATH: "/bin" } });
  await createCodeGraph(deps).index(snapshotOf(BASE), join(scratch(), "store"));
  assert.equal(calls[0]?.env.NODE_DISABLE_COMPILE_CACHE, "1");
});

test("a store inside the snapshot is refused and the snapshot is left as it was", async () => {
  const snapshot = snapshotOf(BASE);
  const fault = faultOf(await createCodeGraph().index(snapshot, join(snapshot, "nested", "store")));
  assert.equal(fault.kind, "stage-failed");
  assert.deepEqual(listTree(snapshot), BASE);
});

test("the indexer takes nothing from the host's codegraph or git configuration", async () => {
  const hostile = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    CODEGRAPH_DIR: "elsewhere",
    CODEGRAPH_PARSE_TIMEOUT_MS: "1",
    GIT_DIR: "/somewhere/.git",
    GIT_CONFIG_GLOBAL: "/home/someone/.gitconfig",
    NODE_OPTIONS: "--require /evil.js",
  };
  const { deps, calls } = recordingDeps(() => NOTHING, { environment: hostile });
  await createCodeGraph(deps).index(snapshotOf(BASE), join(scratch(), "store"));
  const env = calls[0]?.env ?? {};
  assert.equal(env.CODEGRAPH_DIR, INDEX_STORE_DIRECTORY);
  assert.equal(env.PATH, hostile.PATH);
  assert.equal(env.GIT_CONFIG_GLOBAL, devNull);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  for (const name of ["CODEGRAPH_PARSE_TIMEOUT_MS", "GIT_DIR", "NODE_OPTIONS"]) assert.equal(env[name], undefined, name);
});

test("opening a store finds it whatever the host's codegraph settings, and leaves the host's environment as it was", async () => {
  const { store } = await shared();
  const before = { CODEGRAPH_DIR: process.env.CODEGRAPH_DIR, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
  delete process.env.CODEGRAPH_DIR;
  process.env.DO_NOT_TRACK = "0";
  try {
    const reader = unwrap(createCodeGraph().open(store));
    const symbols = reader.symbolsInFiles(["src/orders.ts"]);
    reader.close();

    assert.equal(process.env.CODEGRAPH_DIR, undefined);
    assert.equal(process.env.DO_NOT_TRACK, "0");
    assert.ok(symbols.length > 0);
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

const REPORT = { success: true, indexState: "complete", filesIndexed: 3, filesSkipped: 1, filesErrored: 0, errors: [] };

const BAD_RUNS: ReadonlyArray<[string, IndexerRun]> = [
  ["exits with a failure", { code: 1, stdout: JSON.stringify(REPORT), stderr: "boom" }],
  ["is killed", { code: null, stdout: "", stderr: "" }],
  ["prints no report", { code: 0, stdout: "not json", stderr: "" }],
  ["reports a partial index", { code: 0, stdout: JSON.stringify({ ...REPORT, indexState: "partial" }), stderr: "" }],
  ["reports a failed run", { code: 0, stdout: JSON.stringify({ ...REPORT, success: false }), stderr: "" }],
];

for (const [name, run] of BAD_RUNS) {
  test(`an indexer that ${name} is an index fault, never a store`, async () => {
    const { deps } = recordingDeps(() => run);
    const fault = faultOf((await indexFiles(BASE, createCodeGraph(deps))).result);
    assert.equal(fault.kind, "index-failed");
  });
}

test("an aborted signal stops the index with an aborted fault, not an index fault", async () => {
  const controller = new AbortController();
  const { deps } = recordingDeps(() => {
    controller.abort();
    return NOTHING;
  });
  const fault = faultOf(await createCodeGraph(deps).index(snapshotOf(BASE), join(scratch(), "store"), controller.signal));
  assert.equal(fault.kind, "aborted");
});

test("a signal aborted before the call runs nothing", async () => {
  const { deps, calls } = recordingDeps(() => NOTHING);
  const store = join(scratch(), "store");
  const fault = faultOf(await createCodeGraph(deps).index(snapshotOf(BASE), store, AbortSignal.abort()));
  assert.equal(fault.kind, "aborted");
  assert.equal(calls.length, 0);
  assert.equal(existsSync(store), false);
});

test("a git repository around the store does not decide which files are indexed", async () => {
  const repository = scratch();
  const git = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q"], { cwd: repository, env: git });
  writeFileSync(join(repository, ".gitignore"), "src/\n");
  const graph = createCodeGraph();
  const store = join(repository, "store");
  unwrap(await graph.index(snapshotOf(BASE), store));
  const reader = unwrap(graph.open(store));
  assert.ok(reader.symbolsInFiles(["src/orders.ts"]).length > 0);
  reader.close();
});

test("a snapshot with no file the engine can read yields no stamped index, which is refused", async () => {
  const fault = faultOf((await indexFiles({ "README.md": "# nothing to read\n" })).result);
  assert.equal(fault.kind, "unsupported-store");
});

async function tampered(change: (db: DatabaseSync) => void): Promise<string> {
  const store = join(scratch(), "store");
  cpSync((await shared()).store, store, { recursive: true });
  const db = new DatabaseSync(join(store, INDEX_STORE_DIRECTORY, "codegraph.db"));
  change(db);
  db.close();
  return store;
}

const setExtraction = (version: number) => (db: DatabaseSync) =>
  void db.prepare("UPDATE project_metadata SET value = ? WHERE key = 'indexed_with_extraction_version'").run(String(version));
const addSchema = (version: number) => (db: DatabaseSync) =>
  void db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (?, 0, 'test')").run(version);

const setSchema = (version: number) => (db: DatabaseSync) => {
  db.exec("DELETE FROM schema_versions");
  addSchema(version)(db);
};
const dropVersionStamp = (db: DatabaseSync) => void db.prepare("DELETE FROM project_metadata WHERE key = 'indexed_with_version'").run();

const OUT_OF_RANGE: ReadonlyArray<[string, (db: DatabaseSync) => void]> = [
  ["no codegraph version stamp", dropVersionStamp],
  ["a schema above the range", addSchema(SUPPORTED_STORE.schema.max + 1)],
  ["a schema below the range", setSchema(SUPPORTED_STORE.schema.min - 1)],
  ["an extraction above the range", setExtraction(SUPPORTED_STORE.extraction.max + 1)],
  ["an extraction below the range", setExtraction(SUPPORTED_STORE.extraction.min - 1)],
  ["an index that did not complete", (db) => void db.prepare("UPDATE project_metadata SET value = 'partial' WHERE key = 'index_state'").run()],
];

for (const [name, change] of OUT_OF_RANGE) {
  test(`a store with ${name} is refused`, async () => {
    assert.equal(faultOf(createCodeGraph().open(await tampered(change))).kind, "unsupported-store");
  });
}

test("a directory that holds no store is a store fault", () => {
  assert.equal(faultOf(createCodeGraph().open(scratch())).kind, "store-unreadable");
});

test("stores open read-only, for the version check too", async () => {
  const s = await shared();
  const opened: unknown[] = [];
  const bundle = defaultCodeGraphDeps.resolveBundle();
  assert.ok(bundle !== null);
  const real = defaultCodeGraphDeps.loadSdk(bundle);
  const recording = <T extends object>(target: T, method: "openSync" | "open"): T =>
    new Proxy(target, {
      get(owner, property, receiver) {
        const value = Reflect.get(owner, property, receiver) as unknown;
        if (property !== method) return value;
        return (root: string, options?: unknown) => {
          opened.push(options);
          return (value as (root: string, options?: unknown) => unknown).call(owner, root, options);
        };
      },
    });
  const spy = { ...real, CodeGraph: recording(real.CodeGraph, "openSync"), DatabaseConnection: recording(real.DatabaseConnection, "open") };
  const reader = unwrap(createCodeGraph({ ...defaultCodeGraphDeps, loadSdk: () => spy }).open(s.store));
  reader.close();
  assert.deepEqual(opened, [{ readOnly: true }, { readOnly: true }]);
});

test("symbols carry repo-relative paths and line ranges, sorted whatever order the files are asked in", async () => {
  const s = await shared();
  const forward = s.reader.symbolsInFiles(["src/orders.ts", "src/app.ts"]);
  const backward = s.reader.symbolsInFiles(["src/app.ts", "src/orders.ts"]);
  assert.deepEqual(forward, backward);
  const orders = forward.filter((candidate) => candidate.file === "src/orders.ts").map((candidate) => [candidate.name, candidate.startLine, candidate.endLine]);
  assert.deepEqual(orders, [
    ["loadOrder", 1, 3],
    ["orders.ts", 1, 10],
    ["listOrders", 4, 6],
    ["unknownCall", 7, 9],
  ]);
  assert.deepEqual(
    forward.map((candidate) => candidate.file),
    [...forward.map((candidate) => candidate.file)].sort(),
  );
  assert.deepEqual(s.reader.symbolsInFiles(["src/missing.ts"]), []);
});

test("an empty list of edge kinds asks for no edges, not for all of them", async () => {
  const s = await shared();
  const load = symbol(s.reader, "src/orders.ts", "loadOrder");
  assert.ok(s.reader.incomingEdges([load.id]).length > 0);
  assert.deepEqual(s.reader.incomingEdges([load.id], []), []);
});

test("symbols are found again by the ids they gave", async () => {
  const s = await shared();
  const load = symbol(s.reader, "src/orders.ts", "loadOrder");
  const list = symbol(s.reader, "src/orders.ts", "listOrders");
  const found = s.reader.symbolsByIds([list.id, load.id, "function:nothing" as GraphNodeId]);
  assert.deepEqual(found, [load, list]);
});

test("declarations are found by name: every overload, member and top-level match, in symbol order", async () => {
  const { store, result } = await indexFiles({
    "src/b.ts": "export class Printer {\n  format(value: string): string {\n    return value;\n  }\n}\n",
    "src/a.ts": "export function format(value: string): string {\n  return value;\n}\nexport function other(): void {}\n",
    "java/Fmt.java": "package app;\npublic class Fmt {\n    String format(String v) { return v; }\n    String format(int v) { return \"\"; }\n}\n",
  });
  unwrap(result);
  const reader = unwrap(createCodeGraph().open(store));
  try {
    const declared = reader.symbolsInFiles(["java/Fmt.java", "src/a.ts", "src/b.ts"]).filter((candidate) => candidate.name === "format");
    const found = reader.declarationsNamed(["format", "missing", "format"]);
    assert.deepEqual(found, declared);
    assert.deepEqual(found.map(({ file, kind }) => [file, kind]), [["java/Fmt.java", "method"], ["java/Fmt.java", "method"], ["src/a.ts", "function"], ["src/b.ts", "method"]]);
    assert.deepEqual(reader.declarationsNamed(["other", "format"]), reader.declarationsNamed(["format", "other"]));
    assert.deepEqual(reader.declarationsNamed(["missing"]), []);
  } finally {
    reader.close();
  }
});

test("incoming edges keep their kind, position and score, and can be limited to kinds", async () => {
  const s = await shared();
  const load = symbol(s.reader, "src/orders.ts", "loadOrder");
  const calls = s.reader.incomingEdges([load.id], ["calls"]);
  const names = new Map(s.reader.symbolsByIds(calls.map((edge) => edge.source)).map((candidate) => [candidate.id, candidate.name]));
  assert.deepEqual(
    calls.map((edge) => [names.get(edge.source), edge.kind, edge.line, edge.column, edge.confidence, edge.provenance, edge.synthesizedBy]),
    [
      ["listOrders", "calls", 5, 10, 0.9, null, null],
      ["GET /orders/:id", "calls", 8, 0, 0.9, null, null],
      ["app.ts", "calls", 8, 56, 0.9, null, null],
    ],
  );
  const kinds = new Set(s.reader.incomingEdges([load.id]).map((edge) => edge.kind));
  assert.deepEqual([...kinds].sort(), ["calls", "contains", "imports"]);
});

test("outgoing edges are the ones that leave the nodes, limited to kinds, and none for no kinds", async () => {
  const s = await shared();
  const list = symbol(s.reader, "src/orders.ts", "listOrders");
  const load = symbol(s.reader, "src/orders.ts", "loadOrder");
  const calls = s.reader.outgoingEdges([list.id], ["calls"]);
  assert.deepEqual(calls.map((edge) => [edge.source, edge.target, edge.kind]), [[list.id, load.id, "calls"]]);
  assert.deepEqual(s.reader.outgoingEdges([list.id], []), []);
  assert.ok(s.reader.outgoingEdges([list.id]).every((edge) => edge.source === list.id));
});

test("an edge an interface bridge added is heuristic, named and has no score", async () => {
  const s = await shared();
  const impl = symbol(s.reader, "java/RepoImpl.java", "save");
  const [bridge] = s.reader.incomingEdges([impl.id], ["calls"]);
  assert.ok(bridge);
  assert.equal(s.reader.symbolsByIds([bridge.source])[0]?.file, "java/Repo.java");
  assert.deepEqual([bridge.provenance, bridge.synthesizedBy, bridge.confidence], ["heuristic", "interface-impl", null]);
});

test("unresolved references name the call that left the index, whatever order the files are asked in", async () => {
  const s = await shared();
  const unknown = symbol(s.reader, "src/orders.ts", "unknownCall");
  const forward = s.reader.unresolvedReferences(["src/app.ts", "src/orders.ts"]);
  assert.deepEqual(forward, s.reader.unresolvedReferences(["src/orders.ts", "src/app.ts"]));
  assert.deepEqual(
    forward
      .filter((reference) => ["startServer", "externalThing"].includes(reference.name))
      .map((reference) => [reference.file, reference.name, reference.kind, reference.line, reference.column]),
    [
      ["src/app.ts", "startServer", "calls", 9, 0],
      ["src/orders.ts", "externalThing", "calls", 8, 2],
    ],
  );
  assert.deepEqual(forward.find((reference) => reference.name === "externalThing"), { from: unknown.id, name: "externalThing", kind: "calls", file: "src/orders.ts", line: 8, column: 2, candidates: [] });
});

test("a file with more unresolved references than codegraph's default cap is read whole", async () => {
  const calls = 5100;
  const body = Array.from({ length: calls }, (_, index) => `  missing${index}();`).join("\n");
  const graph = createCodeGraph();
  const { store } = await indexFiles({ "src/many.ts": `export function many(): void {\n${body}\n}\n` }, graph);
  const reader = unwrap(graph.open(store));
  assert.equal(reader.unresolvedReferences(["src/many.ts"]).length, calls);
  reader.close();
});

function mirrorOf(files: Readonly<Record<string, string>>): string {
  const dir = join(scratch(), "mirror");
  mkdirSync(dir);
  writeTree(dir, files);
  return dir;
}

test("buildMirror indexes in place, keeps the mirror's files and lets open read it", async () => {
  const mirror = mirrorOf(BASE);
  const summary = unwrap(await createCodeGraph().buildMirror(mirror));
  assert.deepEqual(summary.filesNotIndexed, []);
  assert.equal(summary.filesIndexed, 5);
  const { [INDEX_STORE_DIRECTORY]: _, ...files } = Object.fromEntries(readdirSync(mirror).map((name) => [name, true]));
  assert.deepEqual(Object.keys(files).sort(), ["java", "package.json", "src"]);
  assert.equal(readFileSync(join(mirror, "src/orders.ts"), "utf8"), ORDERS);
  const reader = unwrap(createCodeGraph().open(mirror));
  assert.ok(reader.symbolsInFiles(["src/orders.ts"]).some((candidate) => candidate.name === "loadOrder"));
  reader.close();
});

test("a second buildMirror replaces the store with one that describes the files as they are", async () => {
  const mirror = mirrorOf(BASE);
  const graph = createCodeGraph();
  unwrap(await graph.buildMirror(mirror));
  writeFileSync(join(mirror, "src/orders.ts"), "export function renamedOrder(): void {}\n");
  unwrap(await graph.buildMirror(mirror));
  const reader = unwrap(graph.open(mirror));
  assert.deepEqual(reader.symbolsInFiles(["src/orders.ts"]).filter((candidate) => candidate.kind === "function").map((candidate) => candidate.name), ["renamedOrder"]);
  reader.close();
});

test("syncMirror with no path is refused and runs nothing", async () => {
  const { deps, calls } = recordingDeps(() => NOTHING);
  const result = await createCodeGraph(deps).syncMirror(mirrorOf(BASE), []);
  assert.equal(faultOf(result).kind, "index-failed");
  assert.equal(calls.length, 0);
});

test("a mirror holding a symlink is stage-failed for both builds and syncs", async () => {
  const mirror = mirrorOf(BASE);
  symlinkSync("orders.ts", join(mirror, "src/link.ts"));
  const graph = createCodeGraph();
  assert.equal(faultOf(await graph.buildMirror(mirror)).kind, "stage-failed");
  assert.equal(faultOf(await graph.syncMirror(mirror, ["src/link.ts"])).kind, "stage-failed");
});

test("a codegraph.json left in the mirror is read by the engine: its excluded files are reported as not indexed", async () => {
  const mirror = mirrorOf({ ...BASE, "codegraph.json": '{"exclude":["src/**"]}' });
  const summary = unwrap(await createCodeGraph().buildMirror(mirror));
  assert.deepEqual(summary.filesNotIndexed, ["src/app.ts", "src/orders.ts"]);
});
