import type { Handler } from "./http-route.ts";

/** A guard the route entry declares in `canMatch`, `canActivate`, `canActivateChild` or `canLoad`. */
export interface RouteGuard {
  /** The name of the declaration, or `(inline)` for a function written in place. */
  name: string;
  /** The file that declares it; absent for an inline guard, an installed package's and one the sources do not place. */
  path?: string;
  /** The guard comes from an installed package. */
  external?: true;
}

/**
 * A route entry of a UI router that shows a component, named `/<path>` after the path the code declares from the root
 * table, parent paths joined (`/orders/:id`, `/**`), with ` (<outlet>)` for a named outlet; never the `<base href>`.
 * A redirect is not an entrypoint, and a parent without a component only adds its path to its children.
 */
export interface UiRoute {
  kind: "ui-route";
  name: string;
  /** The full path from the root table, with a leading `/`. */
  path: string;
  outlet?: string;
  /** The class the entry shows, or `unknown` when the sources do not name one declaration. */
  component: Handler | "unknown";
  /** The guards of the entry itself; those of its ancestors are not added. */
  guards: readonly RouteGuard[];
}
