import { isAbsolute, join } from "node:path";

export interface UserEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  home: string;
}

export const PRODUCT_DIRECTORY = "ye-ast";

/**
 * ye-ast's per-user directory under an XDG Base Directory variable, or under `~/<fallback>` when the variable is unset,
 * empty or relative; `null` when there is no home either.
 */
export function xdgDirectory({ env, home }: UserEnvironment, variable: string, fallback: string): string | null {
  const xdg = env[variable];
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return join(xdg, PRODUCT_DIRECTORY);
  return home === "" ? null : join(home, fallback, PRODUCT_DIRECTORY);
}
