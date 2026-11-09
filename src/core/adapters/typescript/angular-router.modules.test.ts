import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import * as routes from "./angular-routes.adapter.ts";
import { parseAngularRouteFile } from "./angular-router.extractor.ts";
import { readAngularMetadataFile, type RawAngularFile, type RawOperand } from "./angular-metadata.extractor.ts";

/** An empty Angular metadata reading of a file: every field typed, with the classes and arrays the test sets. */
function angularFile(classes: RawAngularFile["classes"], arrays: RawAngularFile["arrays"] = new Map()): RawAngularFile {
  const empty = readAngularMetadataFile(ts.createSourceFile("app.ts", "", ts.ScriptTarget.Latest, true), { imports: new Map() });
  return { ...empty, classes, arrays };
}

test("the class a bootstrapModule call boots is read, and bootstrapModuleFactory is not", () => {
  const raw = parseAngularRouteFile(
    "src/main.ts",
    "import { AppModule } from './app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\nplatformBrowserDynamic().bootstrapModuleFactory(factory);",
  );

  assert.deepEqual(raw?.bootstraps, [{ className: "AppModule", module: "./app.module", imported: "AppModule", line: 2, endLine: 2 }]);
});

test("the module composition is projected from the Angular metadata reading, never re-read", () => {
  const imports: RawOperand[] = [
    { reference: { name: "OwnersRoutingModule" }, line: 4 },
    { unreadable: true, line: 5 },
  ];
  const projected = routes.modulesOf(
    angularFile([
      { kind: "module", name: "OwnersModule", line: 3, imports, declarations: [], exports: [], hostDirectives: [] },
      { kind: "component", name: "OwnerList", line: 9, imports: [], declarations: [], exports: [], hostDirectives: [] },
    ]),
  );

  assert.deepEqual(projected, { modules: [{ name: "OwnersModule", line: 3, imports }], arrays: new Map() });
});

test("a spread in imports projects the identifier the owner answered, and the arrays verbatim", () => {
  const shared: RawOperand[] = [{ reference: { name: "OwnersRoutingModule" }, line: 9 }];
  const projected = routes.modulesOf(
    angularFile(
      [{ kind: "module", name: "AppModule", line: 1, imports: [{ reference: { name: "SHARED" }, line: 2 }], declarations: [], exports: [], hostDirectives: [] }],
      new Map([["SHARED", shared]]),
    ),
  );

  assert.deepEqual(projected.modules[0]?.imports, [{ reference: { name: "SHARED" }, line: 2 }]);
  assert.deepEqual(projected.arrays, new Map([["SHARED", shared]]));
});
