import type { FrameworkPlugin } from "../../../ports/framework-plugin.port.ts";
import type { FrameworkDeferrals } from "../../../ports/framework-deferrals.port.ts";

const RXJS_PACKAGE = "rxjs";
const OPERATORS_MODULE = "rxjs/operators";
const FIRST_ARGUMENT = { argument: 0 } as const;
const FUNCTION_TAKERS = new Set(["defer", "switchMap", "mergeMap", "concatMap", "exhaustMap"]);

/** The RxJS combinators that run the function they are given when something subscribes, if anything does. */
export const RXJS_DEFERRALS: FrameworkDeferrals = {
  runOf: ({ module, path }) => ((module === RXJS_PACKAGE || module === OPERATORS_MODULE) && path.length === 1 && FUNCTION_TAKERS.has(path[0]!) ? FIRST_ARGUMENT : undefined),
};

/** RxJS over the TypeScript pack: its deferring combinators own the requests their function values make. */
export function createRxjsPlugin(): FrameworkPlugin {
  return { languages: ["typescript"], signal: { dependency: RXJS_PACKAGE, module: RXJS_PACKAGE }, deferrals: RXJS_DEFERRALS };
}
