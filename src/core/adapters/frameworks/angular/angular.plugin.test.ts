import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImportedName, RouterVocabulary } from "../../../ports/router-vocabulary.port.ts";
import { createAngularPlugin } from "./angular.plugin.ts";

/** The vocabulary the plugin hands the route reader it wraps. */
function router(): RouterVocabulary {
  let handed: RouterVocabulary | undefined;
  createAngularPlugin({
    routes: (vocabulary) => {
      handed = vocabulary;
      return { extract: async () => ({ findings: [], readingCuts: [] }) };
    },
  });
  return handed!;
}

const ROUTER = router();
const named = (imported: string, ...members: string[]): ImportedName => ({ binding: { module: ROUTER.signal.module, imported }, members });
const namespaced = (...members: string[]): ImportedName => named("*", ...members);

test("each router configuration call is read through a named import and through a namespace import", () => {
  const callees = [named("provideRouter"), namespaced("provideRouter"), named("RouterModule", "forRoot"), namespaced("RouterModule", "forRoot"), named("RouterModule", "forChild"), namespaced("RouterModule", "forChild"), named("RouterModule", "forChild", "call")];

  assert.deepEqual(callees.map((callee) => ROUTER.configurationOf(callee)), ["root", "root", "root", "root", "child", "child", undefined]);
});

test("the router's module is named through either import, whatever member follows it", () => {
  const names = [named("RouterModule"), named("RouterModule", "forChild"), namespaced("RouterModule"), namespaced(), named("Router")];

  assert.deepEqual(names.map((name) => ROUTER.isRouterModule(name)), [true, true, true, false, false]);
});

test("a name another module binds, or no import binds, is never a router name", () => {
  const foreign: ImportedName = { binding: { module: "./router", imported: "RouterModule" }, members: ["forRoot"] };
  const unbound: ImportedName = { members: ["provideRouter"] };

  assert.deepEqual([ROUTER.configurationOf(foreign), ROUTER.configurationOf(unbound), ROUTER.isRouterModule(foreign)], [undefined, undefined, false]);
});
