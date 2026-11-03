import type { Finding } from "../shared/fact.ts";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "TRACE" | "ANY";

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

/** `ANY` is a mapping that names no verb. A route is identified by its method, path, version and handler. */
export interface HttpRoute {
  kind: "http-route";
  /** `METHOD path`, with ` v<version>` when the mapping declares a version; never the base path. */
  name: string;
  method: HttpMethod;
  /** The path the code maps; the base path is not part of it. */
  path: string;
  version?: string;
  handler: Handler;
  basePath: Finding<BasePath>;
}
