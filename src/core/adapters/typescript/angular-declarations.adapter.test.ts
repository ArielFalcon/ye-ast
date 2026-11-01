import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createAngularDeclarationReader } from "./angular-declarations.adapter.ts";

const ANGULAR = { path: "package.json", content: '{"dependencies":{"@angular/core":"21.0.0"}}' };

const PAGE = `import { Component, Injectable } from "@angular/core";

@Component({
  selector: "app-page",
  templateUrl: "./page.component.html",
  styleUrls: ["./page.component.css", "../shared/base.scss"],
})
export class PageComponent {}

@Component({ selector: "app-card", templateUrl: "card.html", styleUrl: "./card.css" })
export class CardComponent {}

@Injectable({ providedIn: "root" })
export class OrdersService {}

const TEMPLATE = "./dynamic.html";
@Component({ selector: "app-dyn", templateUrl: TEMPLATE })
export class DynamicComponent {}

export class Plain {}
`;

function read(files: SourceFile[]) {
  return createAngularDeclarationReader().read(files);
}

test("reads each decorated class with the resources its decorator names as literals, resolved to repository paths", async () => {
  const declarations = await read([ANGULAR, { path: "src/app/page.component.ts", content: PAGE }]);
  assert.deepEqual(
    declarations.map(({ name, line, decorator, resources }) => [name, line, decorator, resources]),
    [
      ["PageComponent", 8, "Component", ["src/app/page.component.html", "src/app/page.component.css", "src/shared/base.scss"]],
      ["CardComponent", 11, "Component", ["src/app/card.html", "src/app/card.css"]],
      ["OrdersService", 14, "Injectable", []],
      ["DynamicComponent", 18, "Component", []],
    ],
  );
});

test("a repository whose manifest does not name @angular/core has no declarations", async () => {
  const declarations = await read([{ path: "package.json", content: '{"dependencies":{"react":"19.0.0"}}' }, { path: "src/page.component.ts", content: PAGE }]);
  assert.deepEqual(declarations, []);
});

test("a resource that leaves the repository is not reported", async () => {
  const content = `import { Component } from "@angular/core";
@Component({ templateUrl: "../../../outside.html" })
export class EscapeComponent {}
`;
  const declarations = await read([ANGULAR, { path: "a/b.component.ts", content }]);
  assert.deepEqual(declarations.map((declaration) => declaration.resources), [[]]);
});

test("a decorator of a file that does not import from @angular/core is not Angular's", async () => {
  const content = `import { Component } from "./my-framework";
@Component({ templateUrl: "./x.html" })
export class NotAngular {}
`;
  assert.deepEqual(await read([ANGULAR, { path: "src/x.ts", content }]), []);
});

test("an app under a subfolder has its declarations read, and a source outside every project has none", async () => {
  const declarations = await read([
    { path: "frontend/package.json", content: ANGULAR.content },
    { path: "frontend/src/page.ts", content: PAGE },
    { path: "other/page.ts", content: PAGE },
  ]);
  assert.deepEqual([...new Set(declarations.map((declaration) => declaration.file))], ["frontend/src/page.ts"]);
  assert.deepEqual(declarations[0]?.resources, ["frontend/src/page.component.html", "frontend/src/page.component.css", "frontend/shared/base.scss"]);
});
