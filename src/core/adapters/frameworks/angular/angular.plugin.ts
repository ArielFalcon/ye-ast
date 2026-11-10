import type { EntrypointExtractor } from "../../../ports/entrypoint-extractor.port.ts";
import type { FrameworkPlugin } from "../../../ports/framework-plugin.port.ts";
import type { ImportedName, RouterVocabulary } from "../../../ports/router-vocabulary.port.ts";

const ROUTER_PACKAGE = "@angular/router";
const ROUTER_MODULE = "RouterModule";
const CONFIGURATIONS: ReadonlyMap<string, "root" | "child"> = new Map([
  ["provideRouter", "root"],
  ["RouterModule.forRoot", "root"],
  ["RouterModule.forChild", "child"],
]);

/** The export of the router a name reaches, then the members written after it; none for a name the router does not bind. */
function routerPathOf({ binding, members }: ImportedName): readonly string[] | undefined {
  if (binding?.module !== ROUTER_PACKAGE) return undefined;
  return binding.imported === "*" ? members : [binding.imported, ...members];
}

const ANGULAR_ROUTER: RouterVocabulary = {
  signal: { dependency: ROUTER_PACKAGE, module: ROUTER_PACKAGE },
  configurationOf: (callee) => CONFIGURATIONS.get(routerPathOf(callee)?.join(".") ?? ""),
  isRouterModule: (name) => routerPathOf(name)?.[0] === ROUTER_MODULE,
};

/** The readers of the TypeScript pack the plugin wraps, each built over the vocabulary the plugin hands it. */
export interface AngularReaders {
  routes(router: RouterVocabulary): EntrypointExtractor;
}

/** Angular over the TypeScript pack: its route tables are its entrypoints, read in the projects that depend on its router. */
export function createAngularPlugin(readers: AngularReaders): FrameworkPlugin {
  return { languages: ["typescript"], signal: ANGULAR_ROUTER.signal, entrypoints: readers.routes(ANGULAR_ROUTER) };
}
