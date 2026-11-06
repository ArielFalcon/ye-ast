/** A source file of a library repository, read on behalf of the repository that depends on it. */
export interface LibrarySource {
  repo: string;
  path: string;
  content: string;
}

export const LIBRARY_ROOT = "(library)";

/** Where a library file appears in evidence: under a root no repository path can have, then the library's repository. */
export function libraryPath(repo: string, path: string): string {
  return `${LIBRARY_ROOT}/${encodeURIComponent(repo)}/${path}`;
}
