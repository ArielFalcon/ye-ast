import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
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
