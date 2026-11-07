import { posix } from "node:path";
import { packageOf } from "./module-resolver.ts";

/** The lockfiles npm reads for a directory, the first present one deciding, as npm does. */
export const LOCKFILE_NAMES = ["npm-shrinkwrap.json", "package-lock.json"] as const;

/**
 * The version an npm lockfile (versions 2 and 3) states at each install path under `node_modules`: `@scope/name`, or
 * `a/node_modules/b` for a nested one. A text that is not such a lockfile states nothing (`undefined`).
 */
export function lockedVersions(text: string | undefined): ReadonlyMap<string, string> | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { lockfileVersion, packages } = parsed as { lockfileVersion?: unknown; packages?: unknown };
  if (typeof lockfileVersion !== "number" || lockfileVersion < 2 || packages === null || typeof packages !== "object") return undefined;
  const locked = new Map<string, string>();
  for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
    if (!key.startsWith("node_modules/") || entry === null || typeof entry !== "object") continue;
    const { version } = entry as { version?: unknown };
    if (typeof version === "string") locked.set(key.slice("node_modules/".length), version);
  }
  return locked;
}

/** The install path of the package a path under a `node_modules` directory belongs to, nested ones included. */
export function installPathOf(path: string): string | undefined {
  const nested = path.lastIndexOf("/node_modules/");
  const prefix = nested === -1 ? "" : path.slice(0, nested + "/node_modules/".length);
  const inside = path.slice(prefix.length);
  const name = packageOf(inside);
  if (name === undefined || name.startsWith(".") || !inside.startsWith(`${name}/`) || (name.startsWith("@") && !name.includes("/"))) return undefined;
  return posix.join(prefix, name);
}
