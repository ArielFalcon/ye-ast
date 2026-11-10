import type { ImportedName, RouterVocabulary } from "../../ports/router-vocabulary.port.ts";

/** The router names the readers' own fixtures write, as the Angular plugin reads them; the plugin's conformance fixtures run the real vocabulary. */
const PACKAGE = "@angular/router";

function pathOf({ binding, members }: ImportedName): string | undefined {
  if (binding?.module !== PACKAGE) return undefined;
  return (binding.imported === "*" ? members : [binding.imported, ...members]).join(".");
}

const CONFIGURATIONS: ReadonlyMap<string, "root" | "child"> = new Map([["provideRouter", "root"], ["RouterModule.forRoot", "root"], ["RouterModule.forChild", "child"]]);

/** The double of the router vocabulary port for the TypeScript route readers' tests, which cannot reach the plugin that owns it. */
export const ROUTER_VOCABULARY_DOUBLE: RouterVocabulary = {
  signal: { dependency: PACKAGE, module: PACKAGE },
  configurationOf: (callee) => CONFIGURATIONS.get(pathOf(callee) ?? ""),
  isRouterModule: (name) => pathOf(name)?.split(".")[0] === "RouterModule",
};
