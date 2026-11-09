import { test } from "node:test";
import assert from "node:assert/strict";
import { blastRadius } from "./blast-radius.ts";
import type { FileChange } from "./diff-reader.ts";
import { selectSeeds, type ComponentRef, type SeedSymbol } from "./seeds.ts";

interface TestSymbol extends SeedSymbol {
  id: string;
}

function symbol(id: string, kind: string, startLine: number, endLine: number, file = "src/Order.java"): TestSymbol {
  return { id, kind, name: id, file, startLine, endLine };
}

function change(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, deleted: false, binary: false, added: [], removals: [], removedNames: [], hunks: [], ...overrides };
}

function run(files: FileChange[], symbols: TestSymbol[], resources: ReadonlyMap<string, readonly ComponentRef[]> = new Map()) {
  const byFile = Map.groupBy(symbols, (candidate) => candidate.file);
  const selection = selectSeeds(blastRadius("base", files), byFile, resources);
  return {
    seeds: selection.seeds.map(({ symbol, basis }) => `${symbol.id}:${basis}`).toSorted(),
    withoutSymbols: selection.withoutSymbols,
  };
}

function removedBy(files: FileChange[], symbols: TestSymbol[]): string[] {
  const selection = selectSeeds(blastRadius("base", files), Map.groupBy(symbols, (candidate) => candidate.file), new Map());
  return selection.removed.map(({ file, name }) => `${file}:${name}`);
}

const CLASS_WITH_METHODS = [
  symbol("Order", "class", 3, 30),
  symbol("total", "method", 5, 10),
  symbol("tax", "method", 12, 20),
  symbol("rate", "field", 22, 22),
];

test("a touched line seeds the innermost symbol that holds it, not the class around it", () => {
  const { seeds } = run([change("src/Order.java", { added: [{ start: 7, end: 8 }] })], CLASS_WITH_METHODS);
  assert.deepEqual(seeds, ["total:lines"]);
});

test("a line of the class outside its methods seeds the class and no method", () => {
  const { seeds } = run([change("src/Order.java", { added: [{ start: 11, end: 11 }] })], CLASS_WITH_METHODS);
  assert.deepEqual(seeds, ["Order:lines"]);
});

test("a line in a member that is no symbol of its own seeds the class that holds it", () => {
  const { seeds } = run([change("src/Order.java", { added: [{ start: 22, end: 22 }] })], CLASS_WITH_METHODS);
  assert.deepEqual(seeds, ["Order:lines"]);
});

test("a class and its only method on one line seed the method for a line there", () => {
  const oneLine = [symbol("Svc", "class", 9, 9), symbol("load", "method", 9, 9)];
  assert.deepEqual(run([change("src/Order.java", { added: [{ start: 9, end: 9 }] })], oneLine).seeds, ["load:lines"]);
});

test("a line in no symbol of a file that has some seeds its top-level symbols, nested ones not", () => {
  const symbols = [...CLASS_WITH_METHODS, symbol("helper", "function", 40, 45)];
  const { seeds } = run([change("src/Order.java", { added: [{ start: 1, end: 1 }] })], symbols);
  assert.deepEqual(seeds, ["Order:top-level", "helper:top-level"].toSorted());
});

test("a symbol seeded by its lines and by the top-level rule keeps the lines basis", () => {
  const symbols = [...CLASS_WITH_METHODS, symbol("helper", "function", 40, 45)];
  const { seeds } = run([change("src/Order.java", { added: [{ start: 1, end: 1 }, { start: 41, end: 41 }] })], symbols);
  assert.deepEqual(seeds, ["Order:top-level", "helper:lines"].toSorted());
});

test("a changed file with no symbol a walk could start from seeds nothing and is named", () => {
  const nodes = [symbol("Order.java", "file", 1, 5), symbol("shop", "namespace", 1, 1)];
  const selection = run([change("src/Order.java", { added: [{ start: 3, end: 3 }] })], nodes);
  assert.deepEqual(selection, { seeds: [], withoutSymbols: ["src/Order.java"] });
});

test("lines removed from inside a symbol seed it, and a removal between top-level symbols seeds the file's top level", () => {
  const symbols = [symbol("first", "function", 1, 10), symbol("second", "function", 20, 30)];
  assert.deepEqual(run([change("src/Order.java", { removals: [{ after: 5 }] })], symbols).seeds, ["first:lines"]);
  assert.deepEqual(run([change("src/Order.java", { removals: [{ after: 10 }] })], symbols).seeds, ["first:top-level", "second:top-level"]);
});

test("a file git reports as binary seeds every symbol it holds", () => {
  const { seeds } = run([change("src/Order.java", { binary: true })], CLASS_WITH_METHODS);
  assert.deepEqual(seeds, ["Order:lines", "tax:lines", "total:lines"]);
});

test("a deleted file seeds nothing", () => {
  const selection = run([change("src/Order.java", { deleted: true, removals: [{ after: 0 }] })], []);
  assert.deepEqual(selection, { seeds: [], withoutSymbols: [] });
});

test("a changed template or style seeds the component that names it, whether it was edited or deleted", () => {
  const symbols = [symbol("Page", "class", 4, 9, "src/page.component.ts"), symbol("Other", "class", 12, 14, "src/page.component.ts")];
  const resources = new Map<string, readonly ComponentRef[]>([["src/page.component.html", [{ file: "src/page.component.ts", name: "Page", line: 4 }]]]);
  const edited = run([change("src/page.component.html", { added: [{ start: 2, end: 2 }] })], symbols, resources);
  assert.deepEqual(edited.seeds, ["Page:resource"]);
  const deleted = run([change("src/page.component.html", { deleted: true, removals: [{ after: 0 }] })], symbols, resources);
  assert.deepEqual(deleted.seeds, ["Page:resource"]);
});

test("a component whose class changed as well as its template keeps the lines basis", () => {
  const symbols = [symbol("Page", "class", 4, 9, "src/page.component.ts")];
  const resources = new Map<string, readonly ComponentRef[]>([["src/page.component.css", [{ file: "src/page.component.ts", name: "Page", line: 4 }]]]);
  const files = [change("src/page.component.css", { added: [{ start: 1, end: 1 }] }), change("src/page.component.ts", { added: [{ start: 6, end: 6 }] })];
  assert.deepEqual(run(files, symbols, resources).seeds, ["Page:lines"]);
});

test("a component is found by its name when another class holds the same line", () => {
  const symbols = [symbol("Outer", "class", 4, 9, "src/page.component.ts"), symbol("Inner", "class", 5, 6, "src/page.component.ts")];
  const resources = new Map<string, readonly ComponentRef[]>([["a.html", [{ file: "src/page.component.ts", name: "Inner", line: 5 }]]]);
  assert.deepEqual(run([change("a.html", { added: [{ start: 1, end: 1 }] })], symbols, resources).seeds, ["Inner:resource"]);
});

test("lines removed from a file with no symbol, and files that are no source, are not reported", () => {
  const files = [change("src/Order.java", { removals: [{ after: 3 }] }), change("docs/readme.md", { added: [{ start: 1, end: 2 }] })];
  assert.deepEqual(run(files, []), { seeds: [], withoutSymbols: [] });
});

test("a component the graph holds no class for seeds nothing", () => {
  const resources = new Map<string, readonly ComponentRef[]>([["a.html", [{ file: "src/page.component.ts", name: "Page", line: 4 }]]]);
  assert.deepEqual(run([change("a.html", { added: [{ start: 1, end: 1 }] })], [], resources).seeds, []);
});

test("the names a deletion removed are reported whether or not a symbol holds the removal, and the holder still seeds", () => {
  const symbols = [symbol("first", "function", 1, 10), symbol("second", "function", 20, 30)];
  const inside = change("src/Order.java", { removals: [{ after: 5 }], removedNames: ["inner"] });
  const between = change("src/Order.java", { removals: [{ after: 10 }], removedNames: ["gone", "alsoGone"] });
  assert.deepEqual(removedBy([inside], symbols), ["src/Order.java:inner"]);
  assert.deepEqual(run([inside], symbols).seeds, ["first:lines"]);
  assert.deepEqual(removedBy([between], symbols), ["src/Order.java:gone", "src/Order.java:alsoGone"]);
});

test("a deleted source file and a file with no symbol report the names they lost", () => {
  const deleted = change("src/Gone.java", { deleted: true, removals: [{ after: 0 }], removedNames: ["Gone"] });
  const bare = change("src/Order.java", { removals: [{ after: 3 }], removedNames: ["lost"] });
  assert.deepEqual(removedBy([deleted, bare], []), ["src/Gone.java:Gone", "src/Order.java:lost"]);
});

test("a deletion in a file that is no source reports no name", () => {
  const readme = change("docs/readme.md", { removals: [{ after: 3 }], removedNames: ["lost"] });
  assert.deepEqual(removedBy([readme], []), []);
});
