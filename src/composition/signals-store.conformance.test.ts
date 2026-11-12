import assert from "node:assert/strict";
import test from "node:test";
import { createTypeScriptMemberNames } from "../core/adapters/typescript/declared-member-names.adapter.ts";
import { composeFrameworkPlugins } from "./framework-plugins.ts";
import { createDeclarationModel, AmbiguousDeclaration } from "../core/application/navigation/declaration-model.ts";
import { fakeCodeGraph, fakeNode } from "../core/application/navigation/fake-code-graph.testing.ts";

test("the registered store plugin supplies member bindings only with project and file proof", async () => {
  const file = { path: "src/store.ts", content: "import { signalStore as store, withMethods as methods } from '@ngrx/signals';\nexport const S = store(methods(() => ({\n m() { work(); }\n})));" };
  const manifest = { path: "package.json", content: JSON.stringify({ dependencies: { "@ngrx/signals": "1.0.0" } }) };
  const plugins = composeFrameworkPlugins();
  const syntax = await createTypeScriptMemberNames().memberNames(file);
  const bindings = (await Promise.all(plugins.map((plugin) => plugin.members?.([manifest, file]).bindings(file) ?? []))).flat();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.evidence.framework, "@ngrx/signals");
  const store = fakeCodeGraph([fakeNode("S", "constant", file.path, 2, 8)], []);
  const model = createDeclarationModel({ store, declarationsIn: async () => syntax.declarations, bindingsIn: async () => bindings });
  assert.equal((await model.select(file.path, "S.m"))[0]?.path, "S.m");
  for (const sources of [[file], [{ ...manifest, content: "{}" }, file]]) {
    assert.deepEqual((await Promise.all(plugins.map((plugin) => plugin.members?.(sources).bindings(file) ?? []))).flat(), []);
  }
  const foreign = { ...file, content: file.content.replace("@ngrx/signals", "foreign") };
  assert.deepEqual((await Promise.all(plugins.map((plugin) => plugin.members?.([manifest, foreign]).bindings(foreign) ?? []))).flat(), []);
  const spread = { ...file, content: file.content.replace("m() { work(); }", "m() { work(); }, ...replacement") };
  assert.deepEqual((await Promise.all(plugins.map((plugin) => plugin.members?.([manifest, spread]).bindings(spread) ?? []))).flat(), []);
  const duplicate = createDeclarationModel({ store, declarationsIn: async () => [...syntax.declarations, { ...syntax.declarations.find(({ name }) => name === "m")!, span: { start: { line: 5, column: 1 }, end: { line: 5, column: 15 } } }], bindingsIn: async () => [...bindings, { ...bindings[0]!, member: { line: 5, column: 1 } }] });
  await assert.rejects(duplicate.select(file.path, "S.m"), AmbiguousDeclaration);
  const conflicting = createDeclarationModel({ store: fakeCodeGraph([fakeNode("S", "constant", file.path, 2, 8), fakeNode("Other", "constant", file.path, 1, 9)], []), declarationsIn: async () => syntax.declarations, bindingsIn: async () => [...bindings, { ...bindings[0]!, holder: { path: file.path, symbol: "Other", line: 1 }, evidence: { framework: "other", file: file.path, line: 1 } }] });
  const uncertain = (await conflicting.list(file.path)).find(({ name }) => name === "m")!;
  assert.equal(uncertain.path, undefined);
  assert.equal(uncertain.bindingConflict, true);
  assert.equal(uncertain.bindingEvidence?.length, 2);
});

test("a reactive method factory contributes only a deferred member from its own runtime import", async () => {
  const file = { path: "src/store.ts", content: "import { signalStore, withMethods } from '@ngrx/signals';\nimport { rxMethod } from '@ngrx/signals/rxjs-interop';\nconst S = signalStore(withMethods(() => ({ load: rxMethod(pipe(map(() => send()))) })));" };
  const manifest = { path: "package.json", content: JSON.stringify({ dependencies: { "@ngrx/signals": "1.0.0" } }) };
  const stages = composeFrameworkPlugins().flatMap((plugin) => plugin.members === undefined ? [] : [plugin.members([manifest, file])]);
  const found = (await Promise.all(stages.map((stage) => stage.bindings(file)))).flat();
  assert.equal(found[0]?.declaration?.name, "load");
  assert.equal(found[0]?.deferredFactory, true);
  const foreign = { ...file, content: file.content.replace("@ngrx/signals/rxjs-interop", "foreign") };
  assert.deepEqual((await Promise.all(stages.map((stage) => stage.bindings(foreign)))).flat(), []);
});
