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
