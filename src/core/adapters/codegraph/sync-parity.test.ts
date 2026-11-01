import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import { createCodeGraph } from "./codegraph.adapter.ts";

const BASE: Readonly<Record<string, string>> = {
  "src/orders.ts": "export function loadOrder(id: string): string {\n  return id;\n}\nexport function listOrders(): string[] {\n  return [loadOrder(\"1\")];\n}\n",
  "src/app.ts": "import { listOrders, loadOrder } from \"./orders\";\nexport function handle(): string[] {\n  return listOrders().concat(loadOrder(\"2\"));\n}\nexport function later(): void {\n  futureThing();\n}\n",
  "src/gone.ts": "export function goneThing(): number {\n  return 1;\n}\n",
  "src/use-gone.ts": "import { goneThing } from \"./gone\";\nexport function useGone(): number {\n  return goneThing();\n}\n",
  "java/Repo.java": "package app;\npublic interface Repo {\n    void save(String v);\n}\n",
  "java/RepoImpl.java": "package app;\npublic class RepoImpl implements Repo {\n    public void save(String v) {\n    }\n}\n",
  "java/Svc.java": "package app;\npublic class Svc {\n    private final Repo repo;\n    public Svc(Repo repo) { this.repo = repo; }\n    public void run() {\n        repo.save(\"a\");\n    }\n}\n",
};

type Files = Readonly<Record<string, string | null>>;

interface Shape {
  name: string;
  change: Files;
}

const SHAPES: readonly Shape[] = [
  { name: "a file is added", change: { "src/extra.ts": "export function extra(): number {\n  return 2;\n}\n" } },
  { name: "a file is modified", change: { "src/gone.ts": "export function goneThing(): number {\n  return 1;\n}\nexport function more(): number {\n  return goneThing();\n}\n" } },
  { name: "a file is deleted", change: { "src/gone.ts": null } },
  {
    name: "a symbol used elsewhere is renamed",
    change: { "src/orders.ts": BASE["src/orders.ts"]!.replaceAll("loadOrder", "fetchOrder") },
  },
  { name: "a definition appears for a reference left unresolved in an unchanged file", change: { "src/future.ts": "export function futureThing(): void {\n}\n" } },
  { name: "a definition is removed from a surviving file whose callers stay", change: { "src/gone.ts": "export function other(): number {\n  return 1;\n}\n" } },
  { name: "a Java implementation is added for an interface", change: { "java/Repo2.java": "package app;\npublic class Repo2 implements Repo {\n    public void save(String v) {\n    }\n}\n" } },
];

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mirrorOf(files: Files): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ye-ast-parity-")), "mirror");
  scratches.push(dirname(dir));
  mkdirSync(dir);
  apply(dir, files);
  return dir;
}

function apply(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) unlinkSync(join(root, path));
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }
}

const graph = createCodeGraph();

function projection(reader: CodeGraphReader, files: readonly string[]) {
  const symbols = reader.symbolsInFiles(files);
  const name = new Map(symbols.map((symbol) => [symbol.id, `${symbol.file}#${symbol.qualifiedName}`]));
  const label = (id: string) => name.get(id as never) ?? reader.symbolsByIds([id as never])[0]?.qualifiedName ?? "?";
  const edges = reader
    .outgoingEdges(symbols.map((symbol) => symbol.id))
    .map((edge) => [name.get(edge.source), label(edge.target), reader.symbolsByIds([edge.target])[0]?.file ?? "?", edge.kind, edge.line, edge.column, edge.confidence, edge.provenance, edge.synthesizedBy].join("|"))
    .sort();
  return {
    symbols: symbols.map((symbol) => [symbol.file, symbol.kind, symbol.name, symbol.qualifiedName, symbol.startLine, symbol.endLine].join("|")).sort(),
    edges,
    unresolved: reader
      .unresolvedReferences(files)
      .map((reference) => [reference.file, name.get(reference.from) ?? "?", reference.name, reference.kind, reference.line, reference.column, [...reference.candidates].sort().join(",")].join("|"))
      .sort(),
  };
}

function allFiles(extra: Files): string[] {
  return [...new Set([...Object.keys(BASE), ...Object.keys(extra)])].sort();
}

for (const shape of SHAPES) {
  test(`sync matches a fresh build when ${shape.name}`, async () => {
    const live = mirrorOf(BASE);
    const built = await graph.buildMirror(live);
    assert.ok(built.ok);
    apply(live, shape.change);
    const synced = await graph.syncMirror(live, Object.keys(shape.change));
    assert.ok(synced.ok, synced.ok ? "" : synced.fault.detail);

    const fresh = mirrorOf({});
    cpSync(live, fresh, { recursive: true, filter: (source) => !source.endsWith(".ye-ast-graph") });
    const rebuilt = await graph.buildMirror(fresh);
    assert.ok(rebuilt.ok);

    const files = allFiles(shape.change);
    const liveReader = graph.open(live);
    const freshReader = graph.open(fresh);
    assert.ok(liveReader.ok && freshReader.ok);
    try {
      assert.deepEqual(projection(liveReader.value, files), projection(freshReader.value, files));
      assert.deepEqual(synced.value.filesNotIndexed, rebuilt.value.filesNotIndexed);
      assert.deepEqual(synced.value.filesFailed, []);
    } finally {
      liveReader.value.close();
      freshReader.value.close();
    }
  });
}
