import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { injectedToken } from "./angular-injection.ts";
import { readAngularRouteFile } from "./angular-router.extractor.ts";
import { sourceTree } from "./source-tree.ts";
import { declarationCounts } from "./syntax-names.ts";

test("an imported inject that a declaration of the file may shadow asks for no token", () => {
  const tree = sourceTree({ path: "src/page.ts", content: "import { inject } from '@angular/core';\nconst page = inject(Svc);\nfunction later(inject: unknown) {}\n" }, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  const call = (tree.statements[1] as ts.VariableStatement).declarationList.declarations[0]!.initializer!;
  const imports = readAngularRouteFile(tree)!.imports;

  assert.equal(injectedToken(call, { imports, declared: declarationCounts(tree) }), undefined);
  assert.ok(injectedToken(call, { imports, declared: new Map() }) !== undefined);
});
