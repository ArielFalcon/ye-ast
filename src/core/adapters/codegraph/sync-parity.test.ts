import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeGraphReader, GraphNodeId } from "../../ports/code-graph.port.ts";
import { createCodeGraph } from "./codegraph.adapter.ts";

const BASE: Readonly<Record<string, string>> = {
  "src/orders.ts": "export function loadOrder(id: string): string {\n  return id;\n}\nexport function listOrders(): string[] {\n  return [loadOrder(\"1\")];\n}\n",
  "src/app.ts": "import { listOrders, loadOrder } from \"./orders\";\nexport function handle(): string[] {\n  return listOrders().concat(loadOrder(\"2\"));\n}\nexport function later(): void {\n  futureThing();\n}\n",
  "src/gone.ts": "export function goneThing(): number {\n  return 1;\n}\n",
  "src/use-gone.ts": "import { goneThing } from \"./gone\";\nexport function useGone(): number {\n  return goneThing();\n}\n",
  "java/Repo.java": "package app;\npublic interface Repo {\n    void save(String v);\n}\n",
  "java/RepoImpl.java": "package app;\npublic class RepoImpl implements Repo {\n    public void save(String v) {\n    }\n}\n",
  "java/Svc.java": "package app;\npublic class Svc {\n    private final Repo repo;\n    public Svc(Repo repo) { this.repo = repo; }\n    public void run() {\n        repo.save(\"a\");\n    }\n}\n",
  "package.json": JSON.stringify({ dependencies: { "@angular/core": "20.0.0", "@angular/router": "20.0.0" } }),
  "web/app.routes.ts": "import { Routes } from \"@angular/router\";\nexport const routes: Routes = [\n  { path: \"article/:slug\", loadComponent: () => import(\"./article.component\") },\n  { path: \"list\", loadComponent: () => import(\"./list.component\") },\n];\n",
  "web/article.component.ts": "import { Component } from \"@angular/core\";\n@Component({ selector: \"app-article\", template: \"\" })\nexport default class ArticleComponent {}\n",
  "web/list.component.ts": "import { Component, inject } from \"@angular/core\";\nimport { Router } from \"@angular/router\";\n@Component({ selector: \"app-list\", templateUrl: \"./list.component.html\" })\nexport default class ListComponent {\n  private readonly router = inject(Router);\n  open(slug: string) {\n    this.router.navigate([\"/article\", slug]);\n  }\n}\n",
  "web/inline.component.ts": "import { Component } from \"@angular/core\";\n@Component({ selector: \"app-inline\", template: \"<p>Inline</p>\" })\nexport default class InlineComponent {}\n",
  "web/list.component.html": "<a routerLink=\"/article\">Read</a>\n",
};

type Files = Readonly<Record<string, string | null>>;

interface Shape {
  name: string;
  change: Files;
  /** The changed paths the engine does not parse; the edges it synthesizes from them may differ from a fresh build. */
  unparsed?: readonly string[];
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
  { name: "only a component's template changes", change: { "web/list.component.html": "<a routerLink=\"/article\">Read</a>\n<a routerLink=\"/list\">Back</a>\n" }, unparsed: ["web/list.component.html"] },
  { name: "only a template starts using a child component", change: { "web/list.component.html": "<a routerLink=\"/article\">Read</a>\n<app-article></app-article>\n" }, unparsed: ["web/list.component.html"] },
  { name: "an inline template starts using a child component and a link", change: { "web/inline.component.ts": BASE["web/inline.component.ts"]!.replace("<p>Inline</p>", "<app-article></app-article><a routerLink=\\\"/list\\\">List</a>") } },
  { name: "the class whose call a router resolver retypes changes", change: { "web/list.component.ts": BASE["web/list.component.ts"]!.replace("navigate([\"/article\", slug]);", "navigate([\"/article\", slug]);\n    this.router.navigate([\"/list\"]);") } },
  { name: "the routes a navigation reaches change", change: { "web/app.routes.ts": BASE["web/app.routes.ts"]!.replace("article/:slug", "post/:slug") } },
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

function projection(reader: CodeGraphReader, files: readonly string[], synthesized: boolean) {
  const symbols = reader.symbolsInFiles(files);
  const name = new Map(symbols.map((symbol) => [symbol.id, `${symbol.file}#${symbol.qualifiedName}`]));
  const label = (id: GraphNodeId) => {
    const target = reader.symbolsByIds([id])[0];
    return name.get(id) ?? (target === undefined ? "?" : `${target.file}#${target.qualifiedName}`);
  };
  return {
    symbols: symbols.map(({ id: _id, ...fields }) => JSON.stringify(fields)).sort(),
    edges: reader
      .outgoingEdges(symbols.map((symbol) => symbol.id))
      .filter((edge) => synthesized || edge.synthesizedBy === null)
      .map(({ source, target, ...fields }) => JSON.stringify({ source: label(source), target: label(target), ...fields }))
      .sort(),
    unresolved: reader
      .unresolvedReferences(files)
      .map(({ from, candidates, ...fields }) => JSON.stringify({ from: label(from), candidates: [...candidates].sort(), ...fields }))
      .sort(),
  };
}

function allFiles(extra: Files): string[] {
  return [...new Set([...Object.keys(BASE), ...Object.keys(extra)])].sort();
}

for (const shape of SHAPES) {
  test(`sync matches a fresh build when ${shape.name}${shape.unparsed === undefined ? "" : ", but for what it synthesizes from the files it names unparsed"}`, async () => {
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
      const synthesized = shape.unparsed === undefined;
      assert.deepEqual(projection(liveReader.value, files, synthesized), projection(freshReader.value, files, synthesized));
      assert.deepEqual(synced.value.filesUnparsed, shape.unparsed ?? []);
      assert.deepEqual(synced.value.filesNotIndexed, rebuilt.value.filesNotIndexed);
      assert.deepEqual(synced.value.filesFailed, []);
    } finally {
      liveReader.value.close();
      freshReader.value.close();
    }
  });
}
