import { test } from "node:test";
import assert from "node:assert/strict";
import { createImportOrigins } from "./import-origins.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DeclaredSupertypes } from "../../ports/import-origins.port.ts";

const MANIFEST: SourceFile = { path: "package.json", content: JSON.stringify({ dependencies: { "lib-ui": "1.0.0" } }) };
const BASE: SourceFile = { path: "src/base.ts", content: ["@Sealed()", "export class Base<T> {}", "export interface Shape {}", "export const Alias = Base;", ""].join("\n") };
const file = (path: string, ...lines: string[]): SourceFile => ({ path, content: [...lines, ""].join("\n") });

async function supertypesOf(sources: readonly SourceFile[], path: string, line: number, name: string): Promise<DeclaredSupertypes> {
  const [answer] = await createImportOrigins([MANIFEST, BASE, ...sources]).declaredSupertypes!([{ file: path, line, name }]);
  assert.ok(answer !== undefined);
  return answer;
}

test("each heritage entry is answered in source order by its name without type arguments: a repository class or interface where it is placed, a library or package type outside", async () => {
  const widget = file(
    "src/widget.ts",
    'import { Base, Shape } from "./base";',
    'import { Component, OnInit } from "lib-ui";',
    "@Decorated()",
    "export class Widget",
    "  extends Base<string>",
    "  implements OnInit, Shape, Component<Props>, PromiseLike<number> {}",
  );

  assert.deepEqual(await supertypesOf([widget], widget.path, 3, "Widget"), {
    kind: "supertypes",
    supertypes: [
      { relation: "extends", written: "Base", kind: "placed", name: "Base", file: BASE.path, start: 1, nameLine: 2 },
      { relation: "implements", written: "OnInit", kind: "outside", qualifiedName: "lib-ui#OnInit" },
      { relation: "implements", written: "Shape", kind: "placed", name: "Shape", file: BASE.path, start: 3, nameLine: 3 },
      { relation: "implements", written: "Component", kind: "outside", qualifiedName: "lib-ui#Component" },
      { relation: "implements", written: "PromiseLike", kind: "outside", qualifiedName: "PromiseLike" },
    ],
  });
});

test("a name the file's own scopes declare binds there and not to a homonym the file imports or the libraries declare", async () => {
  const shadow = file(
    "src/shadow.ts",
    'import { Shape } from "./base";',
    "function scope(): void {",
    "  interface Shape {}",
    "  class Error {}",
    "  class Local extends Error implements Shape {}",
    "}",
  );

  assert.deepEqual(await supertypesOf([shadow], shadow.path, 5, "Local"), {
    kind: "supertypes",
    supertypes: [
      { relation: "extends", written: "Error", kind: "placed", name: "Error", file: shadow.path, start: 4, nameLine: 4 },
      { relation: "implements", written: "Shape", kind: "placed", name: "Shape", file: shadow.path, start: 3, nameLine: 3 },
    ],
  });
});

test("a namespace import or a constant reaches the declaration it names; a call, a class expression, a name nothing binds or a global the snapshot declares is unknown", async () => {
  const global = file("src/global.d.ts", "declare class Error {}");
  const forms = file(
    "src/forms.ts",
    'import * as base from "./base";',
    'import * as ui from "lib-ui";',
    'import { Alias } from "./base";',
    "declare function mixin<T>(value: T): T;",
    "class Spaced extends base.Base<string> {}",
    "class Packaged extends ui.Component<Props> {}",
    "class Aliased extends Alias {}",
    "class Mixed extends mixin(Object) {}",
    "class Expressed extends class {} {}",
    "class Unbound implements Missing<string> {}",
    "class Failure extends Error {}",
  );
  const sources = [global, forms];

  const entry = async (line: number, name: string) => {
    const answer = await supertypesOf(sources, forms.path, line, name);
    assert.ok(answer.kind === "supertypes", name);
    assert.equal(answer.supertypes.length, 1, name);
    return answer.supertypes[0];
  };
  assert.deepEqual(await entry(5, "Spaced"), { relation: "extends", written: "base.Base", kind: "placed", name: "Base", file: BASE.path, start: 1, nameLine: 2 });
  assert.deepEqual(await entry(6, "Packaged"), { relation: "extends", written: "ui.Component", kind: "outside", qualifiedName: "lib-ui#Component" });
  assert.deepEqual(await entry(7, "Aliased"), { relation: "extends", written: "Alias", kind: "placed", name: "Base", file: BASE.path, start: 1, nameLine: 2 });
  assert.deepEqual(await entry(8, "Mixed"), { relation: "extends", written: "mixin(Object)", kind: "unknown" });
  assert.deepEqual(await entry(9, "Expressed"), { relation: "extends", written: "class{}", kind: "unknown" });
  assert.deepEqual(await entry(10, "Unbound"), { relation: "implements", written: "Missing", kind: "unknown" });
  assert.deepEqual(await entry(11, "Failure"), { relation: "extends", written: "Error", kind: "unknown" });
});

test("an interface's extends clause is answered as extends; a site that places no declaration of its name, or several, is unknown", async () => {
  const types = file("src/types.ts", 'import { Shape } from "./base";', "export interface Round extends Shape {}", "export interface Flat {}", "class Twin implements Shape { make(): void { class Twin {} } }");

  assert.deepEqual(await supertypesOf([types], types.path, 2, "Round"), { kind: "supertypes", supertypes: [{ relation: "extends", written: "Shape", kind: "placed", name: "Shape", file: BASE.path, start: 3, nameLine: 3 }] });
  assert.deepEqual(await supertypesOf([types], types.path, 1, "Round"), { kind: "unknown" });
  assert.deepEqual(await supertypesOf([types], types.path, 3, "Round"), { kind: "unknown" });
  assert.deepEqual(await supertypesOf([types], "src/missing.ts", 1, "Round"), { kind: "unknown" });
  assert.deepEqual(await supertypesOf([types], types.path, 4, "Twin"), { kind: "unknown" });
});
