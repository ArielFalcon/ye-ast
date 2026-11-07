import { compareText } from "./code-node.ts";

/**
 * A directory a host's own install produced, declared outside the repository (ADR-0037). `path` is a `node_modules`
 * directory on the host; it stands for `<at>/node_modules` in the snapshot, `at` being repository-relative.
 */
export interface DeclaredBuildOutput {
  kind: "node-modules";
  at: string;
  path: string;
}

/** Where a declared `node_modules` directory stands in the snapshot. */
export function mountOf(output: DeclaredBuildOutput): string {
  return output.at === "" ? "node_modules" : `${output.at}/node_modules`;
}

/** Whether `at` names a repository directory: relative, normalized, with no `.` or `..` segment; `""` is the root. */
export function isRepositoryDirectory(at: string): boolean {
  if (at === "") return true;
  return !at.startsWith("/") && !at.endsWith("/") && at.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

/**
 * What a snapshot without a readable lockfile gets from a declaration (ADR-0037 decision 5): `use-unverified` uses it and
 * records it unverified, `unused` leaves it unused and names the missing lockfile. The owner's decision; one switch.
 */
export type WithoutLockfile = "use-unverified" | "unused";
export const WITHOUT_LOCKFILE: WithoutLockfile = "use-unverified";

/** A package the derivation read, at its install path under the declared directory (`@scope/name`, `a/node_modules/b`). */
export interface InstalledPackage {
  path: string;
  version: string | undefined;
}

/** A package whose installed version the lockfile does not state at its install path; `locked` is absent when it lists none. */
export interface StaleInstall {
  path: string;
  installed?: string;
  locked?: string;
}

export type InstallVerdict =
  | { usable: true; verified: boolean }
  | { usable: false; reason: "stale"; stale: readonly StaleInstall[] }
  | { usable: false; reason: "no-lockfile" };

/**
 * Whether a declared directory matches the snapshot: every package read has, at its install path, the version the
 * lockfile states there. `locked` is absent when the snapshot has no readable lockfile for the directory.
 */
export function installVerdict(locked: ReadonlyMap<string, string> | undefined, installed: readonly InstalledPackage[], withoutLockfile: WithoutLockfile = WITHOUT_LOCKFILE): InstallVerdict {
  if (locked === undefined) return withoutLockfile === "use-unverified" ? { usable: true, verified: false } : { usable: false, reason: "no-lockfile" };
  const stale = installed
    .filter(({ path, version }) => version === undefined || locked.get(path) !== version)
    .map(({ path, version }) => ({ path, ...(version === undefined ? {} : { installed: version }), ...(locked.has(path) ? { locked: locked.get(path)! } : {}) }))
    .toSorted((a, b) => compareText(a.path, b.path));
  return stale.length === 0 ? { usable: true, verified: true } : { usable: false, reason: "stale", stale };
}
