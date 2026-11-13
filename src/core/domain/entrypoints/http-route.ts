import type { Finding } from "../shared/fact.ts";
import type { RouteParameterTypes } from "./route-parameter.ts";

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "ANY"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** The methods a request names; `ANY` is a route's, never a request's. */
export const REQUEST_METHODS = HTTP_METHODS.filter((method): method is Exclude<HttpMethod, "ANY"> => method !== "ANY");

/** The request method a name spells, in upper case as HTTP writes it; undefined for any other name. */
export function requestMethodOf(name: string): Exclude<HttpMethod, "ANY"> | undefined {
  return REQUEST_METHODS.find((method) => method === name);
}

/** The configuration keys that put a path before every route of an application; a key no document sets is absent. */
export interface BasePathKeys {
  /** `server.servlet.context-path` */
  contextPath?: string;
  /** `spring.mvc.servlet.path` */
  servletPath?: string;
  /** `spring.webflux.base-path` */
  webfluxBasePath?: string;
}

/**
 * What the configuration in the snapshot puts before a route: the keys of the documents without a profile condition,
 * and the keys each profile's documents set, by the profile expression they declare. No profile is picked, and a
 * deployment can still set any key outside the snapshot.
 */
export interface BasePath {
  default: BasePathKeys;
  profiles: Readonly<Record<string, BasePathKeys>>;
}

/** The method that serves an entrypoint, or the class when a class-level listener dispatches to its handler methods. */
export interface Handler {
  path: string;
  symbol: string;
  /** The declaration's first line. */
  line: number;
  /** The declaration's last line; absent when the declaration spans one line. */
  endLine?: number;
}

/** The name of a route, which a call names to reach it: `METHOD path`, with ` v<version>` when the mapping declares one. */
export function httpRouteName({ method, path, version }: Pick<HttpRoute, "method" | "path" | "version">): string {
  return `${method} ${path}${version === undefined ? "" : ` v${version}`}`;
}

/** The method, path and version a route name states; undefined for a name `httpRouteName` does not write. */
export function parseHttpRouteName(name: string): Pick<HttpRoute, "method" | "path" | "version"> | undefined {
  const [written, path, version, ...rest] = name.split(" ");
  const method = HTTP_METHODS.find((candidate) => candidate === written);
  if (method === undefined || path === undefined || rest.length > 0 || (version !== undefined && !/^v./.test(version))) return undefined;
  return { method, path, ...(version === undefined ? {} : { version: version.slice(1) }) };
}

/** `ANY` is a mapping that names no verb. A route is identified by its method, path, version and handler. */
export interface HttpRoute {
  kind: "http-route";
  /** `httpRouteName`; never the base path. */
  name: string;
  method: HttpMethod;
  /** The path the code maps; the base path is not part of it. */
  path: string;
  version?: string;
  handler: Handler;
  /** The parse-strict types the handler declares for the path variables; a variable of any other type, or of a framework that gives none, is absent. */
  parameterTypes?: RouteParameterTypes;
  basePath: Finding<BasePath>;
}
