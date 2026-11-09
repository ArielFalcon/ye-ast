import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import type { DeclaredEntry, DeclaredTrees } from "../../ports/declared-tree.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { TypeBindings, TypeBindingsAnswer } from "../../ports/type-bindings.port.ts";
import { REPOSITORY_ROOT, createConfinedHost } from "./confined-compiler-host.ts";
import { createTypeBindings } from "./type-bindings.adapter.ts";

const OUTPUT: DeclaredBuildOutput = { kind: "node-modules", at: "", path: "/host/checkout/node_modules" };
const CONFIG = JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", lib: ["es2022"], module: "ESNext", moduleResolution: "bundler", types: [] }, include: ["src", "libs"] });

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-bindings-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A declared directory holding `files`; a path under a key of `links` answers that entry, a `snapshot` one joined with the rest. */
function declared(files: Record<string, string>, links: Record<string, DeclaredEntry> = {}): DeclaredTrees {
  const entry = (path: string): DeclaredEntry => {
    for (const [link, linked] of Object.entries(links)) {
      if (path !== link && !path.startsWith(`${link}/`)) continue;
      return linked.kind === "snapshot" ? { kind: "snapshot", path: posix.join(linked.path, path.slice(link.length + 1)) } : linked;
    }
    const content = files[path];
    if (content !== undefined) return { kind: "file", path, content };
    const prefix = path === "" ? "" : `${path}/`;
    const names = [...new Set([...Object.keys(files), ...Object.keys(links)].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length).split("/")[0]!))];
    return names.length === 0 ? { kind: "absent" } : { kind: "directory", path, names: names.toSorted() };
  };
  return { open: () => ({ entry }) };
}

const DIGEST: Digest = { of: (text) => text };

function bound(answer: TypeBindingsAnswer): Extract<TypeBindingsAnswer, { status: "bound" }> {
  assert.equal(answer.status, "bound");
  return answer as Extract<TypeBindingsAnswer, { status: "bound" }>;
}

/** Derived facts that keep a value once its derivation resolved, and count the derivations they ran. */
function memo(): DerivedFacts & { derivations: number } {
  const kept = new Map<string, unknown>();
  const facts = {
    derivations: 0,
    ofFile: <T>(_slot: string, _file: SourceFile, derive: () => T) => derive(),
    async ofInputs<T>(slot: string, inputs: object, derive: () => Promise<T>): Promise<T> {
      const key = `${slot}${JSON.stringify(inputs)}`;
      if (kept.has(key)) return kept.get(key) as T;
      facts.derivations += 1;
      const value = await derive();
      kept.set(key, value);
      return value;
    },
    fingerprint: (inputs: object) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
  return facts;
}

/** Bindings asked with `facts` on every call, as a query hands over its snapshot's derived facts. */
function withFacts(bindings: TypeBindings, facts: DerivedFacts): TypeBindings {
  return { of: (snapshot, outputs, signal) => bindings.of(snapshot, outputs, signal, facts) };
}

function sources(files: Record<string, string>): SourceFile[] {
  return Object.entries(files).map(([path, content]) => ({ path, content }));
}

test("a call, placed where it starts, binds the declaration its callee's name binds by type, a package's or the repository's, and an any binds nothing", async () => {
  const answer = await createTypeBindings({
    digest: DIGEST,
    trees: declared({
      "router-kit/package.json": JSON.stringify({ name: "router-kit", version: "1.0.0", types: "index.d.ts" }),
      "router-kit/index.d.ts": "export interface ParamMap { get(name: string): string | null; }\nexport interface Signal<T> { (): T; get(): T; }\nexport declare function signal<T>(value: T): Signal<T>;",
    }),
  }).of(
    sources({
      "tsconfig.json": CONFIG,
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/router-kit": { version: "1.0.0" } } }),
      "src/crud.ts": "export class CrudService {\n  get(id: number): number { return id; }\n}",
      "src/page.ts": [
        'import { signal, type ParamMap } from "router-kit";',
        'import { CrudService } from "./crud";',
        "export class Page {",
        '  readonly term = signal("x");',
        "  constructor(private map: ParamMap, private crud: CrudService) {}",
        "  load(raw: any) {",
        '    this.map.get("id");',
        "    this.crud.get(1);",
        "    raw.get(2);",
        "    this.term();",
        "  }",
        "}",
      ].join("\n"),
    }),
    [OUTPUT],
  );
  assert.deepEqual(
    bound(answer).bindings.filter(({ file, name }) => file === "src/page.ts" && (name === "get" || name === "term")).map(({ line, column, target }) => ({ line, column, target })),
    [
      { line: 7, column: 5, target: { kind: "external", module: "router-kit", name: "get" } },
      { line: 8, column: 5, target: { kind: "repository", file: "src/crud.ts", line: 2, name: "get" } },
      { line: 10, column: 5, target: { kind: "repository", file: "src/page.ts", line: 4, name: "term" } },
    ],
  );
});

test("a source takes the options of the configuration that owns it through references, one no configuration owns is named, and a test file is not bound", async () => {
  const answer = await createTypeBindings({ digest: DIGEST, trees: declared({}) }).of(
    sources({
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { lib: ["es2022"], types: [], baseUrl: ".", paths: { "@core/*": ["src/core/*"] } }, include: ["src/**/*.ts"] }),
      "src/core/util.ts": "export function helper(): void {}",
      "src/app.ts": 'import { helper } from "@core/util";\nhelper();',
      "scripts/tool.ts": "export const tool = 1;",
      "src/app.spec.ts": 'import { helper } from "@core/util";\nhelper();',
    }),
    [],
  );
  assert.deepEqual(bound(answer).bindings.filter(({ file }) => file === "src/app.ts").map(({ target }) => target), [{ kind: "repository", file: "src/core/util.ts", line: 1, name: "helper" }]);
  assert.deepEqual(bound(answer).unowned, [{ file: "scripts/tool.ts", configurations: ["tsconfig.json"] }]);
  assert.deepEqual(bound(answer).bindings.filter(({ file }) => file === "src/app.spec.ts"), []);
});

test("a package linked into the repository binds the repository's declaration, and a link refused by the tree is named", async () => {
  const answer = await createTypeBindings({
    digest: DIGEST,
    trees: declared({}, { "@app/shared": { kind: "snapshot", path: "libs/shared" }, evil: { kind: "refused", link: "node_modules/evil" } }),
  }).of(
    sources({
      "tsconfig.json": CONFIG,
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
      "libs/shared/package.json": JSON.stringify({ name: "@app/shared", version: "1.0.0", types: "index.ts" }),
      "libs/shared/index.ts": "export function shared(): void {}",
      "src/use.ts": 'import { shared } from "@app/shared";\nimport { evil } from "evil";\nshared();\nevil();',
    }),
    [OUTPUT],
  );
  assert.deepEqual(bound(answer).bindings.filter(({ file }) => file === "src/use.ts").map(({ name, target }) => ({ name, target })), [{ name: "shared", target: { kind: "repository", file: "libs/shared/index.ts", line: 1, name: "shared" } }]);
  assert.deepEqual(bound(answer).refused, ["node_modules/evil"]);
});

test("the compiler's host answers no path outside the snapshot, the declared directories and its own libraries", async () => {
  const outside = join(scratch, "outside.d.ts");
  await writeFile(outside, "export declare function outside(): void;");
  const { host } = createConfinedHost(sources({ "tsconfig.json": CONFIG }), [OUTPUT], declared({ "pkg/index.d.ts": "export {};" }));
  for (const path of [outside, `${REPOSITORY_ROOT}/../${outside}`, `${REPOSITORY_ROOT}/node_modules/../../${outside}`, "/lib/../etc/hosts"]) {
    assert.equal(host.fileExists(path), false, path);
    assert.equal(host.readFile(path), undefined, path);
  }
  assert.equal(host.fileExists(`${REPOSITORY_ROOT}/node_modules/pkg/index.d.ts`), true);
});

const KIT = { "kit/package.json": JSON.stringify({ name: "kit", version: "2.0.0", types: "index.d.ts" }), "kit/index.d.ts": "export declare function make(): void;" };
const USE_KIT = { "tsconfig.json": CONFIG, "src/use.ts": 'import { make } from "kit";\nmake();' };
const lock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/kit": { version } } });

test("a declaration whose package the lockfile states at another version is unused, naming the package and both versions", async () => {
  const answer = await createTypeBindings({ digest: DIGEST, trees: declared(KIT) }).of(sources({ ...USE_KIT, "package-lock.json": lock("1.0.0") }), [OUTPUT]);
  assert.deepEqual(answer, { status: "unused", outputs: [{ kind: "node-modules", at: "", stale: [{ path: "kit", installed: "2.0.0", locked: "1.0.0" }] }] });
});

test("a kept answer is used only while every declared path it read answers the same", async () => {
  const files: Record<string, string> = { ...KIT };
  const facts = memo();
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: declared(files) }), facts);
  const snapshot = sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") });
  const made = async () => bound(await bindings.of(snapshot, [OUTPUT])).bindings.filter(({ name }) => name === "make").length;
  assert.equal(await made(), 1);
  files["kit/index.d.ts"] = "export {};";
  assert.equal(await made(), 0);
  assert.equal(facts.derivations, 1);
});

test("requests for one key share one derivation", async () => {
  const facts = memo();
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT) }), facts);
  const snapshot = sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") });
  await Promise.all([bindings.of(snapshot, [OUTPUT]), bindings.of(snapshot, [OUTPUT])]);
  assert.equal(facts.derivations, 1);
});

/** `facts` whose derivations start only once `open` is called, so a test can act while a pass is in flight. */
function gated(facts: DerivedFacts & { derivations: number }): DerivedFacts & { derivations: number; open(): void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return Object.assign(facts, {
    open,
    ofInputs: ((ofInputs) => <T>(slot: string, inputs: object, derive: () => Promise<T>) => ofInputs(slot, inputs, async () => (await gate, derive())))(facts.ofInputs.bind(facts)),
  });
}

test("the requester that started a shared pass aborting cuts neither the pass nor its other waiters, and the pass is kept once", async () => {
  const facts = gated(memo());
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT) }), facts);
  const snapshot = sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") });
  const first = new AbortController();
  const started = bindings.of(snapshot, [OUTPUT], first.signal);
  const waiting = bindings.of(snapshot, [OUTPUT], new AbortController().signal);
  first.abort();
  facts.open();
  await assert.rejects(started, { name: "AbortError" });
  assert.equal(bound(await waiting).bindings.filter(({ name }) => name === "make").length, 1);
  await bindings.of(snapshot, [OUTPUT]);
  assert.equal(facts.derivations, 1);
});

test("a waiter's abort ends its own wait while the pass it shares is still running", async () => {
  const facts = gated(memo());
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT) }), facts);
  const snapshot = sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") });
  const started = bindings.of(snapshot, [OUTPUT], new AbortController().signal);
  const waiter = new AbortController();
  const settled: string[] = [];
  const waiting = bindings.of(snapshot, [OUTPUT], waiter.signal).finally(() => settled.push("waiter"));
  void started.finally(() => settled.push("pass"));
  waiter.abort();
  facts.open();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(bound(await started).bindings.filter(({ name }) => name === "make").length, 1);
  assert.deepEqual(settled, ["waiter", "pass"]);
  assert.equal(facts.derivations, 1);
});

test("a requester aborted while its shared pass is being registered rejects instead of waiting for the pass", async () => {
  const facts = memo();
  const requester = new AbortController();
  const ofInputs = facts.ofInputs.bind(facts);
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT) }), Object.assign(facts, {
    ofInputs: <T>(slot: string, inputs: object, derive: () => Promise<T>) => (requester.abort(), ofInputs(slot, inputs, derive)),
  }));
  await assert.rejects(bindings.of(sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") }), [OUTPUT], requester.signal), { name: "AbortError" });
});

test("shutdown aborts a shared pass: every waiter rejects and nothing is kept", async () => {
  const facts = gated(memo());
  const shutdown = new AbortController();
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT), shutdown: shutdown.signal }), facts);
  const snapshot = sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") });
  const waiting = [bindings.of(snapshot, [OUTPUT], new AbortController().signal), bindings.of(snapshot, [OUTPUT], new AbortController().signal)];
  shutdown.abort();
  facts.open();
  for (const each of waiting) await assert.rejects(each, { name: "AbortError" });
  bound(await withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT) }), facts).of(snapshot, [OUTPUT]));
  assert.equal(facts.derivations, 2);
});

test("a derivation whose deadline passed rejects instead of answering what it had bound", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT) }), memo()).of(sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") }), [OUTPUT], signal), { name: "AbortError" });
});

test("a snapshot without a lockfile uses the declaration and states it unverified", async () => {
  const answer = bound(await createTypeBindings({ digest: DIGEST, trees: declared(KIT) }).of(sources(USE_KIT), [OUTPUT]));
  assert.deepEqual(answer.outputs.map(({ at, verified }) => ({ at, verified })), [{ at: "", verified: false }]);
  assert.equal(answer.bindings.filter(({ name }) => name === "make").length, 1);
});

test("a kept answer is not used once the snapshot's lockfile changed", async () => {
  const facts = memo();
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: declared(KIT) }), facts);
  assert.equal((await bindings.of(sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") }), [OUTPUT])).status, "bound");
  assert.equal((await bindings.of(sources({ ...USE_KIT, "package-lock.json": lock("1.0.0") }), [OUTPUT])).status, "unused");
  assert.equal(facts.derivations, 2);
});

test("a declared directory that will not be read is a fault naming each path, never kept, and binds nothing from it", async () => {
  const unreadable: DeclaredTrees = { open: () => ({ entry: (path) => (path === "" ? declared(KIT).open(OUTPUT).entry(path) : { kind: "unreadable", path: "kit" }) }) };
  const facts = memo();
  const bindings = withFacts(createTypeBindings({ digest: DIGEST, trees: unreadable }), facts);
  const snapshot = sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") });
  for (let ask = 0; ask < 2; ask += 1) assert.deepEqual(await bindings.of(snapshot, [OUTPUT]), { status: "fault", fault: { kind: "unreadable", outputs: [{ kind: "node-modules", at: "", paths: ["kit"] }] } });
  assert.equal(facts.derivations, 2);
  const root: DeclaredTrees = { open: () => ({ entry: () => ({ kind: "unreadable", path: "" }) }) };
  assert.deepEqual(await createTypeBindings({ digest: DIGEST, trees: root }).of(sources({ "tsconfig.json": CONFIG, "src/plain.ts": "export const plain = 1;" }), [OUTPUT]), { status: "fault", fault: { kind: "unreadable", outputs: [{ kind: "node-modules", at: "", paths: [""] }] } });
});

test("the compiler failing while it binds is a fault, not an exception out of the query", async () => {
  const crashing: DeclaredTrees = { open: () => ({ entry: (path) => (path.startsWith("kit") ? (() => { throw new Error("Debug Failure. False expression."); })() : declared(KIT).open(OUTPUT).entry(path)) }) };
  const answer = await withFacts(createTypeBindings({ digest: DIGEST, trees: crashing }), memo()).of(sources({ ...USE_KIT, "package-lock.json": lock("2.0.0") }), [OUTPUT]);
  assert.equal(answer.status === "fault" && answer.fault.kind, "checker-failed");
});
