import { join } from "node:path";
import { PRODUCT_DIRECTORY, xdgDirectory, type UserEnvironment } from "./user-environment.ts";

/**
 * The per-user directory for ye-ast's kept indexes, or `null` when the environment names no place for it. The XDG
 * Base Directory rule applies: a relative or empty `XDG_CACHE_HOME` is ignored.
 */
export function indexCacheDirectory(environment: UserEnvironment): string | null {
  if (environment.platform === "win32") return environment.env.LOCALAPPDATA ? join(environment.env.LOCALAPPDATA, PRODUCT_DIRECTORY) : null;
  return xdgDirectory(environment, "XDG_CACHE_HOME", ".cache");
}
