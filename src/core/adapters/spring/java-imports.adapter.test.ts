import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser, type JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaImportsReader } from "./java-imports.adapter.ts";

const OWNER = { path: "src/main/java/app/owner/Owner.java", content: "package app.owner;\npublic class Owner {\n  public static final int LIMIT = 1;\n}\n" };
const CLIENT = {
  path: "src/main/java/app/api/Client.java",
  content: [
    "package app.api;",
    "import app.owner.Owner;",
    "import static app.owner.Owner.LIMIT;",
    "import app.owner.*;",
    "import java.util.List;",
    "import com.acme.Missing;",
    "class Client {}",
  ].join("\n"),
};

test("each Java import leads to the file of the type the sources declare, a platform package, or an explicit unresolved", async () => {
  const read = await createJavaImportsReader(await createJavaParser()).extract([OWNER, CLIENT]);
  assert.deepEqual(read.dependencies.map(({ line, specifier, target, bindings }) => ({ line, specifier, target, bindings: bindings.map(({ local, imported, exportedAs }) => ({ local, imported, exportedAs })) })), [
    { line: 2, specifier: "app.owner.Owner", target: { kind: "repository", file: OWNER.path }, bindings: [{ local: "Owner", imported: "Owner", exportedAs: "app.owner.Owner" }] },
    { line: 3, specifier: "app.owner.Owner.LIMIT", target: { kind: "repository", file: OWNER.path }, bindings: [{ local: "LIMIT", imported: "LIMIT", exportedAs: "app.owner.Owner.LIMIT" }] },
    { line: 4, specifier: "app.owner.*", target: { kind: "unresolved", reason: "app.owner is a package of the repository, not one file" }, bindings: [{ local: undefined, imported: "*", exportedAs: undefined }] },
    { line: 5, specifier: "java.util.List", target: { kind: "external", module: "java.util" }, bindings: [{ local: "List", imported: "List", exportedAs: undefined }] },
    { line: 6, specifier: "com.acme.Missing", target: { kind: "unresolved", reason: "no source of the snapshot declares com.acme.Missing" }, bindings: [{ local: "Missing", imported: "Missing", exportedAs: undefined }] },
  ]);
});

test("a Java source the parser rejects is unread, never a file without imports", async () => {
  const read = await createJavaImportsReader(await createJavaParser()).extract([{ path: "src/Broken.java", content: "import a.b.C;\nclass {" }]);
  assert.deepEqual(read.unread, [{ file: "src/Broken.java", reason: "source-unreadable" }]);
  assert.deepEqual(read.dependencies, []);
});

test("a selection reads the imports of the selected Java files only, resolved by the types every source declares", async () => {
  const read = await createJavaImportsReader(await createJavaParser()).extract([OWNER, CLIENT], { files: [CLIENT.path] });
  assert.deepEqual(read.files.map(({ file }) => file), [CLIENT.path]);
  assert.deepEqual(read.dependencies[0]?.target, { kind: "repository", file: OWNER.path });
});

const BROKEN = { path: "src/main/java/app/Broken.java", content: "import a.b.C;\nclass {" };
const SCRIPT = { path: "src/main/webapp/app.ts", content: "export const app = 1;\n" };

function countingParser(parser: JavaParser): { parser: JavaParser; parsed: () => number } {
  let count = 0;
  return { parser: { parse: (source) => (count++, parser.parse(source)) }, parsed: () => count };
}

test("reads of one source list parse each Java source once, and another list parses its own", async () => {
  const counting = countingParser(await createJavaParser());
  const reader = createJavaImportsReader(counting.parser);
  const sources = [OWNER, CLIENT, BROKEN, SCRIPT];

  await reader.extract(sources, { files: [CLIENT.path] });
  await reader.extract(sources, { files: [OWNER.path] });
  assert.equal(counting.parsed(), 3);

  const edited = [OWNER, { ...CLIENT, content: CLIENT.content.replace("import java.util.List;\n", "") }];
  const read = await reader.extract(edited, { files: [CLIENT.path] });
  assert.equal(counting.parsed(), 5);
  assert.ok(!read.dependencies.some(({ specifier }) => specifier === "java.util.List"));
});

test("a selection over a list already read answers its files in list order, their imports, and every unread source", async () => {
  const reader = createJavaImportsReader(await createJavaParser());
  const sources = [OWNER, CLIENT, BROKEN, SCRIPT];
  await reader.extract(sources);
  const clientImports = ["app.owner.Owner", "app.owner.Owner.LIMIT", "app.owner.*", "java.util.List", "com.acme.Missing"];
  const unread = [{ file: BROKEN.path, reason: "source-unreadable" }];

  for (const [files, expected] of [
    [undefined, { files: [OWNER.path, CLIENT.path], specifiers: clientImports, unread }],
    [[CLIENT.path], { files: [CLIENT.path], specifiers: clientImports, unread }],
    [[CLIENT.path, OWNER.path], { files: [OWNER.path, CLIENT.path], specifiers: clientImports, unread }],
    [[OWNER.path], { files: [OWNER.path], specifiers: [], unread }],
    [[BROKEN.path], { files: [], specifiers: [], unread }],
    [[SCRIPT.path], { files: [], specifiers: [], unread: [] }],
  ] as const) {
    const read = await reader.extract(sources, files === undefined ? undefined : { files });
    assert.deepEqual({ files: read.files.map(({ file }) => file), specifiers: read.dependencies.map(({ specifier }) => specifier), unread: read.unread }, expected, JSON.stringify(files));
  }
});
