import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaRootBindings } from "./java-root-bindings.ts";

const OWNER = { path: "src/main/java/app/owner/Owner.java", content: "package app.owner;\npublic class Owner {\n  public static void check(Owner owner) {}\n}\n" };
const RESOURCE = {
  path: "src/main/java/app/web/Resource.java",
  content: [
    "package app.web;",
    "import app.owner.Owner;",
    "import java.util.Optional;",
    "import java.util.*;",
    "import static app.owner.Owner.check;",
    "class Resource<T> {",
    "  private final Repo repository;",
    "  Optional<Owner> find(int id) {",
    "    Owner local = new Owner();",
    "    repository.findById(id);",
    "    List<T> all = new ArrayList<>();",
    "    check(local);",
    "    Missing.call();",
    "    return Optional.empty();",
    "  }",
    "}",
  ].join("\n"),
};

/** The method `find` of the resource, as the index places it. */
const FIND = { name: "find", line: 8, endLine: 15 };

/** The 1-based site of the `nth` spelling on a line of the resource, written by `find`'s body. */
function at(line: number, spelled: string, nth = 0) {
  const text = RESOURCE.content.split("\n")[line - 1]!;
  let column = -1;
  for (let found = 0; found <= nth; found++) column = text.indexOf(spelled, column + 1);
  return { file: RESOURCE.path, line, column: column + 1, spelled, owner: FIND };
}

const bindings = (sites: Parameters<ReturnType<typeof createJavaRootBindings>>[0]) => createJavaRootBindings(createJavaParser(), [OWNER, RESOURCE])(sites);

test("a type the sources declare, instantiated or statically imported, is located by its qualified containment path", async () => {
  assert.deepEqual(await bindings([{ ...at(9, "new Owner"), spelled: "Owner" }, at(12, "check")]), [
    { kind: "located", root: "Owner", file: OWNER.path, path: "app.owner.Owner" },
    { kind: "located", root: "check", file: OWNER.path, path: "app.owner.Owner.check" },
  ]);
});

test("a type a single import names under a platform package is external, named after the package", async () => {
  assert.deepEqual(await bindings([at(8, "Optional")]), [{ kind: "import", root: "Optional", origin: { kind: "external", module: "java.util" } }]);
});

test("a local the owner's syntax declares is local, and a field is a member of this", async () => {
  assert.deepEqual(await bindings([at(12, "local"), at(10, "repository")]), [
    { kind: "local", root: "local" },
    { kind: "this", member: "repository" },
  ]);
});

test("a type variable of a type around the owner is declared at the line of its name", async () => {
  assert.deepEqual(await bindings([at(11, "T")]), [{ kind: "declared", root: "T", lines: [6], captured: false }]);
});

test("a capitalised name no source declares and only a wildcard import could supply is unknown, since java.lang may supply it too", async () => {
  assert.deepEqual(await bindings([at(13, "Missing"), at(11, "ArrayList")]), [{ kind: "unknown" }, { kind: "unknown" }]);
});
