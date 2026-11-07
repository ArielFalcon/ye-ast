import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import type { DeclaredEntry, DeclaredTrees } from "../../ports/declared-tree.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
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

function sources(files: Record<string, string>): SourceFile[] {
  return Object.entries(files).map(([path, content]) => ({ path, content }));
}

test("a call binds the declaration its callee's name binds by type, a package's or the repository's, and an any binds nothing", async () => {
  const answer = await createTypeBindings({
    trees: declared({
      "router-kit/package.json": JSON.stringify({ name: "router-kit", version: "1.0.0", types: "index.d.ts" }),
      "router-kit/index.d.ts": "export interface ParamMap { get(name: string): string | null; }\nexport interface Signal<T> { (): T; get(): T; }\nexport declare function signal<T>(value: T): Signal<T>;",
    }),
  }).of(
    sources({
      "tsconfig.json": CONFIG,
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
    answer.bindings.filter(({ file, name }) => file === "src/page.ts" && (name === "get" || name === "term")).map(({ line, target }) => ({ line, target })),
    [
      { line: 7, target: { kind: "external", module: "router-kit", name: "get" } },
      { line: 8, target: { kind: "repository", file: "src/crud.ts", line: 2, name: "get" } },
      { line: 10, target: { kind: "repository", file: "src/page.ts", line: 4, name: "term" } },
    ],
  );
});

test("a source takes the options of the configuration that owns it through references, and one no configuration owns is named", async () => {
  const answer = await createTypeBindings({ trees: declared({}) }).of(
    sources({
      "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { lib: ["es2022"], types: [], baseUrl: ".", paths: { "@core/*": ["src/core/*"] } }, include: ["src/**/*.ts"] }),
      "src/core/util.ts": "export function helper(): void {}",
      "src/app.ts": 'import { helper } from "@core/util";\nhelper();',
      "scripts/tool.ts": "export const tool = 1;",
    }),
    [],
  );
  assert.deepEqual(answer.bindings.filter(({ file }) => file === "src/app.ts").map(({ target }) => target), [{ kind: "repository", file: "src/core/util.ts", line: 1, name: "helper" }]);
  assert.deepEqual(answer.unowned, [{ file: "scripts/tool.ts", configurations: ["tsconfig.json"] }]);
});

test("a package linked into the repository binds the repository's declaration, and a link refused by the tree is named", async () => {
  const answer = await createTypeBindings({
    trees: declared({}, { "@app/shared": { kind: "snapshot", path: "libs/shared" }, evil: { kind: "refused", link: "node_modules/evil" } }),
  }).of(
    sources({
      "tsconfig.json": CONFIG,
      "libs/shared/package.json": JSON.stringify({ name: "@app/shared", version: "1.0.0", types: "index.ts" }),
      "libs/shared/index.ts": "export function shared(): void {}",
      "src/use.ts": 'import { shared } from "@app/shared";\nimport { evil } from "evil";\nshared();\nevil();',
    }),
    [OUTPUT],
  );
  assert.deepEqual(answer.bindings.filter(({ file }) => file === "src/use.ts").map(({ name, target }) => ({ name, target })), [{ name: "shared", target: { kind: "repository", file: "libs/shared/index.ts", line: 1, name: "shared" } }]);
  assert.deepEqual(answer.refused, ["node_modules/evil"]);
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
