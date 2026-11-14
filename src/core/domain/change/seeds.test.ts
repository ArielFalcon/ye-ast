import { test } from "node:test";
import assert from "node:assert/strict";
import { blastRadius } from "./blast-radius.ts";
import type { FileChange, Hunk, LineRange } from "./diff-reader.ts";
import type { FileTokens } from "./import-seeds.ts";
import { selectSeeds, type ComponentRef, type SeedSymbol } from "./seeds.ts";
import type { ImportBinding, ImportOrder, TokenReading } from "./source-tokens.ts";

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

test("a removal's place seeds its holder as a walk start, and an added line of that symbol makes it a target too", () => {
  const byFile = Map.groupBy(CLASS_WITH_METHODS, (candidate) => candidate.file);
  const removedAt = (after: number): FileChange => change("src/Order.java", { added: [], removals: [{ after }] });
  const held = selectSeeds(blastRadius("base", [removedAt(5)]), byFile, new Map());
  assert.deepEqual(held.seeds.map(({ symbol, basis }) => `${symbol.id}:${basis}`), ["total:lines"]);
  assert.deepEqual(held.removalHolders.map((symbol) => symbol.id), ["total"]);
  const between = selectSeeds(blastRadius("base", [removedAt(31)]), byFile, new Map());
  assert.deepEqual(between.seeds.map(({ symbol, basis }) => `${symbol.id}:${basis}`), ["Order:top-level"]);
  assert.deepEqual(between.removalHolders.map((symbol) => symbol.id), ["Order"]);
  const touched = selectSeeds(blastRadius("base", [change("src/Order.java", { added: [{ start: 7, end: 7 }], removals: [{ after: 5 }] })]), byFile, new Map());
  assert.deepEqual(touched.seeds.map(({ symbol, basis }) => `${symbol.id}:${basis}`), ["total:lines"]);
  assert.deepEqual(touched.removalHolders, []);
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

interface Line {
  text: string;
  binds?: readonly ImportBinding[];
}

/** A reading of `lines`: one token per word or sign, and every line that starts with `import` an import declaration. */
function reading(lines: readonly (string | Line)[], importOrder: ImportOrder = "insignificant"): TokenReading {
  const tokens: TokenReading["tokens"][number][] = [];
  const imports: TokenReading["imports"][number][] = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const { text, binds } = typeof line === "string" ? { text: line, binds: undefined } : line;
    for (const word of text.matchAll(/[A-Za-z_$][\w$]*|\S/g)) tokens.push({ start: index + 1, end: index + 1, text: word[0], startOffset: offset + word.index, endOffset: offset + word.index + word[0].length });
    if (text.startsWith("import")) imports.push({ start: offset, end: offset + text.length, ...(binds === undefined ? {} : { binds }) });
    offset += text.length + 1;
  });
  return { status: "read", language: "java", tokens, imports, importOrder };
}

const MONEY: Line = { text: "import shop.Money;", binds: [{ name: "Money", source: "shop.Money" }] };
const FILLER = "x;";

/** Thirty lines for CLASS_WITH_METHODS: `total` (lines 5-10) writes `Money` at line 7, the other lines write nothing of interest. */
function body(overrides: Record<number, string | Line> = {}): (string | Line)[] {
  return Array.from({ length: 30 }, (_, index) => overrides[index + 1] ?? (index + 1 === 7 ? "Money m;" : FILLER));
}

const hunk = (head?: LineRange, base?: LineRange): Hunk => ({ ...(head === undefined ? {} : { head }), ...(base === undefined ? {} : { base }), removedNames: [] });

function runWith(file: FileChange, tokens: FileTokens | undefined, symbols: TestSymbol[] = CLASS_WITH_METHODS) {
  const selection = selectSeeds(blastRadius("base", [file]), Map.groupBy(symbols, (candidate) => candidate.file), new Map(), undefined, tokens === undefined ? new Map() : new Map([[file.path, tokens]]));
  return { seeds: selection.seeds.map(({ symbol, basis }) => `${symbol.id}:${basis}`).toSorted(), holders: selection.removalHolders.map((holder) => holder.id) };
}

const ADDED_IMPORT = change("src/Order.java", { added: [{ start: 1, end: 1 }], hunks: [hunk({ start: 1, end: 1 })] });

test("an added import seeds the method that writes its name and neither the class nor the methods that do not", () => {
  const tokens = { base: reading(body()), head: reading(body({ 1: MONEY })) };
  assert.deepEqual(runWith(ADDED_IMPORT, tokens).seeds, ["total:lines"]);
});

test("a requested range over an import has no base and seeds the declarations that write what the import binds", () => {
  assert.deepEqual(runWith(ADDED_IMPORT, { head: reading(body({ 1: MONEY })) }).seeds, ["total:lines"]);
});

test("a removed import reads the base side: the declarations that still write its name seed as a walk start, not as targets", () => {
  const removal = { after: 0, base: { start: 1, end: 1 } };
  const removed = change("src/Order.java", { removals: [removal], hunks: [hunk(undefined, { start: 1, end: 1 })] });
  const selected = runWith(removed, { base: reading(body({ 1: MONEY })), head: reading(body()) });
  assert.deepEqual(selected, { seeds: ["total:lines"], holders: ["total"] });
});

test("an import changed beside an edit in another method seeds the users of its name and the edited method", () => {
  const edited = change("src/Order.java", { added: [{ start: 1, end: 1 }, { start: 13, end: 13 }], hunks: [hunk({ start: 1, end: 1 }), hunk({ start: 13, end: 13 }, { start: 13, end: 13 })] });
  const tokens = { base: reading(body()), head: reading(body({ 1: MONEY, 13: "y;" })) };
  assert.deepEqual(runWith(edited, tokens).seeds, ["tax:lines", "total:lines"]);
});

const ALL_TOP_LEVEL = ["Order:top-level", "helper:top-level"];
const SYMBOLS = [...CLASS_WITH_METHODS, symbol("helper", "function", 40, 45)];
const named = (text: string, ...names: string[]): Line => ({ text, binds: names.map((name) => ({ name, source: `shop.${name}` })) });
const wide = (overrides: Record<number, string | Line>, count = 45): (string | Line)[] => Array.from({ length: count }, (_, index) => overrides[index + 1] ?? (index + 1 === 7 ? "Money m;" : FILLER));

const LATE_SYMBOLS = [symbol("Order", "class", 5, 30), symbol("total", "method", 6, 10), symbol("helper", "function", 40, 45)];

const FAIL_CLOSED: { name: string; file: FileChange; tokens: FileTokens; symbols?: TestSymbol[] }[] = [
  {
    name: "an import that binds no name a reading can list (a side-effect import, a wildcard, a re-export) beside one that binds a used name",
    file: change("src/Order.java", { added: [{ start: 1, end: 2 }], hunks: [hunk({ start: 1, end: 2 })] }),
    tokens: { base: reading(wide({})), head: reading(wide({ 1: "import shop.*;", 2: MONEY })) },
  },
  {
    name: "a name written by a statement outside every declaration",
    file: ADDED_IMPORT,
    tokens: { base: reading(wide({ 47: "register(Money);" }, 47)), head: reading(wide({ 1: MONEY, 47: "register(Money);" }, 47)) },
  },
  {
    name: "an import change that binds no name differently, or whose name no declaration writes",
    file: change("src/Order.java", { added: [{ start: 1, end: 1 }], hunks: [hunk({ start: 1, end: 1 }, { start: 1, end: 1 })] }),
    tokens: { base: reading(wide({ 1: MONEY })), head: reading(wide({ 1: { ...MONEY, text: "import  shop.Money ;" } })) },
  },
  {
    name: "a hunk that changes an import and a line that is no import",
    file: change("src/Order.java", { added: [{ start: 1, end: 2 }], hunks: [hunk({ start: 1, end: 2 })] }),
    tokens: { base: reading(wide({})), head: reading(wide({ 1: MONEY, 2: "package shop;" })) },
  },
  {
    name: "a removal between declarations that held no import, beside an import that binds a used name",
    file: change("src/Order.java", { added: [{ start: 1, end: 1 }], removals: [{ after: 35, base: { start: 36, end: 36 } }], hunks: [hunk({ start: 1, end: 1 }), hunk(undefined, { start: 36, end: 36 })] }),
    tokens: { base: reading(wide({})), head: reading(wide({ 1: MONEY, 36: "" })) },
  },
  {
    name: "a removed import whose base side the tokens stage did not read",
    file: change("src/Order.java", { removals: [{ after: 0, base: { start: 1, end: 1 } }], hunks: [hunk(undefined, { start: 1, end: 1 })] }),
    tokens: { head: reading(wide({})) },
  },
  {
    name: "imports whose order carries meaning moved relative to each other",
    symbols: LATE_SYMBOLS,
    file: change("src/Order.java", { added: [{ start: 1, end: 3 }], hunks: [hunk({ start: 1, end: 3 }, { start: 1, end: 2 })] }),
    tokens: {
      base: reading(wide({ 1: named("import a;", "A"), 2: named("import b;", "B") }), "significant"),
      head: reading(wide({ 1: named("import b;", "B"), 2: named("import a;", "A"), 3: MONEY }), "significant"),
    },
  },
];

for (const { name, file, tokens, symbols = SYMBOLS } of FAIL_CLOSED) {
  test(`${name} keeps the seeds of the file's top-level declarations`, () => {
    assert.deepEqual(runWith(file, tokens, symbols).seeds, ALL_TOP_LEVEL.toSorted());
  });
}
