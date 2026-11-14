import assert from "node:assert/strict";
import { test } from "node:test";
import type { Token, SourceReading } from "../../domain/change/source-tokens.ts";
import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { fakeCodeGraph, fakeNode } from "./fake-code-graph.testing.ts";
import { createWrittenUses } from "./written-uses.ts";

const SOURCES: readonly SourceFile[] = [
  { path: "src/a.ts", content: "export const X = 1;\n" },
  { path: "src/b.ts", content: 'export * from "./a";\nexport const load = () => import("./a";\n' },
  { path: "src/c.ts", content: 'import * as b from "./b";\n\nexport function use(): number {\n  return b.X;\n}\n' },
];

function tokensOf(file: SourceFile): Promise<SourceReading> {
  const tokens: Token[] = [];
  let line = 1;
  for (const match of file.content.matchAll(/[A-Za-z_$][\w$]*|\n|\S/g)) {
    tokens.push({ start: line, end: line, text: match[0], startOffset: match.index, endOffset: match.index + match[0].length });
    if (match[0] === "\n") line++;
  }
  const imports = [...file.content.matchAll(/^import .*$/gm)].map(({ index, 0: text }) => ({ start: index, end: index + text.length }));
  return Promise.resolve({ status: "read", language: "typescript", tokens, imports, importOrder: "insignificant" });
}

function unsettledWith(unread: ModuleDependencies["unread"], barrel = "src/b.ts") {
  const store = fakeCodeGraph([fakeNode("x", "constant", "src/a.ts", 1, 1, "X"), fakeNode("use", "function", "src/c.ts", 3, 5, "use")], []);
  const modules: Pick<ModuleDependencies, "dependencies" | "unread"> = {
    dependencies: [{ file: "src/c.ts", line: 1, endLine: 1, specifier: "./b", kind: "import", typeOnly: false, target: { kind: "repository", file: barrel }, bindings: [{ local: "b", imported: "*", line: 1, column: 13, typeOnly: false }] }],
    unread,
  };
  const written = createWrittenUses({ store, sources: SOURCES, tokensOf, origins: { rootBindings: async (sites) => sites.map(() => ({ kind: "unknown" as const })) }, importedDeclarations: async () => new Map(), modules: async () => modules });
  return written.into(store.symbolsInFiles(["src/a.ts"])).then(({ unsettled }) => unsettled.map(({ file, line, name }) => `${file}:${line} ${name}`));
}

test("a TypeScript source whose module statements are not read and whose reader states no bound joins every chain; one with a bound joins only the chains of the modules it reaches", async () => {
  assert.deepEqual(await unsettledWith([{ file: "src/b.ts", reason: "source-unreadable" }]), ["src/c.ts:4 b"]);
  assert.deepEqual(await unsettledWith([{ file: "src/b.ts", reason: "source-unreadable", reaches: ["src/other.ts"] }]), []);
});

test("a source whose module statements are read, or one of another language, joins no chain without a bound", async () => {
  assert.deepEqual(await unsettledWith([{ file: "src/b.ts", reason: "no-extractor" }]), []);
  assert.deepEqual(await unsettledWith([{ file: "src/B.java", reason: "source-unreadable" }], "src/B.java"), []);
});

test("a module re-exporting from a source whose statements are not read, also one the chain reached before, passes the unread link to each name a file imports from it", async () => {
  const sources: readonly SourceFile[] = [
    SOURCES[0]!,
    SOURCES[1]!,
    { path: "src/outer.ts", content: 'export * from "./b";\n' },
    { path: "src/relay.ts", content: 'import { X } from "./a";\nexport * from "./b";\nexport { X } +;\n' },
    { path: "src/r.ts", content: 'import { Alias } from "./outer";\nimport { Y } from "./relay";\n\nexport const r = Alias + Y;\n' },
  ];
  const store = fakeCodeGraph([fakeNode("x", "constant", "src/a.ts", 1, 1, "X")], []);
  const statement = (file: string, kind: "import" | "reexport", target: string, bindings: ModuleDependencies["dependencies"][number]["bindings"]) => ({ file, line: 1, endLine: 1, specifier: target, kind, typeOnly: false, target: { kind: "repository" as const, file: target }, bindings });
  const modules: Pick<ModuleDependencies, "dependencies" | "unread"> = {
    dependencies: [
      statement("src/outer.ts", "reexport", "src/b.ts", [{ imported: "*", line: 1, column: 1, typeOnly: false }]),
      statement("src/relay.ts", "import", "src/a.ts", [{ local: "X", imported: "X", line: 1, column: 10, typeOnly: false }]),
      statement("src/relay.ts", "reexport", "src/b.ts", [{ imported: "*", line: 2, column: 1, typeOnly: false }]),
      statement("src/r.ts", "import", "src/outer.ts", [{ local: "Alias", imported: "Alias", line: 1, column: 10, typeOnly: false }]),
      statement("src/r.ts", "import", "src/relay.ts", [{ local: "Y", imported: "Y", line: 2, column: 10, typeOnly: false }]),
    ],
    unread: [{ file: "src/b.ts", reason: "source-unreadable", reaches: ["src/a.ts"] }],
  };
  const tokens = (file: SourceFile): Promise<SourceReading> => (file.path === "src/relay.ts" ? Promise.resolve({ status: "unread", reason: "unparsed" }) : tokensOf(file));
  const written = createWrittenUses({ store, sources, tokensOf: tokens, origins: { rootBindings: async (sites) => sites.map(() => ({ kind: "unknown" as const })) }, importedDeclarations: async () => new Map(), modules: async () => modules });

  const { unsettled } = await written.into(store.symbolsInFiles(["src/a.ts"]));

  assert.deepEqual(unsettled.map(({ file, line, name }) => `${file}:${line} ${name}`), ["src/r.ts:4 Alias", "src/r.ts:4 Y"]);
});
