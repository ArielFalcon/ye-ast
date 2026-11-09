import { compareText } from "./code-node.ts";
import { ANYTHING, type Cut } from "./fact.ts";

/** The lockfiles npm reads for a directory, the first present one deciding, as npm does. */
export const LOCKFILE_NAMES = ["npm-shrinkwrap.json", "package-lock.json"] as const;


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
export function mountOf(output: Pick<DeclaredBuildOutput, "at">): string {
  return output.at === "" ? "node_modules" : `${output.at}/node_modules`;
}

/** Why a typed reading read none of its declared outputs. */
export type UnreadOutputReason = "live-tree" | "inputs-unreadable" | "version-mismatch" | "outputs-unreadable" | "checker-failed";

/**
 * What a typed reading states about the declared outputs (ADR-0042 decision 10): that it read none of them, why, and
 * the paths under each that say why (`named`, by `at`); or that it used them, with the links it refused to follow.
 */
export type BuildOutputEvidence =
  | { used: false; outputs: readonly Pick<DeclaredBuildOutput, "at">[]; reason: UnreadOutputReason; named?: ReadonlyMap<string, readonly string[]> }
  | { used: true; refused: readonly string[] };

/** The one builder of `build-output` cuts, for every family that reads the typed reading: none without evidence. */
export function buildOutputCuts(evidence: BuildOutputEvidence | undefined): Cut[] {
  if (evidence === undefined) return [];
  return evidence.used ? refusedLinkCuts(evidence.refused) : unreadOutputCuts(evidence.outputs, evidence.reason, evidence.named);
}

/**
 * The cuts of an answer that read none of `outputs` (ADR-0037 decision 9): every output named once, at the paths under
 * it that say why (`named`, by `at`: a stale package, a path that would not be read), or at its directory otherwise.
 */
function unreadOutputCuts(outputs: readonly Pick<DeclaredBuildOutput, "at">[], reason: UnreadOutputReason, named: ReadonlyMap<string, readonly string[]> = new Map()): Cut[] {
  return outputs.map((output) => {
    const paths = named.get(output.at) ?? [];
    return { kind: "build-output", at: paths.length === 0 ? [mountOf(output)] : paths.map((path) => (path === "" ? mountOf(output) : `${mountOf(output)}/${path}`)), reason, reach: ANYTHING };
  });
}

/** The cut of the linked paths a typed reading refused to follow out of its declared outputs; none when it refused none. */
function refusedLinkCuts(refused: readonly string[]): Cut[] {
  return refused.length === 0 ? [] : [{ kind: "build-output", at: refused, reason: "link-outside", reach: ANYTHING }];
}

/**
 * A `node_modules` declaration as a user writes it, `[<at>=]<path>`: the directory `<path>` stands for `<at>/node_modules`,
 * the root's without `<at>=`. A path holding `=` is written with an empty `<at>`: `=<path>`. Anything else is no declaration.
 */
export function nodeModulesDeclared(spec: string): DeclaredBuildOutput | undefined {
  const split = spec.indexOf("=");
  const at = split === -1 ? "" : spec.slice(0, split);
  const path = split === -1 ? spec : spec.slice(split + 1);
  return path === "" || !isRepositoryDirectory(at) ? undefined : { kind: "node-modules", at, path };
}

/** Whether `at` names a repository directory: relative, normalized, with no `.` or `..` segment; `""` is the root. */
export function isRepositoryDirectory(at: string): boolean {
  if (at === "") return true;
  return !at.startsWith("/") && !at.endsWith("/") && at.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

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

export type InstallVerdict = { usable: true; verified: boolean } | { usable: false; stale: readonly StaleInstall[] };

/**
 * Whether a declared directory matches the snapshot: every package read has, at its install path, the version the
 * lockfile states there. Without a readable lockfile (`locked` absent) the directory is usable and unverified (ADR-0037
 * decision 5).
 */
export function installVerdict(locked: ReadonlyMap<string, string> | undefined, installed: readonly InstalledPackage[]): InstallVerdict {
  if (locked === undefined) return { usable: true, verified: false };
  const stale = installed
    .filter(({ path, version }) => version === undefined || locked.get(path) !== version)
    .map(({ path, version }) => ({ path, ...(version === undefined ? {} : { installed: version }), ...(locked.has(path) ? { locked: locked.get(path)! } : {}) }))
    .toSorted((a, b) => compareText(a.path, b.path));
  return stale.length === 0 ? { usable: true, verified: true } : { usable: false, stale };
}
