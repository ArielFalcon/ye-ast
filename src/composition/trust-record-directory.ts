import { join } from "node:path";
import { PRODUCT_DIRECTORY, xdgDirectory, type UserEnvironment } from "./user-environment.ts";

/**
 * The per-user directory for the trust record (RFC-0006 open question 3), or `null` when the environment names no
 * place for it. The XDG Base Directory rule applies: a relative or empty `XDG_CONFIG_HOME` is ignored.
 */
export function trustRecordDirectory(environment: UserEnvironment): string | null {
  if (environment.platform === "win32") return environment.env.APPDATA ? join(environment.env.APPDATA, PRODUCT_DIRECTORY) : null;
  return xdgDirectory(environment, "XDG_CONFIG_HOME", ".config");
}
